import { useMemo, useState } from "react";
import {
  RiArrowRightLine,
  RiCheckLine,
  RiFileCopyLine,
  RiLoader4Line,
} from "@remixicon/react";
import { apiFetch, ApiError } from "@/lib/api";
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
} from "@/components/reui/select";
import type { ControllerItem } from "@/features/types";
import { WifiPortalArtwork } from "./RecoveryArtwork";
import {
  JoinTemporaryWifiSteps,
  PORTAL_ORIGIN,
  useCopyToClipboard,
  usePairingWatch,
} from "./WifiSetupFlow";

const RECOVER_DELETED_VALUE = "__recover_deleted__";

/**
 * Repair / Recover with Wi-Fi.
 *
 * The board is not on the network, so the website cannot drive it directly.
 * The split is therefore explicit and mirrors Setup with Wi-Fi:
 *
 *   1. Here: choose which account record the board is (or recover a deleted
 *      one) and generate a single-use 6-digit *recovery* code.
 *   2. There: press BOOT / Recovery for 3 seconds, join HomecoreOS-Setup-XXXX,
 *      open http://192.168.4.1, and on the local page enter only what is missing
 *      — Wi-Fi SSID/password when the network changed, the website URL when it
 *      is missing or wrong, and the recovery code — then Save.
 *   3. The board repairs, re-pairs with the same board ID (no duplicate is
 *      created), restarts, reconnects to MQTT and closes temporary Wi-Fi.
 *
 * This panel only watches the account record; it never claims success on its
 * own, and it never flashes firmware.
 */
