import {
  RiArrowLeftRightLine,
  RiCpuLine,
  RiEyeLine,
  RiFileListLine,
  RiFlashlightFill,
  RiLinksLine,
  RiLinkM,
  RiMore2Fill,
  RiPenNibLine,
  RiRadioLine,
  RiWifiLine,
} from "@remixicon/react";
import { Badge } from "@/components/reui/badge";
import { BoardVectorSvg } from "@/components/boards/BoardVectorSvg";
import { Card, CardContent } from "@/components/ui/card";
import { CardRow, fallbackBoardProfile } from "@/components/controllers/ControllerCard";
import { MagicCard } from "@/components/ui/magic-card";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/reui/dropdown-menu";
import {
  boardSupportsControllerRole,
  deviceStatusLabel,
  getBoardCapabilities,
  nodeCommModeLabel,
  supportsRole,
  userConnectionStatus,
  type UserConnectionStatus,
} from "@homecoreos/shared";
import { formatTimestamp } from "@/lib/timezone";
import type { BoardProfileItem, ControllerItem } from "@/features/types";

type BadgeVariant =
  | "primary-light"
  | "success-light"
  | "warning-light"
  | "destructive-light"
  | "secondary";

/** `linked` | `controller_lost` | `reconnecting` | `standalone` | `unassigned` */
export function nodeStatusBadge(node: ControllerItem, online: boolean): {
  label: string;
  variant: BadgeVariant;
} {
  const link = node.node_link_state ?? (node.assigned_controller_id ? "reconnecting" : "unassigned");
  if (!online) return { label: "Offline", variant: "secondary" };
  if (link === "linked") return { label: "Linked", variant: "success-light" };
  if (link === "controller_lost" || link === "reconnecting") {
    return { label: "Reconnecting", variant: "warning-light" };
  }
  if (link === "unassigned") {
    return { label: "No Controller", variant: "warning-light" };
  }
  return { label: "Standalone", variant: "primary-light" };
}

function statusFromUserLabel(
  label: UserConnectionStatus,
  online: boolean
): { label: string; variant: BadgeVariant } {
  if (label === "Device not supported for this connection method") {
    return { label: "Not supported", variant: "destructive-light" };
  }
  if (label === "Connected directly" || label === "Connected through Controller") {
    return { label, variant: "success-light" };
  }
  if (label === "Reconnecting automatically" || label === "Local connection active") {
    return { label, variant: "warning-light" };
  }
  if (!online) return { label: "Offline", variant: "secondary" };
  return { label: "Cloud unavailable", variant: "destructive-light" };
}

/**
 * A Node is a full HomecoreOS device that runs the same firmware in Node mode:
 * it owns its switches and sensors and reaches the cloud through its Controller
 * over ESP-NOW.
 *
 * The card is built at the same scale and anatomy as the Controller card — the
 * board-map stage with its corner badges, the name with its kebab menu, the
 * board model on a lightning row, label/value rows on the shared column grid
 * and the Details button pinned to the bottom. Only the rows differ: a Node
 * reports its Controller, its ESP-NOW link and its last activity instead of
 * Wi-Fi, MQTT and pairing.
 */
