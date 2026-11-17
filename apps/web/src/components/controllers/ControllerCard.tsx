import { SUPPORTED_CHIP_FAMILIES, type ChipFamily } from "@homecoreos/shared";
import {
  RiDeleteBinLine,
  RiDoorOpenLine,
  RiEyeLine,
  RiFlashlightFill,
  RiLinkUnlinkM,
  RiLink,
  RiMore2Fill,
  RiRefreshLine,
  RiRestartLine,
  RiShareForwardLine,
  RiShieldCheckLine,
  RiWifiLine,
  RiWifiOffLine,
} from "@remixicon/react";
import { BoardVectorSvg } from "@/components/boards/BoardVectorSvg";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { MagicCard } from "@/components/ui/magic-card";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  formatTimestamp,
} from "@/lib/timezone";
import type { BoardProfileItem, ControllerItem } from "@/features/types";

export type ControllerCardAction = "disconnect" | "reconnect" | "restart" | "reset";

/**
 * Pairing state chip shared by the controller card and the details dialog.
 */
export function controllerPairingBadge(ctrl: ControllerItem): {
  label: string;
  tone: "paired" | "pending" | "recovery" | "revoked";
} {
  const state = ctrl.pairing_status ?? (ctrl.paired_at ? "paired" : "pending");
  if (state === "paired") return { label: "Paired", tone: "paired" };
  if (state === "recovery_pending") return { label: "Recovery Pending", tone: "recovery" };
  if (state === "revoked") return { label: "Revoked", tone: "revoked" };
  return { label: "Pending Pairing", tone: "pending" };
}

function controllerStatusMeta(status: ControllerItem["status"]): {
  label: string;
  dotClass: string;
} {
  switch (status) {
    case "online":
      return { label: "Online", dotClass: "bg-green-500" };
    case "pending":
      return { label: "Pending", dotClass: "bg-amber-500" };
    case "updating":
      return { label: "Updating", dotClass: "bg-amber-500" };
    case "reset_pending":
      return { label: "Reset Pending", dotClass: "bg-amber-500" };
    case "disconnected":
      return { label: "Disconnected", dotClass: "bg-red-500" };
    default:
      return { label: "Offline", dotClass: "bg-red-500" };
  }
}

/**
 * Normalises whatever chip identifier a controller reports ("ESP32-S3",
 * "esp32s3", "ESP32 C6 DevKit", ...) into a catalog chip family so a board
 * drawing can always be rendered, even for boards missing from the library.
 */