export function WifiRecoveryFlow({
  controllers,
  boardOptions,
  selectedBoardChoice,
  onBoardChoiceChange,
  boardName,
  onBoardNameChange,
  targetController,
  websiteUrl,
  canManage,
  onSuccess,
}: {
  controllers: ControllerItem[];
  boardOptions: Array<{ id: string; label: string }>;
  selectedBoardChoice: string;
  onBoardChoiceChange: (value: string) => void;
  boardName: string;
  onBoardNameChange: (value: string) => void;
  targetController: ControllerItem | null;
  websiteUrl: string;
  canManage: boolean;
  onSuccess?: (message: string) => void;
}) {
  const initialTarget = targetController?.id ?? (controllers.length === 1 ? controllers[0]!.id : "");
  const [targetId, setTargetId] = useState(initialTarget);
  const [code, setCode] = useState<string | null>(null);
  const [controllerId, setControllerId] = useState<string | null>(targetController?.id ?? null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { copied, copy } = useCopyToClipboard();
  const { online, controllerName } = usePairingWatch(code, controllerId);

  const isDeleted = targetId === RECOVER_DELETED_VALUE;
  const selectedBoard = useMemo(
    () => boardOptions.find((option) => option.id === selectedBoardChoice),
    [boardOptions, selectedBoardChoice]
  );
  const knownSsid = useMemo(
    () => controllers.find((board) => board.id === targetId)?.wifi_ssid ?? null,
    [controllers, targetId]
  );

  // Recovering a deleted board creates a fresh record (it no longer exists);
  // every other path updates the existing board ID instead of duplicating it.
  const needsNewRecord = isDeleted || controllers.length === 0;

  async function generateCode() {
    setBusy(true);
    setError(null);
    try {
      let id: string;
      let pairingCode: string;

      if (needsNewRecord) {
        const [kind, profileId] = selectedBoardChoice.split(":");
        if (!profileId) throw new Error("Select the board model you are recovering.");
        const created = await apiFetch<{ controller: ControllerItem; pairingCode: string }>(
          "/api/board-instances/recover",
          {
            method: "POST",
            body: JSON.stringify({
              name: boardName.trim() || selectedBoard?.label || "HomecoreOS Board",
              ...(kind === "catalog" ? { boardProfileId: profileId } : { customBoardProfileId: profileId }),
            }),
          }
        );
        id = created.controller.id;
        pairingCode = created.pairingCode;
      } else {
        if (!targetId) throw new Error("Choose the board you want to recover.");
        const res = await apiFetch<{ pairingCode: string }>(
          `/api/board-instances/${targetId}/regenerate-pairing-code`,
          { method: "POST" }
        );
        id = targetId;
        pairingCode = res.pairingCode;
      }

      setControllerId(id);
      setCode(pairingCode);
    } catch (err) {
      setError(
        err instanceof ApiError || err instanceof Error ? err.message : "Could not generate a recovery code."
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-4">
      <WifiPortalArtwork recovery />

      <JoinTemporaryWifiSteps recovery />

      <Frame spacing="sm">
        <FramePanel className="space-y-1.5 p-3 text-[12px] leading-relaxed text-muted-foreground">
          <p className="font-medium text-foreground">The board diagnoses and repairs itself</p>
          <p>
            Once saved, the local page checks Wi-Fi, ESP-NOW, MQTT, the temporary Wi-Fi and local webpage, pairing,
            firmware validity and OTA, fixes what it can, restarts and reconnects. A firmware problem is reported with
            the reason — nothing is ever flashed during recovery.
          </p>
        </FramePanel>
      </Frame>

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
          {controllers.length > 0 && (
            <FormField id="wifi-recover-target" label="Board to Recover">
              <Select value={targetId} onValueChange={setTargetId}>
                <SelectTrigger id="wifi-recover-target" className="w-full">
                  <SelectValue placeholder="Select board…" />
                </SelectTrigger>
                <SelectContent>
                  {controllers.map((board) => (
                    <SelectItem key={board.id} value={board.id}>
                      {board.name} ({board.board_model})
                    </SelectItem>
                  ))}
                  <SelectItem value={RECOVER_DELETED_VALUE}>Deleted / not listed board</SelectItem>
                </SelectContent>
              </Select>
            </FormField>
          )}

          {needsNewRecord && (
            <div className="grid gap-3 sm:grid-cols-2">
              <FormField id="wifi-recover-name" label="Board Name">
                <Input
                  id="wifi-recover-name"
                  value={boardName}
                  onChange={(event) => onBoardNameChange(event.target.value)}
                  placeholder="Living Room Controller"
                />
              </FormField>
              <FormField id="wifi-recover-board" label="Board Model">
                <Select value={selectedBoardChoice} onValueChange={onBoardChoiceChange}>
                  <SelectTrigger id="wifi-recover-board" className="w-full">
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
          )}

          {knownSsid && (
            <p className="text-[11.5px] text-muted-foreground">
              Saved Wi-Fi network: <span className="font-medium text-foreground">{knownSsid}</span>. You only need to
              enter the password on the board if it changed.
            </p>
          )}

          <div className="flex justify-end border-t pt-3">
            <Button type="submit" disabled={!canManage || busy}>
              {busy ? <RiLoader4Line className="size-4 animate-spin" /> : null}
              Generate Recovery Code
            </Button>
          </div>
        </form>
      ) : (
        <div className="space-y-3">
          <Frame spacing="sm">
            <FramePanel className="space-y-2 p-4 text-center">
              <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                6-Digit Recovery Code
              </p>
              <p className="font-mono text-3xl font-bold tracking-[0.25em] text-primary tabular-nums">{code}</p>
              <Button type="button" size="sm" variant="outline" onClick={() => void copy("code", code)}>
                {copied === "code" ? <RiCheckLine className="size-3.5" /> : <RiFileCopyLine className="size-3.5" />}
                {copied === "code" ? "Copied Code" : "Copy Code"}
              </Button>
            </FramePanel>
          </Frame>

          <div className="space-y-1.5 rounded-lg border bg-muted/30 px-3 py-2.5 text-[12px] leading-relaxed text-muted-foreground">
            <p className="font-medium text-foreground">On the board&rsquo;s local page:</p>
            <ul className="list-disc space-y-1 pl-4">
              <li>
                <strong className="font-medium text-foreground">Wi-Fi SSID / Password</strong>
                {" — "}only when the network changed
              </li>
              <li>
                <strong className="font-medium text-foreground">Website URL</strong> — only when it is missing or wrong;
                the board never asks you to type it unnecessarily
              </li>
              <li>
                <strong className="font-medium text-foreground">Recovery code</strong> — the 6-digit code above
              </li>
              <li>
                Choose{" "}
                <strong className="font-medium text-foreground">Recover / re-pair this controller</strong> when you
                entered a recovery code, or{" "}
                <strong className="font-medium text-foreground">Update Wi-Fi and/or website URL</strong> when you only
                changed the network or the address (pairing is then kept as it is)
              </li>
              <li>
                Press <strong className="font-medium text-foreground">Save and Restart</strong>
              </li>
            </ul>
            <p>
              Open{" "}
              <code className="rounded bg-muted px-1 font-mono text-foreground">{PORTAL_ORIGIN}</code> while joined to
              the board&rsquo;s temporary Wi-Fi.
            </p>
          </div>

          {online ? (
            <StatusAlert tone="success" title="Recovery complete">
              {controllerName ?? "The board"} applied the repair, restarted with its existing board ID and is online
              over MQTT. Its devices, rooms, sensors, switches and Nodes are unchanged, and temporary Wi-Fi has closed.
            </StatusAlert>
          ) : (
            <StatusAlert tone="info">
              Waiting for the board to apply the recovery code, restart and reconnect over MQTT…
            </StatusAlert>
          )}

          <div className="flex items-center justify-end gap-2 pt-1">
            <Button
              type="button"
              variant="outline"
              onClick={() => {
                setCode(null);
                setControllerId(targetId || null);
              }}
            >
              New code
            </Button>
            <Button
              type="button"
              onClick={() => {
                if (online) onSuccess?.(`${controllerName ?? "Board"} recovered over Wi-Fi.`);
                setCode(null);
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
