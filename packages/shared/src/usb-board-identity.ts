/**
 * USB board identity verification.
 *
 * Before a USB flash writes anything, the flasher reads what the connected
 * board really is (chip, flash, PSRAM, USB interface) and this module compares
 * it with the board the user selected and with every Board Library profile.
 *
 * An ESP32 has no "board model" register, so a board is identified by its
 * hardware signature. Everything here is a pure function of that signature, so
 * the same verdict is reproducible in tests and in the audit trail.
 */
import { VERIFIED_BOARD_CATALOG } from "./board-catalog-data";
import { chipFamilyLabel, type BoardLayoutSpec } from "./index";

// ---------------------------------------------------------------------------
// Chip name -> chip family
// ---------------------------------------------------------------------------

const KNOWN_SUBFAMILIES = [
  "esp32c61",
  "esp32h21",
  "esp32s31",
  "esp32s3",
  "esp32s2",
  "esp32c6",
  "esp32c5",
  "esp32c3",
  "esp32c2",
  "esp32h2",
  "esp32h4",
  "esp32p4",
];

/**
 * Canonical Espressif SoC family of a ROM chip name or a family string
 * ("ESP32-C61 (revision v0.1)" -> "esp32c61", "ESP8684" -> "esp32c2",
 * "ESP32-D0WD-V3" -> "esp32"). Compares whole families, never substrings.
 */
