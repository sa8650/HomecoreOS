import {
  RiArrowLeftRightLine,
  RiCpuLine,
  RiEyeLine,
  RiHistoryLine,
  RiLinkM,
  RiLinksLine,
  RiMore2Fill,
  RiRadioLine,
  RiRestartLine,
  RiWifiLine,
} from "@remixicon/react";
import { Badge } from "@/components/reui/badge";
import { BoardVectorSvg } from "@/components/boards/BoardVectorSvg";
import { fallbackBoardProfile } from "@/components/controllers/ControllerCard";
import { Button } from "@/components/ui/button";
import { CardContent } from "@/components/ui/card";
import { MagicCard } from "@/components/ui/magic-card";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  boardSupportsControllerRole,
  deviceStatusLabel,
  nodeCommModeLabel,
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

/**
 * A Node is a full HomecoreOS device that runs the same firmware in Node mode:
 * it owns its switches and sensors and reaches the cloud through its Controller
 * over ESP-NOW. It is deliberately presented apart from Controllers so a Node
 * is never mistaken for one.
 */
export function NodeCard({
  node,
  board,
  canManage,
  canOperate,
  timezone,
  onViewDetails,
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
  onAssignController: () => void;
  onRelink: () => void;
  onPromote: () => void;
}) {
  const online = node.status === "online";
  const boardProfile = board ?? fallbackBoardProfile(node);
  const status = nodeStatusBadge(node, online);
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
  const canBecomeController = !board || boardSupportsControllerRole(board);
  const lastActivityAt = node.last_communication_at ?? node.last_heartbeat_at;

  return (
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
          aria-label={`View details for ${node.name}`}
          className="hc-dot-grid relative flex h-32 w-full shrink-0 cursor-pointer items-center justify-center overflow-hidden rounded-t-xl border-b border-border/60 px-4 pb-3 pt-8 outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/70"
        >
          <BoardVectorSvg
            board={boardProfile}
            orientation="horizontal"
            compact={!board?.board_layout}
            className="h-full max-h-full w-full opacity-90 transition-transform duration-300 group-hover:scale-[1.03]"
          />
          <span className="pointer-events-none absolute inset-x-2 top-2 flex items-center justify-between gap-2">
            <Badge
              variant="secondary"
              size="sm"
              radius="full"
              className="max-w-[55%]"
              data-testid="node-role-badge"
            >
              <RiRadioLine className="size-3 shrink-0 opacity-75" aria-hidden="true" />
              <span className="truncate">Node</span>
            </Badge>
            <Badge variant={status.variant} size="sm" radius="full" title={headline}>
              {status.label}
            </Badge>
          </span>
        </button>

        <div className="flex flex-1 flex-col gap-3 p-3.5">
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

          <p className="text-xs text-muted-foreground" data-testid="node-status-line">
            {headline}
          </p>

          <div className="flex flex-wrap items-center gap-1.5">
            <Badge variant="secondary" size="sm" radius="full">
              {commMode === "espnow" ? (
                <RiRadioLine className="size-3" aria-hidden="true" />
              ) : (
                <RiWifiLine className="size-3" aria-hidden="true" />
              )}
              {nodeCommModeLabel(commMode)}
            </Badge>
            <Badge variant="secondary" size="sm" radius="full" className="max-w-[60%]">
              <RiCpuLine className="size-3 shrink-0" aria-hidden="true" />
              <span className="truncate">
                {node.assigned_controller_name ?? "No Controller assigned"}
              </span>
            </Badge>
            {node.firmware_version && (
              <Badge variant="secondary" size="sm" radius="full" className="tabular-nums">
                {node.firmware_version}
              </Badge>
            )}
          </div>

          <div className="mt-auto space-y-1 text-[11px] text-muted-foreground">
            <p
              className="flex items-center gap-1.5 truncate"
              title={`${boardProfile.manufacturer} ${boardProfile.model} · ${node.chip_variant}`}
            >
              <RiCpuLine className="size-3 shrink-0" aria-hidden="true" />
              <span className="truncate">{node.board_model}</span>
            </p>
            <p className="flex items-center gap-1.5">
              <RiRestartLine className="size-3" aria-hidden="true" />
              Last linked:{" "}
              {node.node_last_linked_at
                ? formatTimestamp(node.node_last_linked_at, timezone)
                : "Never"}
            </p>
            <p className="flex items-center gap-1.5" data-testid="node-last-activity">
              <RiHistoryLine className="size-3" aria-hidden="true" />
              Last activity: {formatTimestamp(lastActivityAt, timezone)}
            </p>
            <p className="truncate" title={node.hardware_uid ?? undefined}>
              {node.hardware_uid ?? "No hardware ID"}
            </p>
          </div>
        </div>
      </CardContent>
    </MagicCard>
  );
}
