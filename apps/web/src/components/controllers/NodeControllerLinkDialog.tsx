import { useEffect, useMemo, useRef, useState } from "react";
import { motion, useReducedMotion } from "motion/react";
import {
  RiArrowLeftLine,
  RiArrowRightLine,
  RiCheckboxCircleFill,
  RiCloseCircleFill,
  RiCloudLine,
  RiCloudOffLine,
  RiCpuLine,
  RiErrorWarningFill,
  RiLoader4Line,
  RiRadioLine,
  RiRefreshLine,
  RiWifiLine,
  RiWifiOffLine,
} from "@remixicon/react";
import {
  ESPNOW_RECONNECT_WINDOW_MS,
  evaluateNodeControllerLink,
  nodeCommModeLabel,
  type NodeControllerFaultTarget,
  type NodeControllerStageStatus,
  type NodeControllerVerificationTone,
} from "@homecoreos/shared";
import { BoardVectorSvg } from "@/components/boards/BoardVectorSvg";
import { fallbackBoardProfile } from "@/components/controllers/ControllerCard";
import { Badge } from "@/components/reui/badge";
import { Frame, FramePanel } from "@/components/reui/frame";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import type { BoardProfileItem, ControllerItem } from "@/features/types";
import { formatTimestamp } from "@/lib/timezone";

export interface NodeControllerLinkDialogProps {
  open: boolean;
  node: ControllerItem | null;
  controller: ControllerItem | null;
  nodeBoard: BoardProfileItem | null;
  controllerBoard: BoardProfileItem | null;
  timezone: string;
  retrying?: boolean;
  retryError?: string | null;
  canOperate?: boolean;
  canManage?: boolean;
  onRetryConnection: () => void;
  onChangeController?: () => void;
  onClose: () => void;
}

function stageIcon(status: NodeControllerStageStatus, prefersReducedMotion: boolean) {
  switch (status) {
    case "confirmed":
      return (
        <RiCheckboxCircleFill
          className="size-4 shrink-0 text-emerald-600 dark:text-emerald-400"
          aria-hidden="true"
        />
      );
    case "active":
      return (
        <RiLoader4Line
          className={`size-4 shrink-0 text-primary ${prefersReducedMotion ? "" : "animate-spin"}`}
          aria-hidden="true"
        />
      );
    case "warning":
      return (
        <RiErrorWarningFill
          className="size-4 shrink-0 text-amber-600 dark:text-amber-400"
          aria-hidden="true"
        />
      );
    case "failed":
      return (
        <RiCloseCircleFill
          className="size-4 shrink-0 text-destructive"
          aria-hidden="true"
        />
      );
    case "pending":
    default:
      return (
        <span
          className="inline-block size-2.5 shrink-0 rounded-full border border-muted-foreground/40 bg-muted"
          aria-hidden="true"
        />
      );
  }
}

function toneBannerClasses(tone: NodeControllerVerificationTone): string {
  switch (tone) {
    case "connected":
      return "border-emerald-500/35 bg-emerald-500/8 text-emerald-900 dark:text-emerald-200";
    case "degraded":
      return "border-amber-500/35 bg-amber-500/8 text-amber-900 dark:text-amber-200";
    case "failed":
      return "border-destructive/35 bg-destructive/8 text-destructive";
    case "waiting":
    default:
      return "border-primary/30 bg-primary/6 text-foreground";
  }
}

function toneBadge(
  tone: NodeControllerVerificationTone,
  connectionLostAfterSuccess: boolean
): {
  label: string;
  variant:
    | "success-light"
    | "primary-light"
    | "warning-light"
    | "destructive-light"
    | "secondary";
} {
  switch (tone) {
    case "connected":
      return { label: "Connected", variant: "success-light" };
    case "degraded":
      return { label: "Degraded / Fallback", variant: "warning-light" };
    case "failed":
      return {
        label: connectionLostAfterSuccess ? "Connection Lost" : "Needs Attention",
        variant: "destructive-light",
      };
    case "waiting":
    default:
      return { label: "Verifying Hardware", variant: "primary-light" };
  }
}

