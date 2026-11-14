import { useState, type ReactNode } from "react";
import {
  chipFamilyLabel,
  displayBoardRevision,
  resolveBoardHardwareSpecs,
  supportsBleProvisioningForBoard,
} from "@homecoreos/shared";
import { RiExternalLinkLine, RiShieldCheckLine } from "@remixicon/react";
import { formatTimestamp, useEffectiveTimezone } from "@/lib/timezone";
import { countOnBoardOnlyGpios, describeBoardPins } from "@/components/boards/BoardLibraryCard";
import { BoardVectorSvg } from "@/components/boards/BoardVectorSvg";
import { InteractiveBoardPinout } from "@/components/boards/InteractiveBoardPinout";
import { Badge } from "@/components/reui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import type { BoardProfileItem } from "@/features/types";

const FIRMWARE_LABELS: Record<string, string> = {
  firmware_supported: "Firmware supported",
  catalog_only: "Catalog only (no firmware yet)",
  build_pending: "Firmware build pending",
  unsupported: "Not supported by firmware",
};

type Field = { label: string; value: ReactNode; wide?: boolean };

function has(value: unknown): boolean {
  return value !== null && value !== undefined && value !== "";
}

/** A titled group of label/value pairs. Empty values are left out. */
function FieldGroup({ title, fields }: { title: string; fields: Field[] }) {
  const shown = fields.filter((field) => has(field.value));
  if (shown.length === 0) return null;
  return (
    <section className="space-y-1.5">
      <h4 className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
        {title}
      </h4>
      <dl className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
        {shown.map((field) => (
          <div
            key={field.label}
            className={
              field.wide
                ? "rounded-lg border bg-muted/30 px-3 py-2 sm:col-span-2 xl:col-span-3"
                : "rounded-lg border bg-muted/30 px-3 py-2"
            }
          >
            <dt className="text-[11px] text-muted-foreground">{field.label}</dt>
            <dd className="mt-0.5 break-words text-sm font-medium text-foreground">{field.value}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

function ResourceLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className="inline-flex items-center justify-between gap-2 rounded-md border px-2.5 py-1.5 text-xs font-medium text-foreground transition-colors hover:bg-muted"
    >
      {children}
      <RiExternalLinkLine className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
    </a>
  );
}

function BoardDetailsBody({ board }: { board: BoardProfileItem }) {
  const timezone = useEffectiveTimezone();
  const [photoFailed, setPhotoFailed] = useState(false);
  const specs = resolveBoardHardwareSpecs(board);
  const layout = board.board_layout;
  const isCustom = board.catalog_category === "custom" || !board.catalog_category;
  const sourceLabel =
    board.catalog_category === "partner"
      ? "Partner board"
      : board.catalog_category === "official_espressif"
        ? "Official Espressif board"
        : "Custom board";
  const usbId =
    board.usb_vid && board.usb_pid ? `${board.usb_vid}:${board.usb_pid}` : (board.usb_vid ?? null);
  const onboard = (layout?.onboardFeatures ?? []).map((f) =>
    f.gpioPin === null ? f.label : `${f.label} (GPIO${f.gpioPin})`
  );
  const onBoardOnly = countOnBoardOnlyGpios(board);
  const showPhoto = Boolean(board.image_url) && !photoFailed;
  const resources = [
    board.docs_url ? { href: board.docs_url, label: "Documentation" } : null,
    board.datasheet_url ? { href: board.datasheet_url, label: "Datasheet" } : null,
    board.pinout_image_url
      ? { href: board.pinout_image_url, label: "Official pinout diagram" }
      : null,
    board.source_url && board.source_url !== board.docs_url
      ? { href: board.source_url, label: "Source page" }
      : null,
  ].filter((r): r is { href: string; label: string } => r !== null);

  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,15rem)_minmax(0,1fr)]">
      <aside className="space-y-3">
        <div
          className={
            showPhoto
              ? "flex h-44 items-center justify-center overflow-hidden rounded-xl border bg-white p-2"
              : "flex h-44 items-center justify-center overflow-hidden rounded-xl border bg-[#0b0e12] p-3"
          }
        >
          {showPhoto ? (
            // The maker's own product photo, loaded only when the details are opened.
            <img
              src={board.image_url!}
              alt={`Official photo of ${board.manufacturer} ${board.model}`}
              loading="lazy"
              decoding="async"
              referrerPolicy="no-referrer"
              onError={() => setPhotoFailed(true)}
              className="max-h-full max-w-full object-contain"
            />
          ) : (
            <BoardVectorSvg board={board} orientation="horizontal" className="h-full w-full" />
          )}
        </div>
        <div className="flex flex-wrap gap-1.5">
          <Badge variant="outline" size="xs">
            {sourceLabel}
          </Badge>
          {!isCustom && board.verification_status === "verified" && (
            <Badge variant="success-light" size="xs">
              <RiShieldCheckLine className="size-3" aria-hidden="true" />
              Verified pinout
            </Badge>
          )}
          {board.verification_status === "needs_verification" && (
            <Badge variant="warning-light" size="xs">
              Needs verification
            </Badge>
          )}
        </div>
        {board.description && (
          <p className="text-xs leading-relaxed text-muted-foreground">{board.description}</p>
        )}
        {resources.length > 0 && (
          <div className="space-y-1.5">
            <h4 className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
              Official resources
            </h4>
            <div className="flex flex-col gap-1.5">
              {resources.map((resource) => (
                <ResourceLink key={resource.label} href={resource.href}>
                  {resource.label}
                </ResourceLink>
              ))}
            </div>
          </div>
        )}
      </aside>

      <div className="min-w-0 space-y-4">
        <FieldGroup
          title="Overview"
          fields={[
            { label: "Manufacturer", value: board.manufacturer },
            { label: "Model", value: board.model },
            {
              label: "Revision",
              value: displayBoardRevision(board.revision) ?? "Not stated by the maker",
            },
            { label: "Series", value: board.series },
          ]}
        />
        <FieldGroup
          title="Chip and memory"
          fields={[
            { label: "Chip", value: board.chip_variant },
            { label: "Chip family", value: chipFamilyLabel(board.chip_family) },
            { label: "Processor", value: specs.processor },
            { label: "Flash size", value: `${board.flash_size_mb} MB` },
            {
              label: "PSRAM size",
              value: board.psram_size_mb > 0 ? `${board.psram_size_mb} MB` : "None",
            },
          ]}
        />
        <FieldGroup
          title="Connectivity"
          fields={[
            { label: "Wireless", value: specs.wireless },
            { label: "USB", value: specs.usb },
            { label: "USB ID", value: usbId },
            { label: "Buttons", value: specs.buttons },
            {
              label: "Boot button",
              value: typeof board.boot_button_gpio === "number" ? `GPIO${board.boot_button_gpio}` : null,
            },
            {
              label: "Wi-Fi setup",
              value:
                board.supports_wifi === false
                  ? "No Wi-Fi radio"
                  : supportsBleProvisioningForBoard(board).supportsBle
                    ? "Bluetooth LE or setup access point"
                    : "Setup access point only",
            },
            { label: "Connectivity notes", value: board.connectivity_note, wide: true },
          ]}
        />
        <FieldGroup
          title="Pins"
          fields={[
            // "GPIO pins" are the ones that can be wired; some of them are still
            // restricted (boot strapping, USB), which the Pinout tab shows per pin.
            { label: "GPIO pins", value: describeBoardPins(board) },
            // The profile also lists GPIOs that never reach a pin (LED, BOOT
            // button). Saying so keeps the two numbers from looking contradictory.
            {
              label: "GPIO in the profile",
              value:
                onBoardOnly > 0
                  ? `${board.gpio_definitions.length}, of which ${onBoardOnly} on-board only`
                  : board.gpio_definitions.length,
            },
            {
              label: layout?.extraPads?.name ?? "Extra pads",
              value: layout?.extraPads
                ? layout.extraPads.pins.map((pin) => pin.pinName).join(", ")
                : null,
              wide: true,
            },
            { label: "On-board parts", value: onboard.length > 0 ? onboard.join(", ") : null, wide: true },
          ]}
        />
        <FieldGroup
          title="Firmware"
          fields={[
            {
              label: "Firmware status",
              value: FIRMWARE_LABELS[board.firmware_status ?? "catalog_only"] ?? board.firmware_status,
            },
            { label: "Compatibility key", value: board.firmware_compat_key },
            { label: "Partition scheme", value: board.partition_scheme },
            { label: "PSRAM mode", value: board.psram_mode },
            { label: "Flash mode", value: board.flash_mode },
            { label: "Flash frequency", value: board.flash_freq },
            { label: "Bootloader offset", value: board.bootloader_offset },
            { label: "OTA app offset", value: board.ota_app_offset },
          ]}
        />
        <FieldGroup
          title="Record"
          fields={[
            { label: "Source", value: board.source_provider },
            {
              label: "Last checked",
              value: board.last_synced_at ? formatTimestamp(board.last_synced_at, timezone) : null,
            },
            { label: "Revision notes", value: board.revision_notes, wide: true },
          ]}
        />
      </div>
    </div>
  );
}

