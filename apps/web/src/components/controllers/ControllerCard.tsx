import type { ReactNode } from "react";
import {
  boardSupportsEspNow,
  normalizeChipFamily as normalizeSharedChipFamily,
  type ChipFamily,
} from "@homecoreos/shared";
import {
  RiArrowLeftRightLine,
  RiCpuLine,
  RiDeleteBinLine,
  RiDoorOpenLine,
  RiEyeLine,
  RiFlashlightFill,
  RiLinkUnlinkM,
  RiMore2Fill,
  RiPenNibLine,
  RiRefreshLine,
  RiRestartLine,
  RiShieldCheckLine,
  RiWifiLine,
  RiWifiOffLine,
} from "@remixicon/react";
import { BoardVectorSvg } from "@/components/boards/BoardVectorSvg";
import { Badge } from "@/components/reui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { MagicCard } from "@/components/ui/magic-card";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/reui/dropdown-menu";
import { formatTimestamp } from "@/lib/timezone";
import type { BoardProfileItem, ControllerItem } from "@/features/types";

export type ControllerCardAction = "disconnect" | "reconnect" | "restart" | "reset";

type BadgeVariant =
  | "primary-light"
  | "success-light"
  | "warning-light"
  | "destructive-light"
  | "secondary";

/**
 * Pairing state shared by the controller card and the details dialog.
 */
export function controllerPairingBadge(ctrl: ControllerItem): {
  label: string;
  variant: BadgeVariant;
} {
  const state = ctrl.pairing_status ?? (ctrl.paired_at ? "paired" : "pending");
  if (state === "paired") return { label: "Paired", variant: "success-light" };
  if (state === "recovery_pending")
    return { label: "Recovery Pending", variant: "warning-light" };
  if (state === "revoked") return { label: "Revoked", variant: "destructive-light" };
  return { label: "Pending Pairing", variant: "primary-light" };
}

function controllerStatusBadge(status: ControllerItem["status"]): {
  label: string;
  variant: BadgeVariant;
} {
  switch (status) {
    case "online":
      return { label: "Online", variant: "success-light" };
    case "pending":
      return { label: "Pending", variant: "warning-light" };
    case "updating":
      return { label: "Updating", variant: "warning-light" };
    case "reset_pending":
      return { label: "Reset Pending", variant: "warning-light" };
    case "disconnected":
      return { label: "Disconnected", variant: "destructive-light" };
    default:
      return { label: "Offline", variant: "destructive-light" };
  }
}

/**
 * Normalises whatever chip identifier a controller reports ("ESP32-S3",
 * "esp32s3", "ESP32 C6 DevKit", ...) into a catalog chip family so a board
 * drawing can always be rendered, even for boards missing from the library.
 */
export function normalizeChipFamily(raw: string | null | undefined): ChipFamily {
  return normalizeSharedChipFamily(raw) ?? "esp32";
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

/** One label/value row of the card's fixed column grid (Board Library scale). */
export function CardRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="contents">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="flex h-5 min-w-0 items-center font-medium text-foreground">
        {children}
      </dd>
    </div>
  );
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
  /** Opens the rename dialog for this Controller. */
  onRename: () => void;
  onRecover: () => void;
  onConfigureWifi: () => void;
  onAssignRoom: () => void;
  onAction: (action: ControllerCardAction) => void;
  onMoveToTrash: () => void;
  /**
   * Turns this Controller into a Node. Kept as an explicit, separate action: a
   * Controller that hosts Nodes must warn about them first.
   */
  onMakeNode?: () => void;
}

