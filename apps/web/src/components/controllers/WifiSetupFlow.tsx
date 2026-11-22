import { useCallback, useEffect, useRef, useState } from "react";
import {
  RiArrowRightLine,
  RiCheckLine,
  RiFileCopyLine,
  RiLoader4Line,
} from "@remixicon/react";
import { apiFetch, ApiError } from "@/lib/api";
import { getRealtimeClient } from "@/lib/realtime/sync-client";
import { FormField, StatusAlert } from "@/components/shared/AppUi";
import { Frame, FramePanel } from "@/components/reui/frame";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { ControllerItem, HomeItem } from "@/features/types";
import { WifiPortalArtwork } from "./RecoveryArtwork";

export interface BoardChoiceOption {
  id: string;
  label: string;
  supportsWifi: boolean;
}

export const PORTAL_ORIGIN = "http://192.168.4.1";

/**
 * Copy-to-clipboard with a graceful fallback: the clipboard API is unavailable
 * outside a secure context, and the board's portal is plain HTTP, so a failed
 * copy must never block the workflow.
 */
export function useCopyToClipboard() {
  const [copied, setCopied] = useState<string | null>(null);
  const timer = useRef<number | null>(null);

  useEffect(
    () => () => {
      if (timer.current !== null) window.clearTimeout(timer.current);
    },
    []
  );

  const copy = useCallback(async (key: string, value: string) => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(key);
      if (timer.current !== null) window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => setCopied(null), 1600);
    } catch {
      // Clipboard unsupported (non-secure context / tests): nothing to report.
    }
  }, []);

  return { copied, copy };
}

/**
 * Polls the controller record behind a single-use code until the board has
 * paired *and* is connected over MQTT. The board announces itself on the
 * real-time channel; the interval is only a fallback for an unreachable broker.
 */
export function usePairingWatch(pairingCode: string | null, controllerId: string | null) {
  const [online, setOnline] = useState(false);
  const [controllerName, setControllerName] = useState<string | null>(null);

  useEffect(() => {
    if (!pairingCode) return;
    let active = true;

    const poll = async () => {
      try {
        const res = await apiFetch<{ controller: ControllerItem | null }>(
          "/api/board-instances/pairing-status",
          { method: "POST", body: JSON.stringify({ pairingCode }) }
        );
        if (!active || !res.controller) return;
        setControllerName(res.controller.name);
        if (res.controller.pairing_status === "paired" && res.controller.mqtt_connected) {
          setOnline(true);
        }
      } catch {
        // Transient poll failures are retried by the interval.
      }
    };

    void poll();
    const unsubscribe = getRealtimeClient().subscribe((batch) => {
      const touched = batch.events.some(
        (event) => event.entity === "board" && (!controllerId || event.id === controllerId)
      );
      if (touched || batch.resync) void poll();
    });
    const interval = window.setInterval(() => void poll(), 10_000);

    return () => {
      active = false;
      unsubscribe();
      window.clearInterval(interval);
    };
  }, [pairingCode, controllerId]);

  return { online, controllerName };
}

/** The four fields the board's local page shows, with no secrets included. */
export function PortalFieldChecklist({ portalUrl }: { portalUrl: string }) {
  return (
    <div className="space-y-1.5 rounded-lg border bg-muted/30 px-3 py-2.5 text-[12px] leading-relaxed text-muted-foreground">
      <p className="font-medium text-foreground">On the board&rsquo;s local page:</p>
      <ol className="list-decimal space-y-1 pl-4">
        <li>
          <strong className="font-medium text-foreground">Wi-Fi SSID</strong> — your 2.4 GHz network name
        </li>
        <li>
          <strong className="font-medium text-foreground">Wi-Fi Password</strong> — leave blank to keep the saved one
        </li>
        <li>
          <strong className="font-medium text-foreground">Website URL</strong> — this HomecoreOS address
        </li>
        <li>
          <strong className="font-medium text-foreground">Pairing code</strong> — the 6-digit code below
        </li>
        <li>
          Press <strong className="font-medium text-foreground">Save and Restart</strong>
        </li>
      </ol>
      <p>
        Open <code className="rounded bg-muted px-1 font-mono text-foreground">{portalUrl}</code> while joined to the
        board&rsquo;s temporary Wi-Fi.
      </p>
    </div>
  );
}