export function normalizeChipFamily(raw: string | null | undefined): ChipFamily {
  const norm = (raw ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
  const families = SUPPORTED_CHIP_FAMILIES as readonly string[];
  if (families.includes(norm)) return norm as ChipFamily;
  const byPrefix = [...families]
    .sort((a, b) => b.length - a.length)
    .find((family) => family !== "esp32" && norm.startsWith(family));
  if (byPrefix) return byPrefix as ChipFamily;
  if (norm.startsWith("esp8266") || norm.startsWith("esp8285")) return "esp8266";
  return "esp32";
}

/**
 * Minimal stand-in profile so controllers whose board is not (or no longer)
 * in the Board Library still render a board map on their card.
 */
export function fallbackBoardProfile(ctrl: ControllerItem): BoardProfileItem {
  return {
    id: `controller-board-${ctrl.id}`,
    slug:
      ctrl.board_compat?.slug ??
      ctrl.reported_board_slug ??
      `controller-${ctrl.id}-board`,
    manufacturer: "Generic",
    model: ctrl.board_model,
    revision: "",
    chip_family: normalizeChipFamily(
      ctrl.board_compat?.chip_family ?? ctrl.chip_variant
    ),
    chip_variant: ctrl.chip_variant,
    flash_size_mb: ctrl.detected_flash_size_mb ?? ctrl.flash_size_mb,
    psram_size_mb: ctrl.psram_size_mb,
    gpio_definitions: [],
    board_layout: null,
  };
}

export interface ControllerCardProps {
  ctrl: ControllerItem;
  /** Resolved Board Library profile for the controller's selected board. */
  board: BoardProfileItem | null;
  roomName: string | null;
  /** Version of the newest compatible published OTA release, when one exists. */
  updateVersion: string | null;
  timezone: string;
  canManage: boolean;
  canOperate: boolean;
  onViewDetails: () => void;
  onRecover: () => void;
  onConfigureWifi: () => void;
  onAssignRoom: () => void;
  onAction: (action: ControllerCardAction) => void;
  onMoveToTrash: () => void;
}

/**
 * User-console controller card.
 *
 * Anatomy (top to bottom), uniform across the grid: a dotted stage holding the
 * vector board map of the controller's selected board with the room chip and
 * the firmware version badge overlaid in its corners, the controller name with
 * its kebab menu, the board model on a lightning row, one live-status row
 * (link state, Wi-Fi, MQTT, pairing), an optional connection-error strip, and a
 * footer with the timezone-aware last-seen stamp opposite the Details pill.
 */
export function ControllerCard({
  ctrl,
  board,
  roomName,
  updateVersion,
  timezone,
  canManage,
  canOperate,
  onViewDetails,
  onRecover,
  onConfigureWifi,
  onAssignRoom,
  onAction,
  onMoveToTrash,
}: ControllerCardProps) {
  const statusMeta = controllerStatusMeta(ctrl.status);
  const pairing = controllerPairingBadge(ctrl);
  const wifiUp = ctrl.wifi_connected ?? ctrl.status === "online";
  const lastSeenAt = ctrl.last_communication_at ?? ctrl.last_heartbeat_at;

  const currentVersion = ctrl.firmware_version
    ? `v${ctrl.firmware_version.replace(/^v/, "")}`
    : null;
  const updateTarget = updateVersion
    ? `v${updateVersion.replace(/^v/, "")}`
    : null;

  const boardProfile = board ?? fallbackBoardProfile(ctrl);

  const wifiTitle = wifiUp
    ? `Wi-Fi Connected${ctrl.wifi_ssid ? ` · ${ctrl.wifi_ssid}` : ""}`
    : "Wi-Fi Disconnected";

  return (
    <Card
      role="button"
      tabIndex={0}
      aria-label={`View details for ${ctrl.name}`}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onViewDetails();
        }
      }}
      className="group h-full cursor-pointer overflow-hidden rounded-2xl border-none bg-card p-0 shadow-sm ring-0 transition-[transform,box-shadow] duration-200 hover:-translate-y-0.5 hover:shadow-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      onClick={onViewDetails}
    >
      <MagicCard
        mode="orb"
        spotlightTone="blue"
        className="h-full rounded-2xl p-0"
        contentClassName="h-full"
      >
      <div className="flex h-full flex-col gap-3.5 p-4">
        {/* Board-map stage */}
        <div
          data-testid="controller-card-stage"
          className="hc-dot-grid relative h-44 w-full shrink-0 overflow-hidden rounded-xl"
        >
          <BoardVectorSvg
            board={boardProfile}
            orientation="horizontal"
            compact={!board?.board_layout}
            className="h-full w-full px-3 pb-1 pt-4 transition-transform duration-300 group-hover:scale-[1.03]"
          />
          <span
            className="pointer-events-none absolute left-2 top-2 inline-flex max-w-[55%] items-center gap-1 rounded-md border border-border/70 bg-card/85 px-1.5 py-0.5 text-[10px] font-semibold text-foreground/80 backdrop-blur-sm dark:border-transparent dark:bg-white/10 dark:text-white/90"
            title={roomName ? `Assigned to ${roomName}` : "Not assigned to a room"}
          >
            <RiDoorOpenLine className="size-3 shrink-0 opacity-75" aria-hidden="true" />
            <span className="truncate">{roomName ?? "Unassigned"}</span>
          </span>
          <span
            className={`pointer-events-none absolute right-2 top-2 inline-flex items-center rounded-full px-3.5 py-1 text-sm font-bold tabular-nums shadow-sm ${
              updateTarget
                ? "bg-red-100 text-red-700 dark:bg-red-500/15 dark:text-red-300"
                : "bg-slate-200/80 text-slate-800 dark:bg-white/10 dark:text-white/90"
            }`}
            title={
              updateTarget
                ? `Firmware update available: ${currentVersion ?? "no firmware"} → ${updateTarget}`
                : currentVersion
                  ? `Firmware version ${currentVersion}`
                  : "No firmware installed yet"
            }
          >
            {updateTarget ?? currentVersion ?? "No FW"}
          </span>
        </div>

        {/* Name + kebab */}
        <div className="flex min-w-0 items-center justify-between gap-2">
          <h3
            className="min-w-0 truncate text-lg font-bold tracking-tight text-foreground"
            title={ctrl.name}
          >
            {ctrl.name}
          </h3>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                aria-label={`Actions for ${ctrl.name}`}
                onClick={(e) => e.stopPropagation()}
                onKeyDown={(e) => e.stopPropagation()}
                className="shrink-0 text-foreground/70 hover:text-foreground"
              >
                <RiMore2Fill className="size-4" aria-hidden="true" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent
              align="end"
              className="w-52"
              onClick={(e) => e.stopPropagation()}
            >
              <DropdownMenuItem onClick={onViewDetails}>
                <RiEyeLine className="size-4" aria-hidden="true" />
                View Details
              </DropdownMenuItem>
              {canManage && (
                <DropdownMenuItem onClick={onRecover}>
                  <RiShieldCheckLine className="size-4" aria-hidden="true" />
                  Recover / Re-pair
                </DropdownMenuItem>
              )}
              {canManage && (
                <DropdownMenuItem onClick={onConfigureWifi}>
                  <RiWifiLine className="size-4" aria-hidden="true" />
                  Configure Wi-Fi
                </DropdownMenuItem>
              )}
              {canManage && (
                <DropdownMenuItem onClick={onAssignRoom}>
                  <RiDoorOpenLine className="size-4" aria-hidden="true" />
                  Assign to Room
                </DropdownMenuItem>
              )}
              {canOperate && ctrl.status === "online" && (
                <>
                  <DropdownMenuItem onClick={() => onAction("restart")}>
                    <RiRestartLine className="size-4" aria-hidden="true" />
                    Restart
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={() => onAction("disconnect")}>
                    <RiLinkUnlinkM className="size-4" aria-hidden="true" />
                    Disconnect
                  </DropdownMenuItem>
                </>
              )}
              {canOperate && ctrl.status !== "online" && ctrl.mqtt && (
                <DropdownMenuItem onClick={() => onAction("reconnect")}>
                  <RiRefreshLine className="size-4" aria-hidden="true" />
                  Reconnect
                </DropdownMenuItem>
              )}
              {canManage && <DropdownMenuSeparator />}
              {canManage && ctrl.status === "online" && (
                <DropdownMenuItem variant="destructive" onClick={() => onAction("reset")}>
                  <RiRestartLine className="size-4" aria-hidden="true" />
                  Reset Controller
                </DropdownMenuItem>
              )}
              {canManage && (
                <DropdownMenuItem variant="destructive" onClick={onMoveToTrash}>
                  <RiDeleteBinLine className="size-4" aria-hidden="true" />
                  Move to Trash
                </DropdownMenuItem>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>

        {/* Board model */}
        <p
          className="flex min-w-0 items-center gap-1.5 text-[15px] font-medium text-primary"
          title={`${ctrl.board_model} · ${ctrl.chip_variant}`}
        >
          <RiFlashlightFill
            className="size-4 shrink-0 text-foreground/85"
            aria-hidden="true"
          />
          <span className="truncate">{ctrl.board_model}</span>
        </p>

        {/* Live status row */}
        <div className="flex min-w-0 flex-wrap items-center justify-between gap-x-3 gap-y-2">
          <span className="inline-flex items-center gap-1.5 text-[13px] font-medium text-foreground/85">
            <span
              className={`size-3 shrink-0 rounded-full ${statusMeta.dotClass}`}
              aria-hidden="true"
            />
            {statusMeta.label}
          </span>
          <span
            className="inline-flex items-center gap-1.5 text-[13px] font-medium text-foreground/85"
            title={wifiTitle}
          >
            {wifiUp ? (
              <RiWifiLine className="size-4.5 shrink-0 text-blue-500" aria-hidden="true" />
            ) : (
              <RiWifiOffLine
                className="size-4.5 shrink-0 text-muted-foreground"
                aria-hidden="true"
              />
            )}
            Wi-Fi
          </span>
          <span
            className="inline-flex min-w-0 items-center gap-1.5 text-[13px] font-medium text-foreground/85"
            title={ctrl.mqtt_connected ? "MQTT Connected" : "MQTT Disconnected"}
          >
            <RiShareForwardLine
              className={`size-4.5 shrink-0 ${
                ctrl.mqtt_connected ? "text-emerald-600 dark:text-emerald-400" : "text-orange-600 dark:text-orange-400"
              }`}
              aria-hidden="true"
            />
            <span className="min-w-0 leading-tight">
              {ctrl.mqtt_connected ? "MQTT Connected" : "MQTT Disconnected"}
            </span>
          </span>
          <span
            className="inline-flex items-center gap-1.5 text-[13px] font-medium text-foreground/85"
            title={pairing.label}
          >
            <RiLink
              className={`size-4.5 shrink-0 ${
                pairing.tone === "paired"
                  ? "text-violet-600 dark:text-violet-400"
                  : pairing.tone === "revoked"
                    ? "text-destructive"
                    : "text-violet-400 dark:text-violet-300"
              }`}
              aria-hidden="true"
            />
            {pairing.label}
          </span>
        </div>

        {/* Connection error strip (only when the controller reported one) */}
        {ctrl.last_error && (
          <div className="rounded-lg border border-destructive/30 bg-destructive/8 px-2.5 py-1.5 text-[11px] leading-snug text-destructive">
            <span className="font-semibold">Connection Error: </span>
            <span className="line-clamp-2 break-words [overflow-wrap:anywhere]">
              {ctrl.last_error}
            </span>
          </div>
        )}

        {/* Footer: last seen + details */}
        <div className="mt-auto flex min-w-0 items-center justify-between gap-3 pt-1">
          <p className="min-w-0 truncate text-[13px]">
            <span className="font-medium text-primary">Last Seen : </span>
            <span className="font-medium tabular-nums text-foreground/90">
              {formatTimestamp(lastSeenAt, timezone)}
            </span>
          </p>
          <Button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onViewDetails();
            }}
            className="h-10 shrink-0 rounded-full bg-purple-800 px-7 text-sm font-semibold text-white shadow-sm hover:bg-purple-700 hover:text-white dark:bg-purple-700 dark:hover:bg-purple-600"
          >
            Details
          </Button>
        </div>
      </div>
      </MagicCard>
    </Card>
  );
}