export function canonicalChipFamily(raw: string | null | undefined): string {
  const firstToken = (raw ?? "").trim().split(/[\s(]/)[0] ?? "";
  const norm = firstToken.toLowerCase().replace(/[^a-z0-9]/g, "");
  if (!norm) return "";
  if (norm === "esp8684" || norm.startsWith("esp8684")) return "esp32c2";
  for (const fam of KNOWN_SUBFAMILIES) {
    if (norm === fam || norm.startsWith(fam)) return fam;
  }
  if (
    norm === "esp32" ||
    norm.startsWith("esp32d0") ||
    norm.startsWith("esp32u4") ||
    norm.startsWith("esp32pico") ||
    norm.startsWith("esp32s0")
  ) {
    return "esp32";
  }
  return norm;
}

// ---------------------------------------------------------------------------
// USB interface
// ---------------------------------------------------------------------------

export type UsbSerialInterfaceKind = "native_usb" | "uart_bridge" | "vendor_usb" | "unknown";

export interface UsbSerialInterfaceInfo {
  kind: UsbSerialInterfaceKind;
  /** "CP210x USB-UART bridge", "Espressif native USB (Serial/JTAG)" ... */
  label: string;
  vendorName: string | null;
  /** "303A:1001", or null when the browser reports no USB IDs. */
  usbId: string | null;
}

const USB_VENDORS: Record<number, { name: string; kind: UsbSerialInterfaceKind; label: string }> = {
  0x303a: { name: "Espressif", kind: "native_usb", label: "Espressif native USB (Serial/JTAG)" },
  0x10c4: { name: "Silicon Labs", kind: "uart_bridge", label: "CP210x USB-UART bridge" },
  0x1a86: { name: "WCH", kind: "uart_bridge", label: "CH340 / CH343 USB-UART bridge" },
  0x0403: { name: "FTDI", kind: "uart_bridge", label: "FTDI USB-UART bridge" },
  0x2886: { name: "Seeed Studio", kind: "vendor_usb", label: "Seeed Studio USB device" },
};

/** USB vendor IDs the flasher offers in the browser's port picker. */
export const USB_FLASH_PORT_VENDOR_IDS: number[] = Object.keys(USB_VENDORS).map(Number);

function hex4(value: number): string {
  return value.toString(16).toUpperCase().padStart(4, "0");
}

export function parseUsbHexId(raw: string | number | null | undefined): number | null {
  if (typeof raw === "number") return Number.isFinite(raw) ? raw : null;
  if (!raw) return null;
  const cleaned = raw.trim().toLowerCase().replace(/^0x/, "");
  if (!/^[0-9a-f]{1,4}$/.test(cleaned)) return null;
  return Number.parseInt(cleaned, 16);
}

export function describeUsbSerialInterface(
  vendorId: number | null | undefined,
  productId: number | null | undefined
): UsbSerialInterfaceInfo {
  if (typeof vendorId !== "number") {
    return { kind: "unknown", label: "USB interface not reported", vendorName: null, usbId: null };
  }
  const usbId = `${hex4(vendorId)}:${typeof productId === "number" ? hex4(productId) : "----"}`;
  const known = USB_VENDORS[vendorId];
  if (known) return { kind: known.kind, label: known.label, vendorName: known.name, usbId };
  return { kind: "vendor_usb", label: "USB serial device", vendorName: null, usbId };
}

// ---------------------------------------------------------------------------
// Detected hardware and library profiles
// ---------------------------------------------------------------------------

export interface DetectedUsbBoard {
  /** The ROM's own description, e.g. "ESP32-S3 (QFN56) (revision v0.2)". */
  chipName: string;
  flashSizeMb: number | null;
  /** In-package PSRAM in MB, 0 when the chip reports none, null when unknown. */
  psramSizeMb: number | null;
  features?: string[];
  macAddress?: string | null;
  usbVendorId?: number | null;
  usbProductId?: number | null;
}

export interface UsbIdentityBoardProfile {
  id?: string;
  slug?: string;
  manufacturer?: string;
  model?: string;
  revision?: string;
  chip_family?: string;
  chip_variant?: string;
  flash_size_mb?: number;
  psram_size_mb?: number;
  usb_vid?: string | null;
  usb_pid?: string | null;
  board_layout?: BoardLayoutSpec | null;
  verification_status?: string | null;
  firmware_status?: string | null;
  catalog_category?: string | null;
}

/**
 * Chip families whose ROM reports in-package PSRAM. For every other family the
 * detected PSRAM stays "unknown" and is never used as evidence.
 */
const PSRAM_REPORTING_FAMILIES = new Set(["esp32s3"]);

/** Reads in-package PSRAM from the chip feature list ("Embedded PSRAM 8MB (AP_3v3)"). */
export function detectedPsramFromFeatures(
  chipName: string,
  features: string[] | null | undefined
): number | null {
  if (!features) return null;
  for (const feature of features) {
    if (!/PSRAM/i.test(feature)) continue;
    // "Unknown Embedded PSRAM" has no size: report it as unknown, never as none.
    const match = feature.match(/PSRAM\s+(\d+)\s*MB/i);
    return match ? Number.parseInt(match[1]!, 10) : null;
  }
  return PSRAM_REPORTING_FAMILIES.has(canonicalChipFamily(chipName)) ? 0 : null;
}

function boardLabel(board: UsbIdentityBoardProfile | null | undefined): string {
  if (!board) return "No board selected";
  const name = [board.manufacturer, board.model].filter(Boolean).join(" ").trim();
  return name || board.slug || "Selected board";
}

function usbTopology(
  board: UsbIdentityBoardProfile
): { hasUartBridge: boolean; hasNativePort: boolean } | null {
  // Only explicit, documented topology counts. A guessed default must never
  // turn into a mismatch warning.
  const explicit =
    board.board_layout?.hardwareSpecs ??
    (board.slug
      ? VERIFIED_BOARD_CATALOG.find((b) => b.slug === board.slug)?.board_layout.hardwareSpecs
      : undefined);
  if (!explicit || typeof explicit.hasUartBridge !== "boolean") return null;
  const ports = explicit.usbPortCount ?? 1;
  return {
    hasUartBridge: explicit.hasUartBridge,
    hasNativePort: !explicit.hasUartBridge || ports >= 2,
  };
}

// ---------------------------------------------------------------------------
// Comparison
// ---------------------------------------------------------------------------

export type UsbBoardMismatchCode =
  | "chip_family"
  | "flash_smaller"
  | "flash_larger"
  | "psram_smaller"
  | "psram_larger"
  | "usb_interface"
  | "usb_vendor";

export type UsbBoardMismatchSeverity = "critical" | "major" | "minor";

export interface UsbBoardMismatch {
  code: UsbBoardMismatchCode;
  /**
   * How firmly flashing must stop.
   * critical: the firmware cannot start (different chip).
   * major: the firmware may not start (less memory), or the board is a
   *        different product (different USB interface or maker).
   * minor: a variant of the selected board with more memory.
   * What to tell the user is a separate question: see usbBoardMismatchImpact().
   */
  severity: UsbBoardMismatchSeverity;
  title: string;
  detail: string;
}

export type UsbBoardCheckStatus = "match" | "mismatch" | "unknown";

export interface UsbBoardCheck {
  key: "chip" | "flash" | "psram" | "usb";
  label: string;
  detected: string;
  expected: string;
  status: UsbBoardCheckStatus;
}

function compareWithProfile(
  detected: DetectedUsbBoard,
  profile: UsbIdentityBoardProfile
): { mismatches: UsbBoardMismatch[]; checks: UsbBoardCheck[] } {
  const mismatches: UsbBoardMismatch[] = [];
  const checks: UsbBoardCheck[] = [];
  const name = boardLabel(profile);
  const detectedFamily = canonicalChipFamily(detected.chipName);
  const usb = describeUsbSerialInterface(detected.usbVendorId, detected.usbProductId);

  // 1. Chip
  const expectedFamily = profile.chip_family ? canonicalChipFamily(profile.chip_family) : "";
  if (expectedFamily && detectedFamily) {
    const same = expectedFamily === detectedFamily;
    checks.push({
      key: "chip",
      label: "Chip",
      detected: chipFamilyLabel(detectedFamily),
      expected: chipFamilyLabel(expectedFamily),
      status: same ? "match" : "mismatch",
    });
    if (!same) {
      mismatches.push({
        code: "chip_family",
        severity: "critical",
        title: "Different chip",
        detail: `The connected board has an ${chipFamilyLabel(detectedFamily)} chip, but ${name} uses an ${chipFamilyLabel(expectedFamily)}. Firmware built for one cannot start on the other.`,
      });
    }
  } else {
    checks.push({
      key: "chip",
      label: "Chip",
      detected: detectedFamily ? chipFamilyLabel(detectedFamily) : "Not reported",
      expected: expectedFamily ? chipFamilyLabel(expectedFamily) : "Not specified",
      status: "unknown",
    });
  }

  // 2. Flash
  const expectedFlash = typeof profile.flash_size_mb === "number" ? profile.flash_size_mb : null;
  if (expectedFlash !== null && detected.flashSizeMb !== null) {
    const same = expectedFlash === detected.flashSizeMb;
    checks.push({
      key: "flash",
      label: "Flash",
      detected: `${detected.flashSizeMb} MB`,
      expected: `${expectedFlash} MB`,
      status: same ? "match" : "mismatch",
    });
    if (detected.flashSizeMb < expectedFlash) {
      mismatches.push({
        code: "flash_smaller",
        severity: "major",
        title: "Less flash memory",
        detail: `The connected board has ${detected.flashSizeMb} MB of flash, but ${name} has ${expectedFlash} MB. Firmware laid out for ${expectedFlash} MB may not fit or start.`,
      });
    } else if (detected.flashSizeMb > expectedFlash) {
      mismatches.push({
        code: "flash_larger",
        severity: "minor",
        title: "More flash memory",
        detail: `The connected board has ${detected.flashSizeMb} MB of flash, but ${name} has ${expectedFlash} MB. The firmware fits, but this is a different board variant.`,
      });
    }
  } else {
    checks.push({
      key: "flash",
      label: "Flash",
      detected: detected.flashSizeMb !== null ? `${detected.flashSizeMb} MB` : "Not reported",
      expected: expectedFlash !== null ? `${expectedFlash} MB` : "Not specified",
      status: "unknown",
    });
  }

  // 3. PSRAM (only when the chip reports it)
  const expectedPsram = typeof profile.psram_size_mb === "number" ? profile.psram_size_mb : null;
  if (expectedPsram !== null && detected.psramSizeMb !== null) {
    const same = expectedPsram === detected.psramSizeMb;
    checks.push({
      key: "psram",
      label: "PSRAM",
      detected: detected.psramSizeMb > 0 ? `${detected.psramSizeMb} MB` : "None",
      expected: expectedPsram > 0 ? `${expectedPsram} MB` : "None",
      status: same ? "match" : "mismatch",
    });
    if (detected.psramSizeMb < expectedPsram) {
      mismatches.push({
        code: "psram_smaller",
        severity: "major",
        title: detected.psramSizeMb === 0 ? "No PSRAM" : "Less PSRAM",
        detail: `The connected chip reports ${detected.psramSizeMb > 0 ? `${detected.psramSizeMb} MB of` : "no"} PSRAM, but ${name} has ${expectedPsram} MB. Firmware that expects PSRAM may fail to start.`,
      });
    } else if (detected.psramSizeMb > expectedPsram) {
      mismatches.push({
        code: "psram_larger",
        severity: "minor",
        title: "More PSRAM",
        detail: `The connected chip reports ${detected.psramSizeMb} MB of PSRAM, but ${name} has ${expectedPsram > 0 ? `${expectedPsram} MB` : "none"}. The firmware runs, but this is a different board variant.`,
      });
    }
  } else {
    checks.push({
      key: "psram",
      label: "PSRAM",
      detected:
        detected.psramSizeMb === null
          ? "Not reported"
          : detected.psramSizeMb > 0
            ? `${detected.psramSizeMb} MB`
            : "None",
      expected: expectedPsram === null ? "Not specified" : expectedPsram > 0 ? `${expectedPsram} MB` : "None",
      status: "unknown",
    });
  }

  // 4. USB interface
  const topology = usbTopology(profile);
  const profileVid = parseUsbHexId(profile.usb_vid);
  let usbStatus: UsbBoardCheckStatus = "unknown";
  let usbExpected = "Not specified";
  if (topology) {
    usbExpected = topology.hasUartBridge
      ? topology.hasNativePort
        ? "USB-UART bridge or native USB"
        : "USB-UART bridge"
      : "Native USB";
  }
  if (usb.kind === "uart_bridge" && topology) {
    usbStatus = topology.hasUartBridge ? "match" : "mismatch";
    if (!topology.hasUartBridge) {
      mismatches.push({
        code: "usb_interface",
        severity: "major",
        title: "Different USB interface",
        detail: `The board is connected through a ${usb.label}, but ${name} has no USB-UART bridge: it connects through the chip's native USB port.`,
      });
    }
  } else if (usb.kind === "native_usb" && topology) {
    usbStatus = topology.hasNativePort ? "match" : "mismatch";
    if (!topology.hasNativePort) {
      mismatches.push({
        code: "usb_interface",
        severity: "major",
        title: "Different USB interface",
        detail: `The board is connected through the chip's native USB port, but ${name} only has a USB-UART bridge port.`,
      });
    }
  } else if (usb.kind === "vendor_usb" && typeof detected.usbVendorId === "number") {
    if (profileVid !== null && profileVid === detected.usbVendorId) {
      usbExpected = `USB vendor ${hex4(profileVid)}`;
      usbStatus = "match";
    } else if (usb.vendorName && profile.manufacturer) {
      // A board keeps its maker's USB vendor ID while its own firmware runs,
      // so a known vendor that is not the maker of the selected board is a
      // different board. Unknown vendor IDs prove nothing and are ignored.
      const sameMaker = profile.manufacturer.toLowerCase().includes(usb.vendorName.toLowerCase());
      usbExpected = `${profile.manufacturer} board`;
      usbStatus = sameMaker ? "match" : "mismatch";
      if (!sameMaker) {
        mismatches.push({
          code: "usb_vendor",
          severity: "major",
          title: "Different USB vendor",
          detail: `The connected USB device identifies as a ${usb.vendorName} board (${usb.usbId}), but ${name} is made by ${profile.manufacturer}.`,
        });
      }
    }
  }
  checks.push({
    key: "usb",
    label: "USB",
    detected: usb.usbId ? `${usb.label} (${usb.usbId})` : usb.label,
    expected: usbExpected,
    status: usbStatus,
  });

  return { mismatches, checks };
}

const SEVERITY_RANK: Record<UsbBoardMismatchSeverity | "none", number> = {
  none: 0,
  minor: 1,
  major: 2,
  critical: 3,
};

/**
 * What forcing the flash would lead to.
 * will_not_start: built for another chip.
 * may_not_start: the board has less flash or PSRAM than the firmware expects.
 * different_board: the firmware should start, but the board is another product,
 *                  so the controller would be set up with the wrong pin map.
 * different_variant: same kind of board with more memory.
 */
export type UsbBoardMismatchImpact =
  | "will_not_start"
  | "may_not_start"
  | "different_board"
  | "different_variant";

const USB_ONLY_CODES: ReadonlySet<UsbBoardMismatchCode> = new Set(["usb_interface", "usb_vendor"]);

/**
 * The plain consequence of a set of mismatches, so warnings never claim more
 * than the comparison found. A different USB maker with the same chip and
 * memory is a wrong board, not firmware that "may not start".
 */
export function usbBoardMismatchImpact(
  mismatches: readonly UsbBoardMismatch[]
): UsbBoardMismatchImpact | null {
  if (mismatches.length === 0) return null;
  if (mismatches.some((m) => m.severity === "critical")) return "will_not_start";
  // Anything major that is not purely about the USB identity is treated as a
  // risk to starting, which is the careful reading for codes added later.
  if (mismatches.some((m) => m.severity === "major" && !USB_ONLY_CODES.has(m.code))) {
    return "may_not_start";
  }
  if (mismatches.some((m) => USB_ONLY_CODES.has(m.code))) return "different_board";
  return "different_variant";
}

function worstSeverity(mismatches: UsbBoardMismatch[]): UsbBoardMismatchSeverity | "none" {
  let worst: UsbBoardMismatchSeverity | "none" = "none";
  for (const m of mismatches) {
    if (SEVERITY_RANK[m.severity] > SEVERITY_RANK[worst]) worst = m.severity;
  }
  return worst;
}

export interface UsbBoardRecommendation<TBoard extends UsbIdentityBoardProfile = UsbIdentityBoardProfile> {
  board: TBoard;
  label: string;
  /** Every checked value agrees with the connected hardware. */
  exact: boolean;
  /** What still differs when the board is only the closest one. */
  differences: string[];
}

export interface UsbFirmwareRequirement {
  chipFamily: string;
  /** Smallest flash the firmware image and its partition layout need. */
  minFlashMb: number | null;
  /** How to name the firmware in messages, e.g. "HomecoreOS v1.4.0". */
  label: string;
}

export interface UsbBoardIdentityReport<TBoard extends UsbIdentityBoardProfile = UsbIdentityBoardProfile> {
  /**
   * match: the connected board agrees with the selection.
   * mismatch: something differs. Flashing must stop and ask the user.
   * unverified: the hardware could not be read well enough to compare.
   */
  result: "match" | "mismatch" | "unverified";
  severity: UsbBoardMismatchSeverity | "none";
  detected: DetectedUsbBoard & {
    chipFamily: string;
    usb: UsbSerialInterfaceInfo;
    /** "ESP32-S3 - 8 MB flash - 8 MB PSRAM" */
    summary: string;
  };
  selected: { board: TBoard; label: string } | null;
  checks: UsbBoardCheck[];
  mismatches: UsbBoardMismatch[];
  /** Library boards that fit the connected hardware, best first. */
  recommended: Array<UsbBoardRecommendation<TBoard>>;
  /** Set when no board was selected and exactly one library board fits. */
  identified: TBoard | null;
  /** One line for logs and the audit trail. */
  headline: string;
}

function detectedSummary(detected: DetectedUsbBoard): string {
  const family = canonicalChipFamily(detected.chipName);
  const parts = [family ? chipFamilyLabel(family) : detected.chipName || "Unknown chip"];
  if (detected.flashSizeMb !== null) parts.push(`${detected.flashSizeMb} MB flash`);
  if (detected.psramSizeMb !== null) {
    parts.push(detected.psramSizeMb > 0 ? `${detected.psramSizeMb} MB PSRAM` : "no PSRAM");
  }
  return parts.join(" · ");
}

function statusRank(board: UsbIdentityBoardProfile): number {
  return (
    (board.firmware_status === "firmware_supported" ? 0 : 2) +
    (board.verification_status === "verified" ? 0 : 1)
  );
}

/**
 * Compares the connected hardware with the selected board, the firmware's own
 * requirements and the Board Library, and says which library boards fit.
 */
export function verifyUsbBoardIdentity<TBoard extends UsbIdentityBoardProfile>(params: {
  detected: DetectedUsbBoard;
  selectedBoard: TBoard | null | undefined;
  /** Board Library profiles to recommend from (catalog and custom boards). */
  candidateBoards?: TBoard[];
  firmware?: UsbFirmwareRequirement | null;
}): UsbBoardIdentityReport<TBoard> {
  const { detected } = params;
  const selectedBoard = params.selectedBoard ?? null;
  const detectedFamily = canonicalChipFamily(detected.chipName);
  const usb = describeUsbSerialInterface(detected.usbVendorId, detected.usbProductId);

  const mismatches: UsbBoardMismatch[] = [];
  let checks: UsbBoardCheck[] = [];

  if (selectedBoard) {
    const compared = compareWithProfile(detected, selectedBoard);
    mismatches.push(...compared.mismatches);
    checks = compared.checks;
  }

  // The firmware's own requirements apply with or without a selected board.
  const firmware = params.firmware ?? null;
  if (firmware) {
    const firmwareFamily = canonicalChipFamily(firmware.chipFamily);
    if (
      firmwareFamily &&
      detectedFamily &&
      firmwareFamily !== detectedFamily &&
      !mismatches.some((m) => m.code === "chip_family")
    ) {
      mismatches.push({
        code: "chip_family",
        severity: "critical",
        title: "Different chip",
        detail: `The connected board has an ${chipFamilyLabel(detectedFamily)} chip, but ${firmware.label} is built for ${chipFamilyLabel(firmwareFamily)}. It cannot start on this board.`,
      });
    }
    if (
      firmware.minFlashMb !== null &&
      detected.flashSizeMb !== null &&
      detected.flashSizeMb < firmware.minFlashMb &&
      !mismatches.some((m) => m.code === "flash_smaller")
    ) {
      mismatches.push({
        code: "flash_smaller",
        severity: "major",
        title: "Less flash memory",
        detail: `The connected board has ${detected.flashSizeMb} MB of flash, but ${firmware.label} needs ${firmware.minFlashMb} MB.`,
      });
    }
    if (!selectedBoard) {
      checks = [
        {
          key: "chip",
          label: "Chip",
          detected: detectedFamily ? chipFamilyLabel(detectedFamily) : "Not reported",
          expected: firmwareFamily ? chipFamilyLabel(firmwareFamily) : "Not specified",
          status: !firmwareFamily || !detectedFamily ? "unknown" : firmwareFamily === detectedFamily ? "match" : "mismatch",
        },
        {
          key: "flash",
          label: "Flash",
          detected: detected.flashSizeMb !== null ? `${detected.flashSizeMb} MB` : "Not reported",
          expected: firmware.minFlashMb !== null ? `${firmware.minFlashMb} MB or more` : "Not specified",
          status:
            firmware.minFlashMb === null || detected.flashSizeMb === null
              ? "unknown"
              : detected.flashSizeMb >= firmware.minFlashMb
                ? "match"
                : "mismatch",
        },
      ];
    }
  }

  // Which library boards fit what is connected?
  const scored = (params.candidateBoards ?? [])
    .filter((b) => b.chip_family && canonicalChipFamily(b.chip_family) === detectedFamily)
    .map((board) => {
      const compared = compareWithProfile(detected, board);
      const usbIdMatch =
        usb.kind === "vendor_usb" &&
        parseUsbHexId(board.usb_vid) === detected.usbVendorId &&
        parseUsbHexId(board.usb_pid) === detected.usbProductId;
      return { board, compared, usbIdMatch };
    })
    .sort((a, b) => {
      const sa = a.compared.mismatches.reduce((sum, m) => sum + SEVERITY_RANK[m.severity], 0);
      const sb = b.compared.mismatches.reduce((sum, m) => sum + SEVERITY_RANK[m.severity], 0);
      if (sa !== sb) return sa - sb;
      if (a.usbIdMatch !== b.usbIdMatch) return a.usbIdMatch ? -1 : 1;
      const ra = statusRank(a.board);
      const rb = statusRank(b.board);
      if (ra !== rb) return ra - rb;
      return boardLabel(a.board).localeCompare(boardLabel(b.board));
    });

  const exact = scored.filter((s) => s.compared.mismatches.length === 0);
  // An exact USB ID narrows several fitting boards down to the one that owns it.
  const exactByUsbId = exact.filter((s) => s.usbIdMatch);
  const exactPool = exactByUsbId.length > 0 ? exactByUsbId : exact;

  const sameBoard = (a: UsbIdentityBoardProfile, b: UsbIdentityBoardProfile) =>
    (a.id && b.id && a.id === b.id) || (Boolean(a.slug) && a.slug === b.slug);

  const recommendedSource = (exactPool.length > 0 ? exactPool : scored.slice(0, 2)).filter(
    (s) => !(selectedBoard && sameBoard(s.board, selectedBoard))
  );
  const recommended: Array<UsbBoardRecommendation<TBoard>> = recommendedSource.slice(0, 3).map((s) => ({
    board: s.board,
    label: boardLabel(s.board),
    exact: s.compared.mismatches.length === 0,
    differences: s.compared.mismatches.map((m) => m.title),
  }));

  const identified =
    !selectedBoard && mismatches.length === 0 && exactPool.length === 1 ? exactPool[0]!.board : null;

  const severity = worstSeverity(mismatches);
  const result: UsbBoardIdentityReport["result"] =
    mismatches.length > 0 ? "mismatch" : detectedFamily ? "match" : "unverified";

  const summary = detectedSummary(detected);
  const headline =
    result === "mismatch"
      ? `Board mismatch: connected ${summary}; selected ${boardLabel(selectedBoard)}. ${mismatches
          .map((m) => m.title)
          .join(", ")}.`
      : result === "match"
        ? selectedBoard
          ? `Connected board matches ${boardLabel(selectedBoard)} (${summary}).`
          : identified
            ? `Connected board identified as ${boardLabel(identified)} (${summary}).`
            : `Connected board is compatible with this firmware (${summary}).`
        : `Connected board could not be identified (${summary}).`;

  return {
    result,
    severity,
    detected: { ...detected, chipFamily: detectedFamily, usb, summary },
    selected: selectedBoard ? { board: selectedBoard, label: boardLabel(selectedBoard) } : null,
    checks,
    mismatches,
    recommended: result === "mismatch" ? recommended : [],
    identified,
    headline,
  };
}