/** Shared instructions block for joining the board's temporary network. */
export function JoinTemporaryWifiSteps({ recovery }: { recovery: boolean }) {
  return (
    <Frame spacing="sm">
      <FramePanel className="space-y-2 p-4 text-xs leading-relaxed text-muted-foreground">
        <p className="text-sm font-semibold text-foreground">
          {recovery ? "Steps to recover over Wi-Fi" : "Steps to set up over Wi-Fi"}
        </p>
        <ol className="list-decimal space-y-1.5 pl-4">
          <li>
            {recovery
              ? "Press the physical BOOT / Recovery button on the board for 3 seconds."
              : "Power on the new HomecoreOS board."}
          </li>
          <li>
            {recovery
              ? "Temporary Wi-Fi opens for 15 minutes; pairing and devices are preserved."
              : "The board opens a temporary HomecoreOS-Setup network after flashing."}
          </li>
          <li>
            Connect this phone or computer to{" "}
            <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-foreground">HomecoreOS-Setup-XXXX</code>.
          </li>
          <li>
            Open{" "}
            <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-foreground">{PORTAL_ORIGIN}</code> and work
            through the form on the board.
          </li>
        </ol>
      </FramePanel>
    </Frame>
  );
}

/**
 * Setup with Wi-Fi.
 *
 * 1. The user picks the board model (or the board itself) and generates a
 *    6-digit pairing code here.
 * 2. They join HomecoreOS-Setup-XXXX and enter SSID, password, this website's
 *    URL and the code on the board's local page.
 * 3. The board saves, connects, pairs through the Worker, authenticates with
 *    EMQX and closes its temporary Wi-Fi; this panel watches the account record
 *    until the board is genuinely online.
 *
 * A board ID that already exists under the account is resolved by the Worker
 * (`resolve_pairing_board`) instead of creating a second board entry.
 */