/**
 * User-console controller card, built at the same scale and anatomy as the
 * Board Library cards so both grids read as one family: the board-map stage on
 * top (dotted `.hc-dot-grid` panel with the vector drawing of the controller's
 * selected board, room chip and firmware version badge overlaid in its
 * corners), then the name with its kebab menu, the board model on a lightning
 * row, five label/value rows on the shared column grid (Status, Wi-Fi, MQTT,
 * Pairing, Last Seen) using system Badges, an optional connection-error strip,
 * and the outlined primary Details button pinned to the bottom.
 *
 * The version badge turns destructive-light whenever the running firmware is
 * older than the newest compatible published release.
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
  onRename,
  onRecover,
  onConfigureWifi,
  onAssignRoom,
  onAction,
  onMoveToTrash,
  onMakeNode,
}: ControllerCardProps) {
  const status = controllerStatusBadge(ctrl.status);
  const pairing = controllerPairingBadge(ctrl);
  const wifiUp = ctrl.wifi_connected ?? ctrl.status === "online";
  const lastSeenAt = ctrl.last_communication_at ?? ctrl.last_heartbeat_at;

  const currentVersion = ctrl.firmware_version
    ? `v${ctrl.firmware_version.replace(/^v/, "")}`
    : null;
  const updateTarget = updateVersion
    ? `v${updateVersion.replace(/^v/, "")}`
    : null;
  const firmwareOutdated = Boolean(updateTarget);

  const boardProfile = board ?? fallbackBoardProfile(ctrl);

  const wifiTitle = wifiUp
    ? `Wi-Fi Connected${ctrl.wifi_ssid ? ` · ${ctrl.wifi_ssid}` : ""}`
    : "Wi-Fi Disconnected";

  return (
    <Card className="group h-full overflow-hidden border-none bg-transparent p-0 shadow-none ring-0 transition-[transform,box-shadow] duration-200 hover:-translate-y-0.5 hover:shadow-md">
      <MagicCard
        mode="orb"
        spotlightTone="blue"
        className="h-full rounded-xl p-0"
        contentClassName="h-full"
      >
        <CardContent className="flex h-full flex-col p-0">
          <button
            type="button"
            onClick={onViewDetails}
            data-testid="controller-card-stage"
            aria-label={`View details for ${ctrl.name}`}
            className="hc-dot-grid relative flex h-40 w-full shrink-0 cursor-pointer items-center justify-center overflow-hidden rounded-t-xl border-b border-border/60 px-4 pb-3 pt-8 outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/70"
          >
            <BoardVectorSvg
              board={boardProfile}
              orientation="horizontal"
              compact={!board?.board_layout}
              className="h-full max-h-full w-full transition-transform duration-300 group-hover:scale-[1.03]"
            />
            <span className="pointer-events-none absolute inset-x-2 top-2 flex items-center justify-between gap-2">
              <Badge
                variant="secondary"
                size="sm"
                radius="full"
                className="max-w-[55%]"
                title={roomName ? `Assigned to ${roomName}` : "Not assigned to a room"}
              >
                <RiDoorOpenLine className="size-3 shrink-0 opacity-75" aria-hidden="true" />
                <span className="truncate">{roomName ?? "Unassigned"}</span>
              </Badge>
              <Badge
                variant={firmwareOutdated ? "destructive-light" : "secondary"}
                size="sm"
                radius="full"
                className="tabular-nums"
                title={
                  firmwareOutdated
                    ? `Firmware outdated: running ${currentVersion ?? "no firmware"}, ${updateTarget} available`
                    : currentVersion
                      ? `Firmware version ${currentVersion} (up to date)`
                      : "No firmware installed yet"
                }
              >
                {currentVersion ?? "No FW"}
              </Badge>
            </span>
          </button>

          <div className="flex flex-1 flex-col gap-3 p-3.5">
            <div className="min-w-0 space-y-0.5">
              <div className="flex min-w-0 items-center justify-between gap-1">
                <h3
                  className="min-w-0 truncate text-sm font-bold tracking-tight text-foreground"
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
                      className="shrink-0 text-muted-foreground hover:text-foreground"
                    >
                      <RiMore2Fill className="size-4" aria-hidden="true" />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent
                    align="end"
                    className="w-52"
                  >
                    <DropdownMenuItem onClick={onViewDetails}>
                      <RiEyeLine className="size-4" aria-hidden="true" />
                      View Details
                    </DropdownMenuItem>
                    {canManage && (
                      <DropdownMenuItem onClick={onRename}>
                        <RiPenNibLine className="size-4" aria-hidden="true" />
                        Edit name
                      </DropdownMenuItem>
                    )}
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
                    {canManage && onMakeNode && (!board || boardSupportsEspNow(board)) && (
                      <DropdownMenuItem onClick={onMakeNode}>
                        <RiArrowLeftRightLine className="size-4" aria-hidden="true" />
                        Make this a Node
                      </DropdownMenuItem>
                    )}
                    {canManage && <DropdownMenuSeparator />}
                    {canManage && ctrl.status === "online" && (
                      <DropdownMenuItem
                        variant="destructive"
                        onClick={() => onAction("reset")}
                      >
                        <RiRestartLine className="size-4" aria-hidden="true" />
                        Reset Controller
                      </DropdownMenuItem>
                    )}
                    {canManage && (
                      <DropdownMenuItem
                        variant="destructive"
                        onClick={onMoveToTrash}
                      >
                        <RiDeleteBinLine className="size-4" aria-hidden="true" />
                        Move to Trash
                      </DropdownMenuItem>
                    )}
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
              <p
                className="flex min-w-0 items-center gap-1 text-[11px] font-medium text-primary"
                title={`${ctrl.board_model} · ${ctrl.chip_variant}`}
              >
                <RiFlashlightFill
                  className="size-3 shrink-0 text-foreground/80"
                  aria-hidden="true"
                />
                <span className="truncate">{ctrl.board_model}</span>
              </p>
            </div>

            <dl className="grid grid-cols-[4.25rem_minmax(0,1fr)] items-center gap-x-3 gap-y-1.5 text-xs">
              <CardRow label="Role">
                <Badge
                  variant="primary-light"
                  size="xs"
                  radius="full"
                  data-testid="controller-role-badge"
                  title="Operating role assigned in the console. This board can be switched to a Node at any time."
                >
                  <RiCpuLine className="size-3" aria-hidden="true" />
                  Controller
                </Badge>
              </CardRow>
              <CardRow label="Status">
                <Badge variant={status.variant} size="xs" radius="full">
                  {status.label}
                </Badge>
              </CardRow>
              <CardRow label="Wi-Fi">
                <Badge
                  variant={wifiUp ? "success-light" : "secondary"}
                  size="xs"
                  title={wifiTitle}
                >
                  {wifiUp ? (
                    <RiWifiLine className="size-3" aria-hidden="true" />
                  ) : (
                    <RiWifiOffLine className="size-3" aria-hidden="true" />
                  )}
                  {wifiUp ? "Wi-Fi Connected" : "Wi-Fi Disconnected"}
                </Badge>
              </CardRow>
              <CardRow label="MQTT">
                <Badge
                  variant={ctrl.mqtt_connected ? "success-light" : "secondary"}
                  size="xs"
                >
                  {ctrl.mqtt_connected ? "MQTT Connected" : "MQTT Disconnected"}
                </Badge>
              </CardRow>
              <CardRow label="Pairing">
                <Badge variant={pairing.variant} size="xs">
                  {pairing.label}
                </Badge>
              </CardRow>
              <CardRow label="Nodes">
                <Badge
                  variant={(ctrl.connected_node_count ?? 0) > 0 ? "primary-light" : "secondary"}
                  size="xs"
                  radius="full"
                  title={
                    (ctrl.connected_node_count ?? 0) > 0
                      ? `${ctrl.connected_node_count} Node(s) hosted over ESP-NOW`
                      : "No Nodes hosted yet"
                  }
                >
                  {ctrl.connected_node_count ?? 0} linked
                </Badge>
              </CardRow>
              <CardRow label="Last Seen">
                <span
                  className="truncate font-semibold tabular-nums text-foreground"
                  title={formatTimestamp(lastSeenAt, timezone)}
                >
                  {formatTimestamp(lastSeenAt, timezone)}
                </span>
              </CardRow>
            </dl>

            {ctrl.last_error && (
              <div className="rounded-lg border border-destructive/30 bg-destructive/8 px-2 py-1.5 text-[11px] leading-snug text-destructive">
                <span className="font-semibold">Connection Error: </span>
                <span className="line-clamp-2 break-words [overflow-wrap:anywhere]">
                  {ctrl.last_error}
                </span>
              </div>
            )}

            <div className="mt-auto flex items-center gap-2 border-t border-border/60 pt-3">
              <Button
                variant="outline"
                size="sm"
                className="h-8 flex-1 border-primary/55 text-xs font-semibold text-primary hover:bg-primary/10 hover:text-primary"
                onClick={onViewDetails}
              >
                Details
              </Button>
            </div>
          </div>
        </CardContent>
      </MagicCard>
    </Card>
  );
}