export function NodeCard({
  node,
  board,
  canManage,
  canOperate,
  timezone,
  onViewDetails,
  onViewLog,
  onRename,
  onAssignController,
  onRelink,
  onPromote,
}: {
  node: ControllerItem;
  board: BoardProfileItem | null;
  canManage: boolean;
  canOperate: boolean;
  timezone: string;
  onViewDetails: () => void;
  /** Opens the per-board live Log for this Node. */
  onViewLog: () => void;
  onRename: () => void;
  onAssignController: () => void;
  onRelink: () => void;
  onPromote: () => void;
}) {
  const online = node.status === "online";
  const boardProfile = board ?? fallbackBoardProfile(node);
  const boardId = boardProfile.slug;
  const liveStatus: UserConnectionStatus =
    (node.connection_status as UserConnectionStatus | undefined) ??
    userConnectionStatus({
      boardId,
      role: node.board_role ?? "node",
      bindingState: node.binding_state,
      espnowState:
        node.node_link_state === "linked"
          ? "linked"
          : node.node_link_state === "controller_lost"
            ? "lost"
            : node.node_link_state === "reconnecting"
              ? "reconnecting"
              : node.node_link_state === "standalone"
                ? "searching"
                : "unavailable",
      cloudRoute: node.cloud_route,
      online,
      localActive: true,
    });
  const status = statusFromUserLabel(liveStatus, online);
  const commMode = node.node_comm_mode ?? (online ? null : "offline");
  const headline = deviceStatusLabel({
    role: "node",
    online,
    commMode,
    linkState: node.node_link_state ?? null,
    assignedControllerName: node.assigned_controller_name ?? null,
  });
  const needsController = !node.assigned_controller_id;
  // A board without a usable 2.4 GHz radio can never act as a Controller. An
  // unknown (e.g. custom) board profile is not blocked here — the Worker applies
  // the same gate authoritatively.
  const registryBoard = getBoardCapabilities(boardId);
  const canBecomeController = registryBoard
    ? supportsRole(boardId, "controller")
    : !board || boardSupportsControllerRole(board);
  const lastActivityAt = node.last_communication_at ?? node.last_heartbeat_at;
  const firmwareLabel = node.firmware_version
    ? `v${node.firmware_version.replace(/^v/, "")}`
    : null;

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
            data-testid="node-card-stage"
            aria-label={`View details for ${node.name}`}
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
                data-testid="node-role-badge"
                title="Operating role assigned in the console. This board can be switched to a Controller at any time."
              >
                <RiRadioLine className="size-3 shrink-0 opacity-75" aria-hidden="true" />
                <span className="truncate">Node</span>
              </Badge>
              <Badge
                variant="secondary"
                size="sm"
                radius="full"
                className="tabular-nums"
                title={
                  firmwareLabel
                    ? `Firmware version ${firmwareLabel}`
                    : "No firmware version reported yet"
                }
              >
                {firmwareLabel ?? "No FW"}
              </Badge>
            </span>
          </button>

          <div className="flex flex-1 flex-col gap-3 p-3.5">
            <div className="min-w-0 space-y-0.5">
              <div className="flex min-w-0 items-center justify-between gap-1">
                <h3
                  className="min-w-0 truncate text-sm font-bold tracking-tight text-foreground"
                  title={node.name}
                >
                  {node.name}
                </h3>
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-xs"
                      aria-label={`Actions for ${node.name}`}
                      className="shrink-0 text-muted-foreground hover:text-foreground"
                    >
                      <RiMore2Fill className="size-4" aria-hidden="true" />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end" className="w-56">
                    <DropdownMenuItem onClick={onViewDetails}>
                      <RiEyeLine className="size-4" aria-hidden="true" />
                      View Details
                    </DropdownMenuItem>
                    <DropdownMenuItem onClick={onViewLog}>
                      <RiFileListLine className="size-4" aria-hidden="true" />
                      View Log
                    </DropdownMenuItem>
                    {canManage && (
                      <DropdownMenuItem onClick={onRename}>
                        <RiPenNibLine className="size-4" aria-hidden="true" />
                        Edit name
                      </DropdownMenuItem>
                    )}
                    {canManage && (
                      <DropdownMenuItem onClick={onAssignController}>
                        <RiLinksLine className="size-4" aria-hidden="true" />
                        {needsController ? "Assign Controller" : "Change Controller"}
                      </DropdownMenuItem>
                    )}
                    {canOperate && (
                      <DropdownMenuItem onClick={onRelink} disabled={needsController}>
                        <RiLinkM className="size-4" aria-hidden="true" />
                        Re-link to Controller
                      </DropdownMenuItem>
                    )}
                    {canManage && canBecomeController && (
                      <>
                        <DropdownMenuSeparator />
                        <DropdownMenuItem onClick={onPromote}>
                          <RiArrowLeftRightLine className="size-4" aria-hidden="true" />
                          Make this a Controller
                        </DropdownMenuItem>
                      </>
                    )}
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
              <p
                className="flex min-w-0 items-center gap-1 text-[11px] font-medium text-primary"
                title={`${node.board_model} · ${node.chip_variant}`}
              >
                <RiFlashlightFill
                  className="size-3 shrink-0 text-foreground/80"
                  aria-hidden="true"
                />
                <span className="truncate">{node.board_model}</span>
              </p>
              <p
                className="truncate text-[11px] text-muted-foreground"
                title={headline}
                data-testid="node-status-line"
              >
                {headline}
              </p>
            </div>

            <dl className="grid grid-cols-[4.25rem_minmax(0,1fr)] items-center gap-x-3 gap-y-1.5 text-xs">
              <CardRow label="Role">
                <Badge
                  variant="primary-light"
                  size="xs"
                  radius="full"
                  title="Operating role assigned in the console. This board can be switched to a Controller at any time."
                >
                  <RiRadioLine className="size-3" aria-hidden="true" />
                  Node
                </Badge>
              </CardRow>
              <CardRow label="Status">
                <Badge variant={status.variant} size="xs" radius="full" title={headline}>
                  {status.label}
                </Badge>
              </CardRow>
              <CardRow label="Binding">
                <Badge
                  variant={
                    node.binding_state === "verified"
                      ? "primary-light"
                      : node.binding_state === "revoked"
                        ? "destructive-light"
                        : "secondary"
                  }
                  size="xs"
                  title="Binding state is separate from live connectivity."
                >
                  {node.binding_state === "verified"
                    ? `Verified · gen ${node.binding_generation ?? 0}`
                    : node.binding_state === "assigned"
                      ? "Assigned · not verified"
                      : node.binding_state === "revoked"
                        ? "Revoked"
                        : "Not assigned"}
                </Badge>
              </CardRow>
              <CardRow label="Controller">
                <span
                  className="flex min-w-0 items-center gap-1 truncate font-medium text-foreground"
                  title={
                    node.assigned_controller_name
                      ? `Hosted by ${node.assigned_controller_name}`
                      : "No Controller assigned"
                  }
                >
                  <RiCpuLine className="size-3 shrink-0 text-muted-foreground" aria-hidden="true" />
                  <span className="truncate">
                    {node.assigned_controller_name ?? "Not assigned"}
                  </span>
                </span>
              </CardRow>
              <CardRow label="Link">
                <Badge variant="secondary" size="xs" title={headline}>
                  {commMode === "espnow" ? (
                    <RiRadioLine className="size-3" aria-hidden="true" />
                  ) : (
                    <RiWifiLine className="size-3" aria-hidden="true" />
                  )}
                  {nodeCommModeLabel(commMode)}
                </Badge>
              </CardRow>
              <CardRow label="Firmware">
                <span className="truncate font-semibold tabular-nums text-foreground">
                  {firmwareLabel ?? "Not reported"}
                </span>
              </CardRow>
              <div className="contents" data-testid="node-last-activity">
                <dt className="text-muted-foreground">Last activity</dt>
                <dd className="flex h-5 min-w-0 items-center font-medium text-foreground">
                  <span
                    className="truncate font-semibold tabular-nums"
                    title={formatTimestamp(lastActivityAt, timezone)}
                  >
                    {formatTimestamp(lastActivityAt, timezone)}
                  </span>
                </dd>
              </div>
            </dl>

            {node.last_error && (
              <div className="rounded-lg border border-destructive/30 bg-destructive/8 px-2 py-1.5 text-[11px] leading-snug text-destructive">
                <span className="font-semibold">Connection Error: </span>
                <span className="line-clamp-2 break-words [overflow-wrap:anywhere]">
                  {node.last_error}
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