export function WifiSetupFlow({
  boardOptions,
  selectedBoardChoice,
  onBoardChoiceChange,
  boardName,
  onBoardNameChange,
  homes,
  websiteUrl,
  canManage,
  onSuccess,
  onClose,
}: {
  boardOptions: Array<{ id: string; board: { id: string; model: string; supports_wifi?: boolean | null }; label: string }>;
  selectedBoardChoice: string;
  onBoardChoiceChange: (value: string) => void;
  boardName: string;
  onBoardNameChange: (value: string) => void;
  homes: HomeItem[];
  websiteUrl: string;
  canManage: boolean;
  onSuccess?: (message: string) => void;
  onClose: () => void;
}) {
  const [code, setCode] = useState<string | null>(null);
  const [controllerId, setControllerId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { copied, copy } = useCopyToClipboard();
  const { online, controllerName } = usePairingWatch(code, controllerId);

  const selected = boardOptions.find((option) => option.id === selectedBoardChoice)?.board;
  const wifiUnsupported = selected?.supports_wifi === false;

  async function generateCode() {
    setBusy(true);
    setError(null);
    try {
      const [kind, id] = selectedBoardChoice.split(":");
      if (!id) throw new Error("Select the board model you are setting up.");
      const res = await apiFetch<{ controller: ControllerItem; pairingCode: string }>(
        "/api/board-instances",
        {
          method: "POST",
          body: JSON.stringify({
            name: boardName.trim() || "HomecoreOS Board",
            homeId: homes[0]?.id,
            ...(kind === "catalog" ? { boardProfileId: id } : { customBoardProfileId: id }),
          }),
        }
      );
      setControllerId(res.controller.id);
      setCode(res.pairingCode);
    } catch (err) {
      setError(
        err instanceof ApiError || err instanceof Error ? err.message : "Could not generate a pairing code."
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-4">
      <WifiPortalArtwork />

      <JoinTemporaryWifiSteps recovery={false} />

      <div className="flex items-center justify-between gap-2 rounded-lg border bg-muted/35 px-3 py-2">
        <div className="min-w-0">
          <p className="text-[11px] font-medium text-muted-foreground">HomecoreOS website URL</p>
          <p className="truncate font-mono text-xs text-foreground">{websiteUrl}</p>
        </div>
        <Button type="button" size="sm" variant="outline" onClick={() => void copy("url", websiteUrl)}>
          {copied === "url" ? <RiCheckLine className="size-3.5" /> : <RiFileCopyLine className="size-3.5" />}
          {copied === "url" ? "Copied" : "Copy"}
        </Button>
      </div>

      {error && <StatusAlert tone="danger">{error}</StatusAlert>}

      {!code ? (
        <form
          className="space-y-3"
          onSubmit={(event) => {
            event.preventDefault();
            void generateCode();
          }}
        >
          <div className="grid gap-3 sm:grid-cols-2">
            <FormField id="wifi-setup-name" label="Board Name">
              <Input
                id="wifi-setup-name"
                value={boardName}
                onChange={(event) => onBoardNameChange(event.target.value)}
                placeholder="Living Room Controller"
              />
            </FormField>
            <FormField id="wifi-setup-board" label="Board Model">
              <Select value={selectedBoardChoice} onValueChange={onBoardChoiceChange}>
                <SelectTrigger id="wifi-setup-board" className="w-full">
                  <SelectValue placeholder="Select board…" />
                </SelectTrigger>
                <SelectContent>
                  {boardOptions.map((option) => (
                    <SelectItem key={option.id} value={option.id}>
                      {option.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </FormField>
          </div>

          {wifiUnsupported && (
            <StatusAlert tone="warning">
              This board has no integrated Wi-Fi radio, so it cannot join a network. Use Setup with BLE or USB instead.
            </StatusAlert>
          )}

          <div className="flex justify-end border-t pt-3">
            <Button type="submit" disabled={!canManage || busy || wifiUnsupported}>
              {busy ? <RiLoader4Line className="size-4 animate-spin" /> : null}
              Generate Pairing Code
            </Button>
          </div>
        </form>
      ) : (
        <div className="space-y-3">
          <Frame spacing="sm">
            <FramePanel className="space-y-2 p-4 text-center">
              <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                6-Digit Pairing Code
              </p>
              <p className="font-mono text-3xl font-bold tracking-[0.25em] text-primary tabular-nums">{code}</p>
              <p className="text-[11.5px] text-muted-foreground">
                Enter this on the board&rsquo;s local page together with your Wi-Fi details and the website URL.
              </p>
              <Button type="button" size="sm" variant="outline" onClick={() => void copy("code", code)}>
                {copied === "code" ? <RiCheckLine className="size-3.5" /> : <RiFileCopyLine className="size-3.5" />}
                {copied === "code" ? "Copied Code" : "Copy Code"}
              </Button>
            </FramePanel>
          </Frame>

          <PortalFieldChecklist portalUrl={PORTAL_ORIGIN} />

          {online ? (
            <StatusAlert tone="success" title="Your board is ready!">
              {controllerName ?? "The board"} saved its settings, restarted, paired with your account and is online over
              MQTT. Its temporary Wi-Fi has been closed.
            </StatusAlert>
          ) : (
            <StatusAlert tone="info">
              Waiting for the board to save the form, restart, pair with your account and connect to MQTT…
            </StatusAlert>
          )}

          <div className="flex items-center justify-end gap-2 pt-1">
            <Button
              type="button"
              variant="outline"
              onClick={() => {
                setCode(null);
                setControllerId(null);
              }}
            >
              New code
            </Button>
            <Button
              type="button"
              onClick={() => {
                if (online) onSuccess?.(`${controllerName ?? "Board"} is connected and ready.`);
                onClose();
              }}
            >
              {online ? "Done" : "Close"}
              {online ? null : <RiArrowRightLine className="size-4" />}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