/**
 * Everything about one board that does not fit on its library card: the full
 * specification grouped by topic, and the interactive pinout.
 */
export function BoardDetailsDialog({
  board,
  onClose,
}: {
  /** The board to show; null keeps the dialog closed. */
  board: BoardProfileItem | null;
  onClose: () => void;
}) {
  return (
    <Dialog open={Boolean(board)} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[88vh] overflow-y-auto p-4 sm:max-w-4xl sm:p-5">
        <DialogHeader className="pb-1">
          <div className="flex flex-wrap items-center justify-between gap-2 pr-6">
            <div className="min-w-0">
              <DialogTitle className="break-words text-sm sm:text-base">
                {board?.manufacturer} {board?.model}
                {displayBoardRevision(board?.revision) &&
                  ` (${displayBoardRevision(board?.revision)})`}
              </DialogTitle>
              <DialogDescription className="text-xs">
                {board?.chip_variant} · {board?.flash_size_mb} MB Flash · {board?.psram_size_mb} MB
                PSRAM ·{" "}
                {board?.firmware_status === "firmware_supported"
                  ? "Firmware Supported"
                  : "Catalog Profile"}
              </DialogDescription>
            </div>
            {board?.docs_url && (
              <a
                href={board.docs_url}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 text-[11px] font-medium hover:bg-muted"
              >
                Docs
                <RiExternalLinkLine className="size-3" aria-hidden="true" />
              </a>
            )}
          </div>
        </DialogHeader>
        {board && (
          <Tabs defaultValue="details" key={board.id} className="space-y-4">
            <TabsList>
              <TabsTrigger value="details">Board details</TabsTrigger>
              <TabsTrigger value="pinout">Pinout details</TabsTrigger>
            </TabsList>
            <TabsContent value="details">
              <BoardDetailsBody board={board} />
            </TabsContent>
            <TabsContent value="pinout" className="space-y-3">
              <InteractiveBoardPinout board={board} />
              {board.pinout_image_url && (
                <p className="text-xs text-muted-foreground">
                  The maker's own diagram:{" "}
                  <a
                    href={board.pinout_image_url}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex items-center gap-0.5 font-medium text-primary hover:underline"
                  >
                    open the official pinout diagram
                    <RiExternalLinkLine className="size-3" aria-hidden="true" />
                  </a>
                </p>
              )}
            </TabsContent>
          </Tabs>
        )}
        <DialogFooter className="pt-1">
          <Button size="sm" onClick={onClose}>
            Close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
