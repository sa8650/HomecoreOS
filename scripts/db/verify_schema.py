#!/usr/bin/env python3
"""
HomecoreOS schema verification.

Runs supabase/reset.sql and supabase/schema.sql against a real PostgreSQL
instance and exercises the behaviour the application depends on.

Usage:
    python3 scripts/db/verify_schema.py --dsn "host=/tmp port=5433 user=postgres dbname=postgres"
"""

import argparse
import hashlib
import json
import sys

try:
    import psycopg2
except ImportError:  # pragma: no cover - the dependency is reported, not hidden
    sys.stderr.write(
        "verify_schema.py needs psycopg2:\n"
        "    pip install psycopg2-binary\n"
    )
    raise SystemExit(2)

OK = "\033[32mPASS\033[0m"
FAIL = "\033[31mFAIL\033[0m"

results = []


def check(name, fn):
    try:
        fn()
        results.append((name, True, ""))
        print(f"[{OK}] {name}")
    except Exception as e:  # noqa: BLE001 - a test harness reports every failure
        msg = str(e).strip().split("\n")[0]
        results.append((name, False, msg))
        print(f"[{FAIL}] {name}\n        {msg}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dsn", required=True)
    ap.add_argument("--schema", default="supabase/schema.sql")
    ap.add_argument("--reset", default="supabase/reset.sql")
    ap.add_argument(
        "--allow-destructive",
        action="store_true",
        help="run even when the target database already holds accounts",
    )
    args = ap.parse_args()

    conn = psycopg2.connect(args.dsn)
    conn.autocommit = True
    cur = conn.cursor()

    # This script rebuilds the schema and registers test accounts, so it
    # destroys whatever is in the database. It must not be pointed at a
    # database that holds real accounts.
    if not args.allow_destructive:
        cur.execute(
            "select count(*) from information_schema.tables "
            "where table_schema = 'public' and table_name = 'app_users'"
        )
        if cur.fetchone()[0]:
            cur.execute("select count(*) from public.app_users")
            accounts = cur.fetchone()[0]
            if accounts:
                sys.stderr.write(
                    "verify_schema.py rebuilds the schema and would remove "
                    f"{accounts} account(s) in this database.\n"
                    "Point it at a scratch database, or pass --allow-destructive "
                    "if that is what you want.\n"
                )
                raise SystemExit(2)

    state = {}

    def run(path):
        with open(path) as fh:
            cur.execute(fh.read())

    def scalar(sql, params=None):
        cur.execute(sql, params)
        row = cur.fetchone()
        return row[0] if row else None

    def j(obj):
        return json.dumps(obj)

    # ---------------------------------------------------------------- install
    print("\n--- installation ---")
    run(args.reset)
    print(f"[{OK}] reset.sql executes")
    run(args.schema)
    print(f"[{OK}] schema.sql executes")
    run(args.schema)
    print(f"[{OK}] schema.sql is idempotent")
    run(args.reset)
    run(args.schema)
    print(f"[{OK}] reset.sql -> schema.sql round trip")

    # ------------------------------------------------------- flash offsets
    print("\n--- firmware flash offset contract ---")

    def offset_column():
        v = scalar(
            """select is_nullable from information_schema.columns
               where table_schema='public' and table_name='firmware_releases'
                 and column_name='flash_offset'"""
        )
        assert v == "NO", f"flash_offset must be NOT NULL, got {v}"

    check("flash_offset is NOT NULL", offset_column)

    def offset_null_rejected():
        try:
            cur.execute(
                """insert into public.firmware_releases
                   (name,version,channel,board_models,artifact_kind,flash_offset,r2_key,size_bytes,sha256)
                   values ('t','1.0.0','stable',array['x'],'app',NULL,'k',1,repeat('a',64))"""
            )
        except Exception:
            return
        raise AssertionError("a NULL flash_offset was accepted")

    check("NULL flash_offset is rejected", offset_null_rejected)

    def offset_mismatch_rejected():
        try:
            cur.execute(
                """insert into public.firmware_releases
                   (name,version,channel,board_models,artifact_kind,flash_offset,r2_key,size_bytes,sha256)
                   values ('t','1.0.0','stable',array['x'],'factory',65536,'k',1,repeat('a',64))"""
            )
        except Exception:
            return
        raise AssertionError("factory artifact with app offset was accepted")

    check("flash_offset must match artifact_kind", offset_mismatch_rejected)

    def offset_ok():
        cur.execute(
            """insert into public.firmware_releases
               (name,version,channel,board_models,artifact_kind,flash_offset,r2_key,size_bytes,sha256,ota_eligible)
               values ('app','1.0.0','stable',
                       array['espressif.esp32-s3-devkitc-1.n16r8','espressif.esp32-s3-devkitc-1.v1.1'],
                       'app',65536,'k',1,repeat('a',64),true),
                      ('fac','1.0.0','stable',
                       array['espressif.esp32-s3-devkitc-1.n16r8','espressif.esp32-s3-devkitc-1.v1.1'],
                       'factory',0,'k2',1,repeat('b',64),false)"""
        )
        cur.execute(
            "select artifact_kind, flash_offset, ota_eligible from public.firmware_releases order by artifact_kind"
        )
        rows = {r[0]: (r[1], r[2]) for r in cur.fetchall()}
        assert rows["app"] == (65536, True), rows
        assert rows["factory"] == (0, False), rows

    check("app=65536 / factory=0 are accepted", offset_ok)

    def no_signature_columns():
        cur.execute(
            """select column_name from information_schema.columns
               where table_schema='public' and table_name='firmware_releases'
                 and (column_name like '%signature%' or column_name like '%signed%'
                      or column_name like '%public_key%')"""
        )
        rows = cur.fetchall()
        assert not rows, f"firmware signing columns still present: {rows}"

    check("firmware_releases has no signing columns", no_signature_columns)

    # ------------------------------------------------------ authentication
    print("\n--- authentication ---")

    def first_owner():
        cur.execute("delete from public.app_users")
        cur.execute(
            "select public.rpc_auth_register(%s,%s,%s::jsonb)",
            (
                "owner@example.com",
                "CorrectHorseBattery9!",
                j({"full_name": "Owner", "home_name": "Owner Home"}),
            ),
        )
        r = cur.fetchone()[0]
        assert r["role"] == "platform_owner", r
        cur.execute(
            "select public.rpc_auth_register(%s,%s,%s::jsonb)",
            ("cust@example.com", "CorrectHorseBattery9!", j({"full_name": "Cust"})),
        )
        r2 = cur.fetchone()[0]
        assert r2["role"] == "customer", r2
        state["OWNER"] = r
        state["CUSTOMER"] = r2

    check("first signup is Platform Owner, later signups are customers", first_owner)

    def password_roundtrip():
        h = scalar("select public.rpc_auth_hash_secret('CorrectHorseBattery9!')")
        assert h and h.startswith("$2"), h
        assert scalar("select public.rpc_auth_verify_secret('CorrectHorseBattery9!', %s)", (h,)) is True
        assert scalar("select public.rpc_auth_verify_secret('nope', %s)", (h,)) is False

    check("password hash and verify work", password_roundtrip)

    def duplicate_email():
        try:
            cur.execute(
                "select public.rpc_auth_register(%s,%s)",
                ("owner@example.com", "CorrectHorseBattery9!"),
            )
        except Exception:
            return
        raise AssertionError("a duplicate email was accepted")

    check("duplicate email is rejected", duplicate_email)

    def session_flow():
        tok = hashlib.sha256(b"tok").hexdigest()
        cur.execute(
            "select public.rpc_auth_session_create(%s,%s,%s,%s)",
            (state["OWNER"]["user_id"], tok, "1.2.3.4", "ua"),
        )
        cur.execute("select public.rpc_auth_session_resolve(%s)", (tok,))
        s = cur.fetchone()[0]
        assert s is not None, "session did not resolve"
        assert s["email"] == "owner@example.com", s
        assert s["platform_admin"] is True, s
        state["TOKEN"] = tok

    check("session create and resolve work", session_flow)

    def bad_token():
        assert scalar("select public.rpc_auth_session_resolve(%s)", ("deadbeef",)) is None

    check("an unknown session token resolves to nothing", bad_token)

    def context():
        cur.execute("select public.rpc_context(%s)", (state["OWNER"]["user_id"],))
        c = cur.fetchone()[0]
        assert c["tenant"]["name"] == "Owner Home", c
        assert c["role"] == "owner", c
        assert len(c["permissions"]) > 0, c

    check("owner context returns the home and its permissions", context)

    def throttle():
        cur.execute("select public.rpc_auth_guard(%s,%s,%s,%s)", ("victim@example.com", "9.9.9.9", "record", "login"))
        state_ = scalar("select public.rpc_auth_guard(%s,%s,%s,%s)", ("victim@example.com", "9.9.9.9", "check", "login"))
        assert "allowed" in state_, state_
        cur.execute("select public.rpc_auth_guard_reset_for(%s)", ("victim@example.com",))
        state_ = scalar("select public.rpc_auth_guard(%s,%s,%s,%s)", ("victim@example.com", "9.9.9.9", "check", "login"))
        assert state_.get("allowed") is True, state_

    check("login guard records and clears failures", throttle)

    def recovery_codes():
        code = hashlib.sha256(b"recovery").hexdigest()
        cur.execute(
            "select public.rpc_auth_recovery_codes_set(%s,%s::jsonb)",
            (state["CUSTOMER"]["user_id"], j([code])),
        )
        r = cur.fetchone()[0]
        assert r["count"] == 1, r
        new_hash = scalar("select public.rpc_auth_hash_secret('BrandNewPassword9!')")
        cur.execute(
            "select public.rpc_auth_recovery_redeem(%s,%s,%s)",
            ("cust@example.com", code, new_hash),
        )
        assert cur.fetchone()[0]["ok"] is True
        assert scalar("select public.rpc_auth_verify_secret('BrandNewPassword9!', %s)", (new_hash,)) is True

    check("a recovery code resets the password", recovery_codes)

    # ------------------------------------------------------------ firmware
    print("\n--- firmware ---")

    def publish_requires_admin():
        try:
            cur.execute(
                "select public.rpc_firmware_set_status(%s,%s,%s)",
                (
                    state["CUSTOMER"]["user_id"],
                    "00000000-0000-0000-0000-000000000000",
                    "published",
                ),
            )
        except Exception:
            return
        raise AssertionError("a customer published a firmware release")

    check("only a platform admin may publish a release", publish_requires_admin)

    def publish_ok():
        cur.execute("select id from public.firmware_releases where artifact_kind='app' limit 1")
        rid = cur.fetchone()[0]
        cur.execute(
            "select public.rpc_firmware_set_status(%s,%s,%s)",
            (state["OWNER"]["user_id"], rid, "published"),
        )
        st = cur.fetchone()[0]
        assert st["ok"] is True, st
        cur.execute("select status, published_at from public.firmware_releases where id=%s", (rid,))
        row = cur.fetchone()
        assert row[0] == "published", row
        assert row[1] is not None, row
        state["RELEASE"] = rid

    check("a platform admin can publish a verified release", publish_ok)

    def firmware_latest():
        cur.execute(
            """insert into public.user_boards
               (tenant_id, catalog_board_id, name, device_id, mqtt_client_id, status, firmware_version)
               values ((select id from public.tenants order by created_at limit 1),
                       'espressif.esp32-s3-devkitc-1.n16r8',
                       'Test controller','dev-test-1','client-test-1','online','0.9.0')"""
        )
        bid = scalar("select id from public.user_boards where device_id='dev-test-1'")
        state["BOARD"] = bid
        cur.execute("select public.rpc_firmware_latest(%s)", (bid,))
        r = cur.fetchone()[0]
        assert r is not None, "no firmware offered to a compatible controller"
        assert r["update_available"] is True, r
        assert len(r["sha256"]) == 64, r

    check("a compatible controller is offered the published release", firmware_latest)

    def rollback_target():
        cur.execute(
            "select public.rpc_firmware_rollback_target(%s,%s,%s)",
            (state["BOARD"], state["OWNER"]["user_id"], state["OWNER"]["tenant_id"]),
        )
        # No earlier release exists yet, so None is the correct answer.
        assert cur.fetchone()[0] is None

    check("rollback target is None when no earlier release exists", rollback_target)

    def retire():
        cur.execute(
            "select public.rpc_firmware_retire(%s,%s,%s)",
            (state["RELEASE"], state["OWNER"]["user_id"], "test"),
        )
        r = cur.fetchone()[0]
        assert r["retired"] is True, r
        cur.execute("select status, archived_at from public.firmware_releases where id=%s", (state["RELEASE"],))
        row = cur.fetchone()
        assert row[0] == "archived", row
        assert row[1] is not None, row
        # An archived release is no longer offered to controllers.
        cur.execute("select public.rpc_firmware_latest(%s)", (state["BOARD"],))
        assert cur.fetchone()[0] is None, "an archived release was still offered"

    check("a release can be retired and stops being OTA eligible", retire)

    def ota_report():
        cur.execute(
            "select public.rpc_ota_report(%s,%s::jsonb)",
            (state["BOARD"], j({"status": "success", "version": "1.0.0", "progress": 100})),
        )
        r = cur.fetchone()[0]
        assert r["ok"] is True, r
        cur.execute("select firmware_version from public.user_boards where id=%s", (state["BOARD"],))
        assert cur.fetchone()[0] == "1.0.0"

    check("an OTA success report updates the controller version", ota_report)

    # -------------------------------------------------------------- devices
    print("\n--- devices, rooms and pins ---")

    def create_room():
        cur.execute(
            "select public.rpc_create_room(%s,%s,%s::jsonb)",
            (
                state["OWNER"]["user_id"],
                state["OWNER"]["tenant_id"],
                j({"name": "Kitchen", "icon": "home"}),
            ),
        )
        r = cur.fetchone()[0]
        assert r["id"], r
        state["ROOM"] = r["id"]

    check("a room can be created", create_room)

    def pins_seeded():
        n = scalar("select count(*) from public.board_pins where user_board_id=%s", (state["BOARD"],))
        assert n > 0, "the catalog pin map was not copied onto the controller"

    check("claiming a controller copies the catalog pin map", pins_seeded)

    def create_device():
        cur.execute(
            "select public.rpc_create_device(%s,%s,%s::jsonb)",
            (
                state["OWNER"]["user_id"],
                state["OWNER"]["tenant_id"],
                j(
                    {
                        "user_board_id": str(state["BOARD"]),
                        "room_id": str(state["ROOM"]),
                        "name": "Pump",
                        "device_type": "water_pump",
                        "output_gpio": 4,
                        "interface": "gpio",
                    }
                ),
            ),
        )
        r = cur.fetchone()[0]
        assert r["id"], r
        state["DEVICE"] = r["id"]

    check("a device can be created and allocates its GPIO", create_device)

    def double_alloc_rejected():
        try:
            cur.execute(
                "select public.rpc_create_device(%s,%s,%s::jsonb)",
                (
                    state["OWNER"]["user_id"],
                    state["OWNER"]["tenant_id"],
                    j(
                        {
                            "user_board_id": str(state["BOARD"]),
                            "name": "Second",
                            "device_type": "relay",
                            "output_gpio": 4,
                        }
                    ),
                ),
            )
        except Exception:
            return
        raise AssertionError("the same GPIO was allocated twice")

    check("a GPIO cannot be allocated twice", double_alloc_rejected)

    def restricted_pin_rejected():
        # GPIO0 is the boot strapping pin on the DevKitC header map.
        try:
            cur.execute(
                "select public.rpc_create_device(%s,%s,%s::jsonb)",
                (
                    state["OWNER"]["user_id"],
                    state["OWNER"]["tenant_id"],
                    j(
                        {
                            "user_board_id": str(state["BOARD"]),
                            "name": "Strap",
                            "device_type": "relay",
                            "output_gpio": 0,
                        }
                    ),
                ),
            )
        except Exception:
            return
        raise AssertionError("a boot strapping GPIO was accepted as an output")

    check("a strapping GPIO is refused as an output", restricted_pin_rejected)

    def delete_device_frees_pin():
        cur.execute(
            "select public.rpc_delete_device(%s,%s,%s)",
            (state["OWNER"]["user_id"], state["OWNER"]["tenant_id"], state["DEVICE"]),
        )
        assert cur.fetchone()[0]["deleted"] is True
        n = scalar(
            "select count(*) from public.exclusive_allocations where gpio=4 and user_board_id=%s",
            (state["BOARD"],),
        )
        assert n == 0, "the allocation was not released"
        cur.execute("select state from public.board_pins where user_board_id=%s and gpio=4", (state["BOARD"],))
        assert cur.fetchone()[0] == "available", "the pin was not returned to the pool"

    check("deleting a device releases its GPIO", delete_device_frees_pin)

    def board_config():
        cfg = scalar("select public.build_board_config(%s)", (state["BOARD"],))
        assert cfg["schema_version"] == 1, cfg
        assert "devices" in cfg and "sensors" in cfg and "buses" in cfg, cfg
        assert cfg["safety"]["pump_dry_run_local"] is True, cfg

    check("the board configuration document is built", board_config)

    # -------------------------------------------------------------- pairing
    print("\n--- pairing ---")

    def pairing():
        cur.execute(
            "select public.rpc_pairing_issue(%s,%s,%s,%s,%s,%s::jsonb)",
            (
                state["OWNER"]["user_id"],
                state["OWNER"]["tenant_id"],
                hashlib.sha256(b"code-1").hexdigest(),
                "session-1",
                "10.0.0.1",
                j(
                    {
                        "catalog_board_id": "espressif.esp32-s3-devkitc-1.n16r8",
                        "board_name": "New controller",
                    }
                ),
            ),
        )
        r = cur.fetchone()[0]
        assert r["id"], r
        state["PAIRING"] = r["id"]

    check("a pairing code can be issued", pairing)

    def pairing_redeem():
        cur.execute(
            "select public.rpc_pairing_redeem(%s,%s,%s,%s,%s,%s,%s::jsonb,%s)",
            (
                hashlib.sha256(b"code-1").hexdigest(),
                "New controller",
                "dev-paired-1",
                "client-paired-1",
                "user-paired-1",
                "hash",
                j({}),
                "10.0.0.2",
            ),
        )
        r = cur.fetchone()[0]
        assert r["board_id"], r
        state["REDEEM"] = r
        cur.execute(
            "select consumed_at is not null, revoked_at is null from public.device_pairing_tokens where id=%s",
            (state["PAIRING"],),
        )
        row = cur.fetchone()
        assert row[0] is True, "the pairing token was not consumed"
        assert row[1] is True, "the pairing token was revoked"

    check("a pairing code redeems into a controller", pairing_redeem)

    def pairing_reuse_rejected():
        try:
            cur.execute(
                "select public.rpc_pairing_redeem(%s,%s,%s,%s,%s,%s,%s::jsonb,%s)",
                (
                    hashlib.sha256(b"code-1").hexdigest(),
                    "New controller",
                    "dev-paired-2",
                    "client-paired-2",
                    "user-paired-2",
                    "hash",
                    j({}),
                    "10.0.0.3",
                ),
            )
        except Exception:
            return
        raise AssertionError("a pairing code was redeemed twice")

    check("a pairing code cannot be redeemed twice", pairing_reuse_rejected)

    def pairing_wrong_code():
        try:
            cur.execute(
                "select public.rpc_pairing_redeem(%s,%s,%s,%s,%s,%s,%s::jsonb,%s)",
                (
                    hashlib.sha256(b"not-a-code").hexdigest(),
                    "x",
                    "dev-x",
                    "client-x",
                    "user-x",
                    "hash",
                    j({}),
                    "10.0.0.4",
                ),
            )
        except Exception:
            return
        raise AssertionError("an unknown pairing code was accepted")

    check("an unknown pairing code is refused", pairing_wrong_code)

    # ------------------------------------------------- registration report
    print("\n--- registration ---")

    def registration_confirm():
        r = state["REDEEM"]
        cur.execute(
            "select public.rpc_confirm_registration(%s,%s,%s::jsonb)",
            (r["board_id"], state["PAIRING"], j({"firmware_version": "3.1.4"})),
        )
        out = cur.fetchone()[0]
        assert out["registered"] is True and out["first_time"] is True, out
        cur.execute("select status from public.user_boards where id=%s", (r["board_id"],))
        assert cur.fetchone()[0] == "online", "the controller was not marked online"

    check("a valid registration report confirms the controller", registration_confirm)

    def registration_duplicate():
        r = state["REDEEM"]
        cur.execute("select count(*) from public.audit_logs where action='device.registered' and entity_id=%s",
                    (str(r["board_id"]),))
        before = cur.fetchone()[0]
        cur.execute(
            "select public.rpc_confirm_registration(%s,%s,%s::jsonb)",
            (r["board_id"], state["PAIRING"], j({"firmware_version": "3.1.4"})),
        )
        out = cur.fetchone()[0]
        assert out["first_time"] is False, "a repeated report was counted as a new registration"
        cur.execute("select count(*) from public.audit_logs where action='device.registered' and entity_id=%s",
                    (str(r["board_id"]),))
        assert cur.fetchone()[0] == before, "a repeated report wrote a second registration audit entry"

    check("a repeated registration report is idempotent", registration_duplicate)

    def registration_wrong_session():
        r = state["REDEEM"]
        other = "00000000-0000-4000-8000-000000000001"
        try:
            cur.execute("select public.rpc_confirm_registration(%s,%s,%s::jsonb)",
                        (r["board_id"], other, j({})))
        except Exception:
            conn.rollback()
            return
        raise AssertionError("a report for a session this controller does not own was accepted")

    check("a report for another session is refused", registration_wrong_session)

    def progress_completed():
        cur.execute("select public.rpc_pairing_progress(%s,%s,%s)",
                    (state["OWNER"]["user_id"], state["OWNER"]["tenant_id"], state["PAIRING"]))
        out = cur.fetchone()[0]
        assert out["stage"] == "completed", f"stage is {out['stage']}, expected completed"
        assert out["expired"] is False, "a completed pairing is reported as expired"

    check("pairing progress reaches completed only after the registration", progress_completed)

    # ------------------------------------------- disconnect and re-pair
    print("\n--- disconnect and re-pair ---")

    def disconnect_needs_confirmation():
        r = state["REDEEM"]
        try:
            cur.execute("select public.rpc_unregister_board(%s,%s,%s,%s)",
                        (state["OWNER"]["user_id"], state["OWNER"]["tenant_id"], r["board_id"], "wrong"))
        except Exception:
            return
        raise AssertionError("a disconnect was accepted without the controller ID")

    check("disconnect requires the controller ID to be typed", disconnect_needs_confirmation)

    def disconnect_revokes():
        r = state["REDEEM"]
        cur.execute("select public.rpc_unregister_board(%s,%s,%s,%s)",
                    (state["OWNER"]["user_id"], state["OWNER"]["tenant_id"], r["board_id"], r["device_id"]))
        out = cur.fetchone()[0]
        assert out["status"] == "unclaimed" and out["credentials_revoked"] == 1, out
        cur.execute("select count(*) from public.mqtt_credentials_metadata where user_board_id=%s and status='active'",
                    (r["board_id"],))
        assert cur.fetchone()[0] == 0, "the old MQTT identity is still active"
        cur.execute("select public.rpc_board_from_client(%s)", ("client-paired-1",))
        assert cur.fetchone()[0] is None, "a disconnected controller still resolves to an identity"

    check("disconnect revokes the old MQTT identity", disconnect_revokes)

    def repair_same_record():
        r = state["REDEEM"]
        code = hashlib.sha256(b"code-repair").hexdigest()
        cur.execute("select public.rpc_pairing_issue(%s,%s,%s,%s,%s,%s::jsonb)",
                    (state["OWNER"]["user_id"], state["OWNER"]["tenant_id"], code, "session-repair", "10.0.0.5",
                     j({"user_board_id": str(r["board_id"]), "ttl_seconds": 300})))
        session = cur.fetchone()[0]["id"]
        cur.execute("select public.rpc_pairing_redeem(%s,%s,%s,%s,%s,%s,%s::jsonb,%s)",
                    (code, "x", r["device_id"], "client-repaired-1", "user-repaired-1", "hash2", j({}), "10.0.0.6"))
        out = cur.fetchone()[0]
        assert out["board_id"] == str(r["board_id"]) and out["repaired"] is True, out
        cur.execute("select count(*) from public.user_boards where device_id=%s", (r["device_id"],))
        assert cur.fetchone()[0] == 1, "re-pairing created a duplicate controller"
        cur.execute("select count(*) from public.mqtt_credentials_metadata where user_board_id=%s and status='active'",
                    (r["board_id"],))
        assert cur.fetchone()[0] == 1, "re-pairing did not issue exactly one active identity"
        cur.execute("select public.rpc_board_from_client(%s)", ("client-repaired-1",))
        assert cur.fetchone()[0] is not None, "the new identity does not resolve"
        state["REPAIR_SESSION"] = session

    check("a re-pair code restores the same controller record with a new identity", repair_same_record)

    def repair_other_device_refused():
        code = hashlib.sha256(b"code-repair-2").hexdigest()
        r = state["REDEEM"]
        cur.execute("select public.rpc_unregister_board(%s,%s,%s,%s)",
                    (state["OWNER"]["user_id"], state["OWNER"]["tenant_id"], r["board_id"], r["device_id"]))
        cur.execute("select public.rpc_pairing_issue(%s,%s,%s,%s,%s,%s::jsonb)",
                    (state["OWNER"]["user_id"], state["OWNER"]["tenant_id"], code, "session-repair-2", "10.0.0.7",
                     j({"user_board_id": str(r["board_id"]), "ttl_seconds": 300})))
        try:
            cur.execute("select public.rpc_pairing_redeem(%s,%s,%s,%s,%s,%s,%s::jsonb,%s)",
                        (code, "x", "hcd-someone-else", "client-other", "user-other", "hash3", j({}), "10.0.0.8"))
        except Exception:
            return
        raise AssertionError("a re-pair code was accepted by a different controller")


    def board_ack_failed_keeps_claim():
        r = state["REDEEM"]
        cur.execute("insert into device_commands (tenant_id,user_board_id,component_type,action,payload,status,expires_at)"
                    " values ((select tenant_id from user_boards where id=%s),%s,'board','factory_reset','{}','published',now()+interval '1 minute')"
                    " returning id", (r["board_id"], r["board_id"]))
        cmd = cur.fetchone()[0]
        cur.execute("select public.rpc_ack_board_command(%s,%s::jsonb)",
                    (r["board_id"], j({"command_id": str(cmd), "status": "failed", "error": "flash erase failed"})))
        out = cur.fetchone()[0]
        assert out["matched"] and out["status"] == "failed" and out["released"] is False, out
        cur.execute("select status from user_boards where id=%s", (r["board_id"],))
        assert cur.fetchone()[0] != "unclaimed", "a failed reset released the controller"

    check("a failed board-command ack keeps the controller claimed", board_ack_failed_keeps_claim)

    def confirmed_factory_reset_releases():
        r = state["REDEEM"]
        cur.execute("insert into device_commands (tenant_id,user_board_id,component_type,action,payload,status,expires_at)"
                    " values ((select tenant_id from user_boards where id=%s),%s,'board','factory_reset','{}','published',now()+interval '1 minute')"
                    " returning id", (r["board_id"], r["board_id"]))
        cmd = cur.fetchone()[0]
        cur.execute("select public.rpc_ack_board_command(%s,%s::jsonb)",
                    (r["board_id"], j({"command_id": str(cmd), "status": "confirmed"})))
        out = cur.fetchone()[0]
        assert out["released"] is True, out
        cur.execute("select status from user_boards where id=%s", (r["board_id"],))
        assert cur.fetchone()[0] == "unclaimed", "a confirmed factory reset did not release the controller"
        cur.execute("select count(*) from mqtt_credentials_metadata where user_board_id=%s and status='active'", (r["board_id"],))
        assert cur.fetchone()[0] == 0, "credentials survived a confirmed factory reset"
        cur.execute("select public.rpc_ack_board_command(%s,%s::jsonb)",
                    (r["board_id"], j({"command_id": str(cmd), "status": "confirmed"})))
        assert cur.fetchone()[0]["matched"] is False, "a replayed ack was accepted"

    check("a confirmed factory-reset ack releases the controller once", confirmed_factory_reset_releases)
    check("a re-pair code cannot be used by a different controller", repair_other_device_refused)

    # ---------------------------------------------------------- telemetry
    print("\n--- telemetry ---")

    def telemetry():
        cur.execute(
            "select public.rpc_ingest_telemetry(%s,%s::jsonb)",
            (
                state["BOARD"],
                j(
                    {
                        "schema_version": 1,
                        "timestamp": 1700000000,
                        "config_version": 1,
                        "sensors": {"nonexistent": {"value": 1, "unit": "celsius"}},
                    }
                ),
            ),
        )
        r = cur.fetchone()[0]
        assert r["accepted"] == 0, r
        assert r["rejected"], r

    check("telemetry for an unknown sensor is rejected", telemetry)

    def ingest_state():
        cur.execute(
            "select public.rpc_ingest_state(%s,%s::jsonb)",
            (state["BOARD"], j({"availability": "online", "devices": {}})),
        )
        assert cur.fetchone()[0]["ok"] is True

    check("a state report is accepted", ingest_state)

    # ---------------------------------------------------------------- RLS
    print("\n--- row level security ---")

    def rls_enabled():
        cur.execute(
            """select count(*) from pg_tables
               where schemaname='public' and tablename in
                 ('app_users','app_sessions','profiles','tenants','user_boards',
                  'devices','sensors','firmware_releases','device_pairing_tokens',
                  'mqtt_credentials_metadata','audit_logs','platform_settings')
                 and rowsecurity"""
        )
        n = cur.fetchone()[0]
        assert n == 12, f"RLS is not enabled on every application table ({n}/12)"

    check("RLS is enabled on every application table", rls_enabled)

    def no_orphan_policies():
        cur.execute("select schemaname, tablename from pg_policies where schemaname='public'")
        rows = cur.fetchall()
        assert rows, "no policies were created"
        cur.execute(
            """select c.relname from pg_class c join pg_namespace n on n.oid=c.relnamespace
               where n.nspname='public' and c.relkind='r'"""
        )
        tables = {r[0] for r in cur.fetchall()}
        for _s, t in rows:
            assert t in tables, f"a policy refers to the missing table {t}"

    check("no policy refers to a table that does not exist", no_orphan_policies)

    def anon_no_customer_data():
        cur.execute("grant usage on schema public to anon")
        cur.execute("set role anon")
        try:
            for t in ("app_users", "app_sessions", "mqtt_credentials_metadata",
                      "device_pairing_tokens", "platform_settings"):
                try:
                    cur.execute(f"select count(*) from public.{t}")
                    n = cur.fetchone()[0]
                except Exception:
                    continue  # a permission error is the correct outcome
                assert n == 0, f"anon could read {t}"
        finally:
            cur.execute("reset role")

    check("the anon role cannot read customer or secret data", anon_no_customer_data)

    def service_role_bypasses():
        cur.execute("grant all on all tables in schema public to service_role")
        cur.execute("grant all on all sequences in schema public to service_role")
        cur.execute("grant service_role to postgres")
        cur.execute("set role service_role")
        try:
            cur.execute("select count(*) from public.app_users")
            assert cur.fetchone()[0] > 0, "the service role could not read app_users"
        finally:
            cur.execute("reset role")

    check("the service role bypasses RLS", service_role_bypasses)

    def table_privileges():
        # The browser roles must not be able to write customer data directly.
        cur.execute("set role anon")
        try:
            cur.execute("insert into public.tenants (name, slug, owner_profile_id) values ('x','x-slug',gen_random_uuid())")
        except Exception:
            pass
        else:
            cur.execute("reset role")
            raise AssertionError("the anon role could insert a tenant")
        finally:
            cur.execute("reset role")

    check("the anon role cannot write to a tenant table", table_privileges)

    # ------------------------------------------------------------- summary
    passed = sum(1 for _, ok, _ in results if ok)
    failed = [(n, m) for n, ok, m in results if not ok]
    print(f"\n{'=' * 62}")
    print(f"  {passed} passed, {len(failed)} failed")
    if failed:
        print("\nFailures:")
        for n, m in failed:
            print(f"  - {n}: {m}")
    print("=" * 62)
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
