#include <assert.h>
#include <stdio.h>
#include <string.h>

#include "../main/board_log.h"

/**
 * Host regression tests for the bounded receiver-side fact ring.
 *
 * The ring is the only place where the firmware records what it actually
 * received, acknowledged or executed. It must stay bounded (no unbounded RAM
 * growth), it must never write to flash and it must serialize into a compact
 * JSON array that the Worker can parse.
 */

static int count_occurrences(const char *haystack, const char *needle) {
    int count = 0;
    if (!haystack || !needle) return 0;
    size_t len = strlen(needle);
    if (len == 0) return 0;
    const char *cursor = haystack;
    while ((cursor = strstr(cursor, needle)) != NULL) {
        count += 1;
        cursor += len;
    }
    return count;
}

/** A well formed batch has as many opening as closing braces. */
static bool json_is_balanced(const char *json) {
    if (!json || json[0] != '[') return false;
    size_t len = strlen(json);
    if (len < 2 || json[len - 1] != ']') return false;
    int open = 0;
    int close = 0;
    for (size_t i = 0; i < len; ++i) {
        if (json[i] == '{') open += 1;
        if (json[i] == '}') close += 1;
    }
    return open == close && open > 0;
}

int main(void) {
    /* ---------------------------------------------------------------- */
    /* An empty ring produces no payload at all.                       */
    /* ---------------------------------------------------------------- */
    hc_board_log_init(4242);
    assert(hc_board_log_session_id() == 4242);
    assert(hc_board_log_pending() == 0);
    assert(hc_board_log_has_pending() == false);

    char json[HC_BOARD_LOG_JSON_MAX];
    uint8_t written_count = 0xFF;
    size_t written = hc_board_log_write_json(json, sizeof(json), &written_count);
    assert(written == 0);
    assert(written_count == 0);
    assert(json[0] == '\0');

    /* ---------------------------------------------------------------- */
    /* A recorded fact shows up with its kind, status, method and target. */
    /* ---------------------------------------------------------------- */
    hc_board_log_record(
        HC_BOARD_LOG_KIND_COMMAND,
        HC_BOARD_LOG_STATUS_RECEIVED,
        HC_BOARD_LOG_METHOD_MQTT,
        "switch-1",
        "switch",
        "cmd-abc"
    );
    assert(hc_board_log_pending() == 1);
    assert(hc_board_log_has_pending() == true);

    written = hc_board_log_write_json(json, sizeof(json), &written_count);
    assert(written > 0);
    assert(written_count == 1);
    assert(json_is_balanced(json));
    assert(json[0] == '[');
    assert(json[written - 1] == ']');
    assert(strstr(json, "\"k\":\"cmd\"") != NULL);
    assert(strstr(json, "\"s\":\"received\"") != NULL);
    assert(strstr(json, "\"m\":\"mqtt\"") != NULL);
    assert(strstr(json, "\"t\":\"switch-1\"") != NULL);
    assert(strstr(json, "\"c\":\"cmd-abc\"") != NULL);
    assert(strstr(json, "\"ts\":") != NULL);

    /* The facts stay pending until the report actually succeeded, so a failed
     * heartbeat retries instead of losing the fact. */
    assert(hc_board_log_pending() == 1);

    /* Only the facts that were really sent are dropped. */
    hc_board_log_commit_sent(written_count);
    assert(hc_board_log_pending() == 0);
    written = hc_board_log_write_json(json, sizeof(json), &written_count);
    assert(written == 0);
    assert(written_count == 0);

    hc_board_log_clear();
    assert(hc_board_log_pending() == 0);
    written = hc_board_log_write_json(json, sizeof(json), &written_count);
    assert(written == 0);

    /* ---------------------------------------------------------------- */
    /* The ring is bounded: the oldest fact is dropped once it is full.  */
    /* ---------------------------------------------------------------- */
    hc_board_log_init(7);
    for (int i = 0; i < HC_BOARD_LOG_RING_SIZE + 4; i++) {
        char target[16];
        snprintf(target, sizeof(target), "t-%d", i);
        hc_board_log_record(
            HC_BOARD_LOG_KIND_COMM,
            HC_BOARD_LOG_STATUS_SENT,
            HC_BOARD_LOG_METHOD_ESPNOW,
            target,
            NULL,
            NULL
        );
    }
    assert(hc_board_log_pending() == HC_BOARD_LOG_RING_SIZE);

    written = hc_board_log_write_json(json, sizeof(json), &written_count);
    assert(written > 0);
    assert(written_count == HC_BOARD_LOG_RING_SIZE);
    assert(json_is_balanced(json));
    /* Exactly the ring size facts are serialized, and the oldest ones are
     * the ones that were dropped. */
    assert(count_occurrences(json, "\"s\":\"sent\"") == HC_BOARD_LOG_RING_SIZE);
    /* The oldest facts were overwritten, the newest ones survive. */
    assert(strstr(json, "\"t\":\"t-0\"") == NULL);
    assert(strstr(json, "\"t\":\"t-1\"") == NULL);
    assert(strstr(json, "\"t\":\"t-2\"") == NULL);
    assert(strstr(json, "\"t\":\"t-3\"") == NULL);
    assert(strstr(json, "\"t\":\"t-4\"") != NULL);
    assert(strstr(json, "\"t\":\"t-15\"") != NULL);

    /* The serialized payload always fits the buffer the heartbeat uses. */
    assert(written < HC_BOARD_LOG_JSON_MAX);

    /* ---------------------------------------------------------------- */
    /* A command fact is never pushed out by routine link facts.         */
    /* ---------------------------------------------------------------- */
    hc_board_log_init(3);
    for (int i = 0; i < HC_BOARD_LOG_RING_SIZE; ++i) {
        char target[16];
        snprintf(target, sizeof(target), "c-%d", i);
        hc_board_log_record(
            HC_BOARD_LOG_KIND_COMM,
            HC_BOARD_LOG_STATUS_SENT,
            HC_BOARD_LOG_METHOD_ESPNOW,
            target,
            NULL,
            NULL
        );
    }
    hc_board_log_record(
        HC_BOARD_LOG_KIND_COMMAND,
        HC_BOARD_LOG_STATUS_EXECUTED,
        HC_BOARD_LOG_METHOD_MQTT,
        "important",
        NULL,
        "cmd-keep"
    );
    written = hc_board_log_write_json(json, sizeof(json), &written_count);
    assert(written > 0);
    /* The command fact survived, and it displaced the oldest link fact. */
    assert(strstr(json, "\"s\":\"executed\"") != NULL);
    assert(strstr(json, "\"t\":\"important\"") != NULL);
    assert(strstr(json, "\"c\":\"cmd-keep\"") != NULL);
    assert(strstr(json, "\"t\":\"c-0\"") == NULL);
    assert(strstr(json, "\"t\":\"c-1\"") != NULL);

    /* ---------------------------------------------------------------- */
    /* Facts keep their insertion order.                                */
    /* ---------------------------------------------------------------- */
    hc_board_log_init(1);
    hc_board_log_record(HC_BOARD_LOG_KIND_COMMAND, "received", "mqtt", "a", NULL, NULL);
    hc_board_log_record(HC_BOARD_LOG_KIND_COMMAND, "executed", "mqtt", "b", NULL, NULL);
    written = hc_board_log_write_json(json, sizeof(json), &written_count);
    assert(written > 0);
    assert(strstr(json, "\"t\":\"a\"") < strstr(json, "\"t\":\"b\""));

    /* The order survives a second serialization of the same facts. */
    char again[HC_BOARD_LOG_JSON_MAX];
    size_t again_len = hc_board_log_write_json(again, sizeof(again), &written_count);
    assert(again_len == written);
    assert(strstr(again, "\"t\":\"a\"") < strstr(again, "\"t\":\"b\""));

    /* ---------------------------------------------------------------- */
    /* A batch that does not fit stays valid: only the facts that fit are
     * written, the rest wait for the next heartbeat.                    */
    /* ---------------------------------------------------------------- */
    hc_board_log_init(5);
    for (int i = 0; i < 4; ++i) {
        char target[16];
        snprintf(target, sizeof(target), "p-%d", i);
        hc_board_log_record(
            HC_BOARD_LOG_KIND_COMMAND,
            HC_BOARD_LOG_STATUS_RECEIVED,
            HC_BOARD_LOG_METHOD_MQTT,
            target,
            "a rather long detail about the command",
            "cmd-0000000000000000000000000000000000000000"
        );
    }
    char small[160];
    written = hc_board_log_write_json(small, sizeof(small), &written_count);
    assert(written > 0);
    assert(written < sizeof(small));
    /* The partial batch is still a well formed JSON array. */
    assert(json_is_balanced(small));
    assert(written_count > 0);
    assert(written_count < 4);
    uint8_t partial_count = written_count;
    /* The facts that did not fit are still in the ring. */
    assert(hc_board_log_pending() == 4);
    /* Only the facts that were written are dropped after a good report. */
    hc_board_log_commit_sent(partial_count);
    assert(hc_board_log_pending() == (uint8_t)(4 - partial_count));
    /* The remaining facts are reported with the next heartbeat. */
    written = hc_board_log_write_json(json, sizeof(json), &written_count);
    assert(written > 0);
    assert(written_count == (uint8_t)(4 - partial_count));
    assert(json_is_balanced(json));
    assert(strstr(json, "\"t\":\"p-3\"") != NULL);

    /* ---------------------------------------------------------------- */
    /* Overlong fields are truncated, and non-printable bytes are
     * neutralised, so a fact can never grow the payload without bound. */
    /* ---------------------------------------------------------------- */
    hc_board_log_init(1);
    {
        char long_target[200];
        memset(long_target, 'x', sizeof(long_target) - 1);
        long_target[sizeof(long_target) - 1] = '\0';
        hc_board_log_record(
            HC_BOARD_LOG_KIND_COMMAND,
            HC_BOARD_LOG_STATUS_EXECUTED,
            HC_BOARD_LOG_METHOD_MQTT,
            long_target,
            NULL,
            NULL
        );
        written = hc_board_log_write_json(json, sizeof(json), &written_count);
        assert(written > 0);
        assert(written < HC_BOARD_LOG_JSON_MAX);
        assert(json_is_balanced(json));
        /* The serialized target is shorter than the raw 199 character input. */
        const char *target_at = strstr(json, "\"t\":\"");
        assert(target_at != NULL);
        size_t target_len = 0;
        const char *cursor = target_at + 5;
        while (cursor[target_len] != '"') target_len += 1;
        assert(target_len < 40);
    }

    /* A quote inside a field is escaped, so the JSON stays parsable. */
    hc_board_log_init(1);
    hc_board_log_record(
        HC_BOARD_LOG_KIND_COMMAND,
        HC_BOARD_LOG_STATUS_FAILED,
        HC_BOARD_LOG_METHOD_MQTT,
        "a\"b",
        NULL,
        NULL
    );
    written = hc_board_log_write_json(json, sizeof(json), &written_count);
    assert(written > 0);
    assert(strstr(json, "\\\"") != NULL);
    assert(json_is_balanced(json));

    /* ---------------------------------------------------------------- */
    /* A missing kind or status is not recorded at all.                */
    /* ---------------------------------------------------------------- */
    hc_board_log_init(1);
    hc_board_log_record(NULL, "received", "mqtt", "a", NULL, NULL);
    hc_board_log_record(HC_BOARD_LOG_KIND_COMMAND, NULL, "mqtt", "a", NULL, NULL);
    assert(hc_board_log_pending() == 0);

    /* ---------------------------------------------------------------- */
    /* The reset seam clears everything, including the sequence.        */
    /* ---------------------------------------------------------------- */
    hc_board_log_init(99);
    hc_board_log_record(HC_BOARD_LOG_KIND_COMM, "sent", "espnow", "n1", NULL, NULL);
    hc_board_log_reset();
    assert(hc_board_log_pending() == 0);
    assert(hc_board_log_session_id() == 0);

    /* ---------------------------------------------------------------- */
    /* A board instance id is a 36 character UUID and must survive      */
    /* intact: the Worker matches the peer of an ESP-NOW fact by id.    */
    /* ---------------------------------------------------------------- */
    hc_board_log_init(11);
    {
        const char *uuid = "77941df9-8170-441c-9aaf-de4c843ba4c9";
        assert(strlen(uuid) == 36);
        hc_board_log_record(
            HC_BOARD_LOG_KIND_COMMAND,
            HC_BOARD_LOG_STATUS_EXECUTED,
            HC_BOARD_LOG_METHOD_ESPNOW,
            uuid,
            NULL,
            NULL
        );
        written = hc_board_log_write_json(json, sizeof(json), &written_count);
        assert(written > 0);
        char expected[48];
        snprintf(expected, sizeof(expected), "\"t\":\"%s\"", uuid);
        assert(strstr(json, expected) != NULL);
    }

    /* ---------------------------------------------------------------- */
    /* A batch that cannot hold a single fact is not reported as an     */
    /* empty array: nothing was written, so the fact must stay pending  */
    /* and the caller must not add an empty "fx" list.                  */
    /* ---------------------------------------------------------------- */
    hc_board_log_init(12);
    hc_board_log_record(
        HC_BOARD_LOG_KIND_COMMAND,
        HC_BOARD_LOG_STATUS_EXECUTED,
        HC_BOARD_LOG_METHOD_ESPNOW,
        "77941df9-8170-441c-9aaf-de4c843ba4c9",
        "a rather long detail for the fact",
        "cmd-1234"
    );
    {
        char tiny[8];
        written_count = 0xFF;
        written = hc_board_log_write_json(tiny, sizeof(tiny), &written_count);
        assert(written == 0);
        assert(written_count == 0);
        assert(tiny[0] == '\0');
        /* The fact is still waiting for the next heartbeat. */
        assert(hc_board_log_pending() == 1);
    }

    /* ---------------------------------------------------------------- */
    /* The boot fact carries the chip's reset reason as its detail.     */
    /* ---------------------------------------------------------------- */
    hc_board_log_init(13);
    hc_board_log_record(
        HC_BOARD_LOG_KIND_SYSTEM,
        HC_BOARD_LOG_STATUS_BOOT,
        NULL,
        NULL,
        "power_on",
        NULL
    );
    written = hc_board_log_write_json(json, sizeof(json), &written_count);
    assert(written > 0);
    assert(strstr(json, "\"k\":\"sys\"") != NULL);
    assert(strstr(json, "\"s\":\"boot\"") != NULL);
    assert(strstr(json, "\"d\":\"power_on\"") != NULL);
    assert(json_is_balanced(json));

    /* ---------------------------------------------------------------- */
    /* A fact recorded while the batch is in flight survives the commit.*/
    /* A full ring evicts the oldest fact when that happens, so the     */
    /* array shifts down by one; the commit must still remove only the  */
    /* facts that were serialized.                                      */
    /* ---------------------------------------------------------------- */
    hc_board_log_init(14);
    for (int i = 0; i < HC_BOARD_LOG_RING_SIZE; i++) {
        hc_board_log_record(HC_BOARD_LOG_KIND_COMM, "sent", "espnow", "peer", NULL, NULL);
    }
    written = hc_board_log_write_json(json, sizeof(json), &written_count);
    assert(written > 0);
    assert(written_count == HC_BOARD_LOG_RING_SIZE);
    /* The report is now on the wire: a link transition is recorded. */
    hc_board_log_record(
        HC_BOARD_LOG_KIND_COMM,
        HC_BOARD_LOG_STATUS_LINK_UP,
        HC_BOARD_LOG_METHOD_ESPNOW,
        "peer",
        "linked",
        NULL
    );
    assert(hc_board_log_pending() == HC_BOARD_LOG_RING_SIZE);
    hc_board_log_commit_sent(written_count);
    /* The new fact is still pending; only the serialized batch went away. */
    assert(hc_board_log_pending() == 1);
    written = hc_board_log_write_json(json, sizeof(json), &written_count);
    assert(written > 0);
    assert(written_count == 1);
    assert(strstr(json, "\"s\":\"link_established\"") != NULL);

    printf("test_board_log: all assertions passed.\n");
    return 0;
}
