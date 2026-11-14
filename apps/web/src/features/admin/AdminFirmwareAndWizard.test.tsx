import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  VERIFIED_BOARD_CATALOG,
  resolveBoardFirmwareCompatibility,
} from "@homecoreos/shared";
import { TimezoneContext } from "../../lib/timezone";
import { AdminFirmwarePage } from "./AdminFirmwareEmqxUsageSettingsPages";
import { AdminBoardsPage } from "./AdminAccountsAndBoardsPages";
import type { BoardProfileItem, FirmwareReleaseItem } from "../types";

const originalFetch = globalThis.fetch;

describe("Multi-Board Admin Firmware, Board Metadata & Wizard UX", () => {
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("renders compatibility badges on AdminFirmwarePage and supports Verify + Rollback APIs", async () => {
    const user = userEvent.setup();
    const c5Board = {
      ...VERIFIED_BOARD_CATALOG.find((b) => b.slug === "esp32-c5-devkitc-1")!,
      id: "b-c5",
      is_available: true,
    } as BoardProfileItem;

    const releasesPayload: FirmwareReleaseItem[] = [
      {
        id: "rel-c5-old",
        name: "HomecoreOS C5",
        version: "2.0.0",
        channel: "stable",
        chip_family: "esp32c5",
        target_board_slug: "esp32-c5-devkitc-1",
        partition_scheme: "dual_ota_8mb",
        psram_mode: "quad",
        flash_size_mb: 8,
        hardware_verified: false,
        compatible_board_ids: ["b-c5"],
        compatible_board_slugs: ["esp32-c5-devkitc-1"],
        ota_available: true,
        usb_available: false,
        status: "published",
        release_notes: "Initial C5 release",
        published_at: "2026-11-10T00:00:00.000Z",
        files: [
          {
            id: "f-1",
            release_id: "rel-c5-old",
            file_type: "ota_app",
            file_name: "c5-ota.bin",
            size_bytes: 512000,
            sha256: "abc123def456",
            flash_address: "0x20000",
            flash_mode: "dio",
            flash_freq: "80m",
            flash_size: "8MB",
            validated: true,
          },
        ],
        ota_stats: { total: 4, succeeded: 3, failed: 1, active: 0 },
      },
      {
        id: "rel-c5-fallback",
        name: "HomecoreOS C5",
        version: "1.9.0",
        channel: "stable",
        chip_family: "esp32c5",
        target_board_slug: "esp32-c5-devkitc-1",
        partition_scheme: "dual_ota_8mb",
        psram_mode: "quad",
        flash_size_mb: 8,
        hardware_verified: true,
        compatible_board_ids: ["b-c5"],
        compatible_board_slugs: ["esp32-c5-devkitc-1"],
        ota_available: true,
        usb_available: true,
        status: "deprecated",
        release_notes: "Fallback C5 release",
        published_at: "2026-10-10T00:00:00.000Z",
        files: [],
      },
    ];

    const calls: Array<{ url: string; method: string; body?: string }> = [];
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      const method = (init?.method ?? "GET").toUpperCase();
      calls.push({ url, method, body: typeof init?.body === "string" ? init.body : undefined });
      if (url === "/api/admin/firmware" && method === "GET") {
        return new Response(JSON.stringify({ releases: releasesPayload }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (url === "/api/admin/boards" && method === "GET") {
        return new Response(JSON.stringify({ boards: [c5Board] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as unknown as typeof fetch;

    render(
      <TimezoneContext.Provider value="UTC">
        <AdminFirmwarePage />
      </TimezoneContext.Provider>
    );

    expect((await screen.findAllByText(/dual_ota_8mb/i)).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/psram:quad/i).length).toBeGreaterThan(0);
    expect(screen.getByText(/OTA: 3 ok · 1 fail/i)).toBeInTheDocument();

    // Verify quick action triggers /verify inside the row dropdown menu
    await user.click(
      screen.getByRole("button", { name: /Actions for HomecoreOS C5 v2\.0\.0/i })
    );
    await user.click(screen.getByRole("menuitem", { name: /^Verify$/i }));
    await waitFor(() => {
      expect(calls.some((c) => c.url === "/api/admin/firmware/rel-c5-old/verify")).toBe(true);
    });

    // Rollback action inside the row dropdown menu calls /rollback
    await user.click(
      screen.getByRole("button", { name: /Actions for HomecoreOS C5 v2\.0\.0/i })
    );
    await user.click(screen.getByRole("menuitem", { name: /Rollback/i }));
    await user.type(screen.getByLabelText(/Rollback Reason/i), "Wi-Fi glitch");
    await user.click(screen.getByRole("button", { name: /Confirm Rollback/i }));
    await waitFor(() => {
      expect(calls.some((c) => c.url === "/api/admin/firmware/rel-c5-old/rollback")).toBe(true);
    });
  });

  it("renders board compat badges on AdminBoardsPage including GPIO28 and No Wi-Fi", async () => {
    const rawC5 = VERIFIED_BOARD_CATALOG.find((b) => b.slug === "esp32-c5-devkitc-1")!;
    const rawH2 = VERIFIED_BOARD_CATALOG.find((b) => b.slug === "esp32-h2-devkitm-1")!;
    const c5 = {
      ...rawC5,
      ...resolveBoardFirmwareCompatibility(rawC5),
      id: "b-c5",
      is_available: true,
    } as BoardProfileItem;
    const h2 = {
      ...rawH2,
      ...resolveBoardFirmwareCompatibility(rawH2),
      id: "b-h2",
      is_available: true,
    } as BoardProfileItem;

    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url === "/api/admin/boards") {
        return new Response(JSON.stringify({ boards: [c5, h2], syncRuns: [] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }) as unknown as typeof fetch;

    render(
      <TimezoneContext.Provider value="UTC">
        <AdminBoardsPage />
      </TimezoneContext.Provider>
    );

    expect(await screen.findByText(/GPIO28/i)).toBeInTheDocument();
    expect(screen.getByText(/boot:0x2000/i)).toBeInTheDocument();
    expect(screen.getByText(/No Wi-Fi/i)).toBeInTheDocument();
  });

  it("renders simplified 9-field firmware upload modal, auto-resolves board metadata, blocks incompatible selections, and respects defaults", async () => {
    const user = userEvent.setup();
    const mkBoard = (slug: string, id: string) => {
      const raw = VERIFIED_BOARD_CATALOG.find((b) => b.slug === slug)!;
      return {
        ...raw,
        ...resolveBoardFirmwareCompatibility(raw),
        id,
        is_available: true,
      } as BoardProfileItem;
    };

    const n16r8 = mkBoard("esp32-s3-devkitc-1-n16r8", "b-n16r8");
    const xiao = mkBoard("seeed-xiao-esp32s3", "b-xiao");
    const s3v10 = mkBoard("esp32-s3-devkitc-1-v1-0", "b-s3v10");
    const c5 = mkBoard("esp32-c5-devkitc-1", "b-c5");

    let uploadedForm: FormData | null = null;

    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      const method = (init?.method ?? "GET").toUpperCase();
      if (url === "/api/admin/firmware" && method === "GET") {
        return new Response(JSON.stringify({ releases: [] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (url === "/api/admin/boards" && method === "GET") {
        return new Response(JSON.stringify({ boards: [n16r8, xiao, s3v10, c5] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (url === "/api/admin/firmware/release" && method === "POST") {
        uploadedForm = init?.body as FormData;
        return new Response(
          JSON.stringify({
            release: { id: "rel-new", status: "draft" },
            files: [],
          }),
          { status: 201, headers: { "Content-Type": "application/json" } }
        );
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }) as unknown as typeof fetch;

    render(
      <TimezoneContext.Provider value="UTC">
        <AdminFirmwarePage />
      </TimezoneContext.Provider>
    );

    const openBtn = await screen.findByRole("button", { name: /Upload Binary \/ Release/i });
    await user.click(openBtn);

    // 1. Standard upload form shows ONLY the 9 fields and hides all 8 technical controls
    expect(screen.getByLabelText(/Release Name/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/Version/i)).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: /Channel/i })).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: /Compatible Boards/i })).toBeInTheDocument();
    expect(screen.getByLabelText(/Release Notes/i)).toBeInTheDocument();
    expect(screen.getByText("Complete firmware image for USB flashing.")).toBeInTheDocument();
    expect(screen.getByText("Application firmware for OTA updates.")).toBeInTheDocument();

    const verifiedSwitch = screen.getByRole("switch", {
      name: /Verified on Physical Hardware/i,
    });
    const publishSwitch = screen.getByRole("switch", { name: /Publish Immediately/i });
    expect(verifiedSwitch).toHaveAttribute("aria-checked", "false");
    expect(publishSwitch).toHaveAttribute("aria-checked", "true");

    expect(screen.queryByLabelText(/Chip Family/i)).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/Target Board Preset/i)).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/Partition Scheme/i)).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/PSRAM Mode/i)).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/Target Flash/i)).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/Flash Mode/i)).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/Flash Frequency/i)).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/OTA App Offset/i)).not.toBeInTheDocument();

    // 2. Selecting incompatible 16MB + 8MB boards displays clear error & blocks submission
    await user.click(screen.getByRole("combobox", { name: /Compatible Boards/i }));
    await user.click(await screen.findByText(/ESP32-S3-DevKitC-1 N16R8/i));
    await user.click(screen.getByText(/Seeed Studio XIAO ESP32-S3/i));

    expect(
      await screen.findByText(/separate flash \/ partition layouts/i)
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Upload Release$/i })).toBeDisabled();

    // Remove incompatible 16MB N16R8, add compatible 8MB DevKitC-1 v1.0
    await user.click(screen.getByRole("button", { name: /Remove ESP32-S3-DevKitC-1 N16R8/i }));
    await user.click(screen.getByRole("combobox", { name: /Compatible Boards/i }));
    await user.click(await screen.findByText(/ESP32-S3-DevKitC-1 v1\.0/i));
    expect(screen.queryByText(/separate flash \/ partition layouts/i)).not.toBeInTheDocument();

    // 3. Uploading an ESP32-C3 binary for ESP32-S3 boards triggers binary validation error
    const badC3Bytes = new Uint8Array(512);
    badC3Bytes[0] = 0xe9;
    badC3Bytes[8] = 0xee;
    badC3Bytes[12] = 5; // ESP32-C3 chip ID
    badC3Bytes[23] = 1;
    const otaInput = screen.getByLabelText("OTA App Binary") as HTMLInputElement;
    await user.upload(otaInput, new File([badC3Bytes], "wrong-c3.bin"));
    expect(
      await screen.findByText(/Binary targets ESP32C3.*incompatible with selected ESP32S3/i)
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Upload Release$/i })).toBeDisabled();

    // 4. Replace with valid ESP32-S3 binaries, toggle Publish Immediately OFF (save draft), and submit
    const validS3Bytes = new Uint8Array(512);
    validS3Bytes[0] = 0xe9;
    validS3Bytes[8] = 0xee;
    validS3Bytes[12] = 9; // ESP32-S3 chip ID
    validS3Bytes[23] = 1;

    const usbInput = screen.getByLabelText("USB Factory Binary") as HTMLInputElement;
    await user.upload(usbInput, new File([validS3Bytes], "s3-usb.bin"));
    await user.upload(otaInput, new File([validS3Bytes], "s3-ota.bin"));

    const versionInput = screen.getByLabelText(/Version/i);
    await user.type(versionInput, "3.2.0");
    await user.type(screen.getByLabelText(/Release Notes/i), "Simplified upload test");
    await user.click(publishSwitch);
    expect(publishSwitch).toHaveAttribute("aria-checked", "false");

    const submitBtn = screen.getByRole("button", { name: /Upload Release$/i });
    await waitFor(() => expect(submitBtn).toBeEnabled());
    await user.click(submitBtn);

    await waitFor(() => expect(uploadedForm).not.toBeNull());
    expect(uploadedForm!.get("version")).toBe("3.2.0");
    expect(uploadedForm!.get("channel")).toBe("stable");
    expect(uploadedForm!.get("chipFamily")).toBe("esp32s3");
    expect(uploadedForm!.get("partitionScheme")).toBe("dual_ota_8mb");
    expect(uploadedForm!.get("psramMode")).toBe("octal");
    expect(uploadedForm!.get("flashMode")).toBe("qio");
    expect(uploadedForm!.get("flashFreq")).toBe("80m");
    expect(uploadedForm!.get("flashSize")).toBe("8MB");
    expect(uploadedForm!.get("otaFlashAddress")).toBe("0x20000");
    expect(uploadedForm!.get("hardwareVerified")).toBe("false");
    expect(uploadedForm!.get("publish")).toBe("false");
    expect(JSON.parse(String(uploadedForm!.get("compatibleBoardIds")))).toEqual([
      xiao.id,
      s3v10.id,
    ]);
  });
});