function boardRingClasses(
  isFault: boolean,
  tone: NodeControllerVerificationTone
): string {
  if (isFault) {
    return "border-destructive/60 bg-destructive/4 ring-1 ring-destructive/25";
  }
  if (tone === "connected") {
    return "border-emerald-500/45 bg-emerald-500/[0.03] ring-1 ring-emerald-500/20";
  }
  if (tone === "degraded") {
    return "border-amber-500/40 bg-amber-500/[0.03]";
  }
  return "border-border/70 bg-card/80";
}

function faultLabelForTarget(target: NodeControllerFaultTarget): string | null {
  switch (target) {
    case "node":
      return "Node board issue";
    case "controller":
      return "Controller board issue";
    case "espnow_link":
      return "ESP-NOW radio path issue";
    case "cloud_link":
      return "Controller cloud / MQTT issue";
    case "assignment":
      return "Assignment issue";
    default:
      return null;
  }
}

/**
 * Hardware-truthful verification modal for a Node <-> Controller ESP-NOW link.
 *
 * Driven strictly by real server-reported device state delivered through the
 * console's shared real-time sync channel (`useLiveSync`). Never simulates
 * progress or fabricates a connected verdict.
 */
export function NodeControllerLinkDialog({
  open,
  node,
  controller,
  nodeBoard,
  controllerBoard,
  timezone,
  retrying = false,
  retryError = null,
  canOperate = true,
  canManage = false,
  onRetryConnection,
  onChangeController,
  onClose,
}: NodeControllerLinkDialogProps) {
  const prefersReducedMotion = Boolean(useReducedMotion());
  const pairKey = `${node?.id ?? ""}:${controller?.id ?? ""}`;
  const [wasEverConnected, setWasEverConnected] = useState(false);
  const [waitingOverWindow, setWaitingOverWindow] = useState(false);
  const prevPairKeyRef = useRef(pairKey);

  // Reset session-scoped flags when opened for a new Node/Controller pair.
  useEffect(() => {
    if (prevPairKeyRef.current !== pairKey || !open) {
      prevPairKeyRef.current = pairKey;
      setWasEverConnected(false);
      setWaitingOverWindow(false);
    }
  }, [pairKey, open]);

  const evalState = useMemo(
    () =>
      evaluateNodeControllerLink({
        node,
        controller,
        wasEverConnected,
        waitingOverReconnectWindow: waitingOverWindow,
      }),
    [node, controller, wasEverConnected, waitingOverWindow]
  );

  useEffect(() => {
    if (open && evalState.connected && !wasEverConnected) {
      setWasEverConnected(true);
    }
  }, [open, evalState.connected, wasEverConnected]);

  // Honest 45 s firmware reconnect window notice (no polling, no fake progress).
  useEffect(() => {
    if (!open || evalState.tone !== "waiting" || retrying) {
      if (evalState.tone !== "waiting") {
        setWaitingOverWindow(false);
      }
      return;
    }
    setWaitingOverWindow(false);
    const id = window.setTimeout(() => {
      setWaitingOverWindow(true);
    }, ESPNOW_RECONNECT_WINDOW_MS);
    return () => window.clearTimeout(id);
  }, [open, pairKey, evalState.tone, retrying]);

  const nodeProfile = useMemo(
    () => (node ? nodeBoard ?? fallbackBoardProfile(node) : null),
    [node, nodeBoard]
  );
  const controllerProfile = useMemo(
    () => (controller ? controllerBoard ?? fallbackBoardProfile(controller) : null),
    [controller, controllerBoard]
  );

  const headerBadge = toneBadge(evalState.tone, evalState.connectionLostAfterSuccess);
  const faultTag = faultLabelForTarget(evalState.faultTarget);

  const nodeLastSeen = node?.last_communication_at ?? node?.last_heartbeat_at ?? null;
  const controllerLastSeen =
    controller?.last_communication_at ?? controller?.last_heartbeat_at ?? null;
  const nodeModelLabel = node?.board_compat?.model ?? node?.board_model ?? "ESP32 Board";
  const controllerModelLabel =
    controller?.board_compat?.model ?? controller?.board_model ?? "ESP32 Board";

  const forwardActive =
    evalState.tone === "waiting" &&
    evalState.nodeOnline &&
    (evalState.nodeConfigSynced || evalState.keepaliveSentOrHeard);
  const forwardConfirmed = evalState.controllerHeardNode || evalState.connected;
  const ackActive =
    evalState.tone === "waiting" && evalState.controllerHeardNode && !evalState.nodeAckConfirmed;
  const ackConfirmed = evalState.nodeAckConfirmed && evalState.inControllerRoster;
  const espnowFault = evalState.faultTarget === "espnow_link";
  const cloudFault = evalState.faultTarget === "cloud_link";

  const nodeMqttArchitectureNote =
    node?.node_link_state === "standalone"
      ? "Standalone Wi-Fi / MQTT fallback active"
      : evalState.nodeAckConfirmed
        ? "Direct MQTT off · routes via Controller"
        : "Closes own MQTT once ESP-NOW links";

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) onClose();
      }}
    >
      <DialogContent
        className="max-h-[92vh] overflow-y-auto sm:max-w-3xl"
        data-testid="node-controller-link-dialog"
      >
        <DialogHeader>
          <div className="flex flex-wrap items-center justify-between gap-2 pr-6">
            <DialogTitle className="flex flex-wrap items-center gap-2 text-base sm:text-lg">
              <span>Connecting Node to Controller</span>
              <Badge
                variant={headerBadge.variant}
                size="sm"
                radius="full"
                data-testid="link-dialog-verdict-badge"
              >
                {headerBadge.label}
              </Badge>
            </DialogTitle>
            {faultTag && (
              <Badge
                variant={evalState.tone === "degraded" ? "warning-light" : "destructive-light"}
                size="sm"
                radius="full"
                data-testid="link-dialog-fault-badge"
              >
                {faultTag}
              </Badge>
            )}
          </div>
          <DialogDescription>
            Live hardware verification between{" "}
            <span className="font-medium text-foreground">{node?.name ?? "Node"}</span> and{" "}
            <span className="font-medium text-foreground">
              {controller?.name ?? "Controller"}
            </span>
            . Status updates automatically as the boards report real ESP-NOW and MQTT telemetry.
          </DialogDescription>
        </DialogHeader>

        {/* Visual Hardware Topology Stage: Node <-> ESP-NOW <-> Controller -> Cloud */}
        <div
          className="hc-dot-grid rounded-xl border border-border/70 p-3 sm:p-4"
          data-testid="link-dialog-topology"
        >
          <div className="grid grid-cols-1 items-stretch gap-3 md:grid-cols-[1fr_auto_1fr]">
            {/* LEFT: Selected Node Board */}
            <div
              data-testid="link-dialog-node-board"
              data-fault={evalState.faultTarget === "node" ? "true" : "false"}
              className={`flex flex-col justify-between rounded-xl border p-3 transition-colors ${boardRingClasses(
                evalState.faultTarget === "node",
                evalState.tone
              )}`}
            >
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <div className="flex items-center gap-1.5">
                    <Badge variant="secondary" size="sm" radius="full">
                      <RiRadioLine className="size-3 opacity-75" aria-hidden="true" />
                      Node
                    </Badge>
                    <Badge
                      variant={evalState.nodeOnline ? "success-light" : "destructive-light"}
                      size="sm"
                      radius="full"
                    >
                      {evalState.nodeOnline ? "Online" : "Offline"}
                    </Badge>
                  </div>
                  <p className="mt-1.5 truncate text-sm font-semibold text-foreground">
                    {node?.name ?? "Node"}
                  </p>
                  <p className="truncate text-[11px] text-muted-foreground">{nodeModelLabel}</p>
                </div>
              </div>

              <div className="my-2.5 flex h-28 items-center justify-center rounded-lg border border-border/50 bg-background/75 px-3 py-2">
                {nodeProfile ? (
                  <BoardVectorSvg
                    board={nodeProfile}
                    orientation="horizontal"
                    compact={!nodeBoard?.board_layout}
                    className="h-full max-h-full w-full"
                  />
                ) : (
                  <RiCpuLine className="size-10 text-muted-foreground" aria-hidden="true" />
                )}
              </div>

              <div className="space-y-1 border-t border-border/50 pt-2 text-[11px]">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-muted-foreground">Uplink mode</span>
                  <span className="font-mono font-medium text-foreground">
                    {node ? nodeCommModeLabel(node.node_comm_mode ?? null) : "—"}
                  </span>
                </div>
                <p className="truncate text-[10.5px] text-muted-foreground">
                  {nodeMqttArchitectureNote}
                </p>
              </div>
            </div>

            {/* CENTER: Bidirectional 2.4 GHz ESP-NOW Path */}
            <div
              data-testid="link-dialog-espnow-bridge"
              data-fault={espnowFault ? "true" : "false"}
              className={`flex flex-col items-center justify-center gap-2.5 rounded-xl border px-3 py-3 md:w-44 ${
                espnowFault
                  ? "border-destructive/50 bg-destructive/5"
                  : evalState.connected
                    ? "border-emerald-500/40 bg-emerald-500/5"
                    : "border-border/60 bg-background/70"
              }`}
            >
              <div className="flex items-center gap-1.5 text-[11px] font-semibold tracking-tight text-foreground">
                <RiWifiLine
                  className={`size-3.5 ${
                    espnowFault
                      ? "text-destructive"
                      : evalState.connected
                        ? "text-emerald-600 dark:text-emerald-400"
                        : "text-primary"
                  }`}
                  aria-hidden="true"
                />
                <span>ESP-NOW 2.4 GHz</span>
              </div>

              {/* Track 1: Node -> Controller Keepalive */}
              <div className="w-full space-y-1">
                <div className="flex items-center justify-between text-[10px] text-muted-foreground">
                  <span>Keepalive</span>
                  <RiArrowRightLine className="size-3" aria-hidden="true" />
                </div>
                <div className="relative h-2 w-full overflow-hidden rounded-full bg-muted">
                  {forwardConfirmed ? (
                    <div className="h-full w-full rounded-full bg-emerald-500 transition-all duration-300" />
                  ) : espnowFault ? (
                    <div className="h-full w-full rounded-full bg-destructive/65" />
                  ) : forwardActive && !prefersReducedMotion ? (
                    <motion.div
                      className="h-full w-2/5 rounded-full bg-primary"
                      initial={{ x: "-100%" }}
                      animate={{ x: "260%" }}
                      transition={{ duration: 1.6, repeat: Infinity, ease: "easeInOut" }}
                    />
                  ) : forwardActive ? (
                    <div className="h-full w-3/5 rounded-full bg-primary/75" />
                  ) : null}
                </div>
              </div>

              {/* RF Channel & RSSI Telemetry Pill */}
              <div className="rounded-full border border-border/70 bg-muted/60 px-2.5 py-0.5 font-mono text-[10.5px] font-medium tabular-nums text-foreground">
                {evalState.effectiveChannel ? `Ch ${evalState.effectiveChannel}` : "Auto-seek"}
                {evalState.effectiveRssi !== null ? ` · ${evalState.effectiveRssi} dBm` : ""}
              </div>

              {/* Track 2: Controller -> Node ACK */}
              <div className="w-full space-y-1">
                <div className="relative h-2 w-full overflow-hidden rounded-full bg-muted">
                  {ackConfirmed ? (
                    <div className="h-full w-full rounded-full bg-emerald-500 transition-all duration-300" />
                  ) : espnowFault ? (
                    <div className="h-full w-full rounded-full bg-amber-500/65" />
                  ) : (ackActive || forwardActive) && !prefersReducedMotion ? (
                    <motion.div
                      className="h-full w-2/5 rounded-full bg-primary/80"
                      initial={{ x: "260%" }}
                      animate={{ x: "-100%" }}
                      transition={{
                        duration: 1.6,
                        repeat: Infinity,
                        ease: "easeInOut",
                        delay: 0.45,
                      }}
                    />
                  ) : ackActive ? (
                    <div className="h-full w-3/5 rounded-full bg-primary/70" />
                  ) : null}
                </div>
                <div className="flex items-center justify-between text-[10px] text-muted-foreground">
                  <RiArrowLeftLine className="size-3" aria-hidden="true" />
                  <span>Controller ACK</span>
                </div>
              </div>
            </div>

            {/* RIGHT: Selected Controller Board + Cloud / MQTT Path */}
            <div
              data-testid="link-dialog-controller-board"
              data-fault={
                evalState.faultTarget === "controller" || cloudFault ? "true" : "false"
              }
              className={`flex flex-col justify-between rounded-xl border p-3 transition-colors ${boardRingClasses(
                evalState.faultTarget === "controller",
                evalState.tone
              )}`}
            >
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <div className="flex items-center gap-1.5">
                    <Badge variant="secondary" size="sm" radius="full">
                      <RiCpuLine className="size-3 opacity-75" aria-hidden="true" />
                      Controller
                    </Badge>
                    <Badge
                      variant={
                        evalState.controllerOnline ? "success-light" : "destructive-light"
                      }
                      size="sm"
                      radius="full"
                    >
                      {evalState.controllerOnline ? "Online" : "Offline"}
                    </Badge>
                  </div>
                  <p className="mt-1.5 truncate text-sm font-semibold text-foreground">
                    {controller?.name ?? "Controller"}
                  </p>
                  <p className="truncate text-[11px] text-muted-foreground">
                    {controllerModelLabel}
                  </p>
                </div>
              </div>

              <div className="my-2.5 flex h-28 items-center justify-center rounded-lg border border-border/50 bg-background/75 px-3 py-2">
                {controllerProfile ? (
                  <BoardVectorSvg
                    board={controllerProfile}
                    orientation="horizontal"
                    compact={!controllerBoard?.board_layout}
                    className="h-full max-h-full w-full"
                  />
                ) : (
                  <RiCpuLine className="size-10 text-muted-foreground" aria-hidden="true" />
                )}
              </div>

              {/* Controller -> HomecoreOS Cloud / MQTT Uplink Indicator */}
              <div
                data-testid="link-dialog-cloud-path"
                data-healthy={evalState.controllerMqttHealthy ? "true" : "false"}
                className={`rounded-lg border px-2.5 py-1.5 text-[11px] ${
                  !evalState.controllerOnline
                    ? "border-destructive/40 bg-destructive/8 text-destructive"
                    : evalState.controllerMqttHealthy
                      ? "border-emerald-500/35 bg-emerald-500/8 text-emerald-900 dark:text-emerald-200"
                      : "border-amber-500/40 bg-amber-500/10 text-amber-900 dark:text-amber-200"
                }`}
              >
                <div className="flex items-center justify-between gap-2 font-medium">
                  <span className="inline-flex items-center gap-1.5 truncate">
                    {evalState.controllerMqttHealthy ? (
                      <RiCloudLine className="size-3.5 shrink-0" aria-hidden="true" />
                    ) : !evalState.controllerOnline ? (
                      <RiWifiOffLine className="size-3.5 shrink-0" aria-hidden="true" />
                    ) : (
                      <RiCloudOffLine className="size-3.5 shrink-0" aria-hidden="true" />
                    )}
                    <span className="truncate">HomecoreOS Cloud (MQTT)</span>
                  </span>
                  <span className="shrink-0 font-mono text-[10.5px]">
                    {evalState.controllerMqttHealthy
                      ? "Connected"
                      : !evalState.controllerOnline
                        ? "Offline"
                        : "Disconnected"}
                  </span>
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* Truthful Status Headline Banner */}
        <div
          role="status"
          aria-live="polite"
          data-testid="link-dialog-status-banner"
          data-tone={evalState.tone}
          className={`rounded-xl border px-3.5 py-3 text-xs ${toneBannerClasses(evalState.tone)}`}
        >
          <p className="font-semibold">{evalState.headline}</p>
          <p className="mt-0.5 leading-relaxed opacity-90">{evalState.summary}</p>
          {retryError && (
            <p className="mt-1.5 font-medium text-destructive">Retry error: {retryError}</p>
          )}
        </div>

        {/* 7 Hardware Lifecycle Verification Checkpoints */}
        <Frame spacing="xs">
          <FramePanel className="p-3">
            <p className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
              Hardware Verification Lifecycle
            </p>
            <ol className="space-y-2" data-testid="link-dialog-stages">
              {evalState.stages.map((stage) => (
                <li
                  key={stage.id}
                  data-testid={`link-stage-${stage.id}`}
                  data-stage-status={stage.status}
                  className="flex items-start gap-2.5 text-xs"
                >
                  <span className="mt-0.5 flex size-4 items-center justify-center">
                    {stageIcon(stage.status, prefersReducedMotion)}
                  </span>
                  <div className="min-w-0 flex-1">
                    <p
                      className={`font-medium leading-snug ${
                        stage.status === "pending"
                          ? "text-muted-foreground"
                          : "text-foreground"
                      }`}
                    >
                      {stage.label}
                    </p>
                    <p className="text-[11px] leading-snug text-muted-foreground">
                      {stage.detail}
                    </p>
                  </div>
                </li>
              ))}
            </ol>
          </FramePanel>
        </Frame>

        {/* Live Hardware Telemetry Strip */}
        <Frame spacing="xs">
          <FramePanel
            className="grid grid-cols-2 gap-2.5 p-3 text-[11px] sm:grid-cols-5"
            data-testid="link-dialog-diagnostics"
          >
            <div className="min-w-0">
              <p className="text-muted-foreground">Node Response</p>
              <p className="truncate font-mono font-semibold tabular-nums text-foreground">
                {nodeLastSeen ? formatTimestamp(nodeLastSeen, timezone) : "Pending"}
              </p>
            </div>
            <div className="min-w-0">
              <p className="text-muted-foreground">Controller Response</p>
              <p className="truncate font-mono font-semibold tabular-nums text-foreground">
                {controllerLastSeen
                  ? formatTimestamp(controllerLastSeen, timezone)
                  : "Pending"}
              </p>
            </div>
            <div className="min-w-0">
              <p className="text-muted-foreground">Last Linked</p>
              <p className="truncate font-mono font-semibold tabular-nums text-foreground">
                {node?.node_last_linked_at
                  ? formatTimestamp(node.node_last_linked_at, timezone)
                  : "Not linked yet"}
              </p>
            </div>
            <div className="min-w-0">
              <p className="text-muted-foreground">Channel / RSSI</p>
              <p className="truncate font-mono font-semibold tabular-nums text-foreground">
                {evalState.effectiveChannel || evalState.effectiveRssi !== null
                  ? `${evalState.effectiveChannel ? `Ch ${evalState.effectiveChannel}` : "Auto"}${
                      evalState.effectiveRssi !== null
                        ? ` · ${evalState.effectiveRssi} dBm`
                        : ""
                    }`
                  : "Not reported yet"}
              </p>
            </div>
            <div className="col-span-2 min-w-0 sm:col-span-1">
              <p className="text-muted-foreground">Controller Roster</p>
              <p className="truncate font-mono font-semibold text-foreground">
                {evalState.inControllerRoster
                  ? "Verified in roster"
                  : evalState.rosterAvailable
                    ? "Not in roster yet"
                    : "Pending report"}
              </p>
            </div>
          </FramePanel>
        </Frame>

        <DialogFooter className="flex-wrap justify-between gap-2">
          <div className="flex flex-wrap items-center gap-2">
            {canOperate && (
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={retrying || !node || !controller}
                onClick={onRetryConnection}
                data-testid="link-dialog-retry-button"
              >
                <RiRefreshLine
                  className={`size-4 ${retrying && !prefersReducedMotion ? "animate-spin" : ""}`}
                  aria-hidden="true"
                />
                {retrying ? "Requesting Re-link…" : "Retry Connection"}
              </Button>
            )}
            {canManage && onChangeController && evalState.tone !== "connected" && (
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={retrying || !node}
                onClick={onChangeController}
                data-testid="link-dialog-change-controller-button"
              >
                Change Controller
              </Button>
            )}
          </div>
          <Button
            type="button"
            variant={evalState.connected ? "default" : "secondary"}
            size="sm"
            onClick={onClose}
            data-testid="link-dialog-close-button"
          >
            {evalState.connected ? "Done" : "Close"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
