import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import {
  RiArrowLeftLine,
  RiArrowRightLine,
  RiBluetoothConnectLine,
  RiCheckboxCircleFill,
  RiErrorWarningLine,
  RiEyeLine,
  RiEyeOffLine,
  RiLoader4Line,
} from "@remixicon/react";
import type { BleDeviceInfoPayload, BleStatusPayload } from "@homecoreos/shared";
import { apiFetch } from "@/lib/api";
import {
  BleClientError,
  HomecoreBleClient,
  isWebBluetoothSupported,
} from "@/lib/ble-provisioning";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/reui/badge";
import { Frame, FramePanel } from "@/components/reui/frame";
import { FormField, StatusAlert } from "@/components/shared/AppUi";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";

export type BleProvisionActionMode = "wifi_and_pair" | "wifi_only" | "pair_only";

const PROGRESS_LABELS = [
  "1. Securely connecting to controller",
  "2. Saving Wi-Fi configuration",
  "3. Connecting controller to Wi-Fi",
  "4. Pairing controller with your HomecoreOS account",
  "5. Connecting controller to MQTT",
  "6. Verifying controller connection",
] as const;

type StepState = "pending" | "active" | "done" | "error";

export function BleProvisioningPanel({
  controllerId,
  controllerName,
  supportsWifi = true,
  supportsBle = true,
  bootButtonGpio = 0,
  initialSetupPin = "",
  initialPairingCode = "",
  initialWifiSsid = "",
  defaultProvisionMode,
  onSuccess,
}: {
  controllerId?: string;
  controllerName?: string;
  supportsWifi?: boolean;
  supportsBle?: boolean;
  bootButtonGpio?: number;
  initialSetupPin?: string;
  initialPairingCode?: string;
  initialWifiSsid?: string;
  defaultProvisionMode?: BleProvisionActionMode;
  allowModeToggle?: boolean;
  onSuccess?: (result: {
    status: BleStatusPayload;
    deviceName?: string;
  }) => void;
}) {
  const effectiveMode: BleProvisionActionMode =
    defaultProvisionMode ?? (supportsWifi ? "wifi_and_pair" : "pair_only");

  const [screen, setScreen] = useState<"discover" | "wifi" | "progress">("discover");
  const [connecting, setConnecting] = useState(false);
  const [connectedName, setConnectedName] = useState("");
  const [deviceInfo, setDeviceInfo] = useState<BleDeviceInfoPayload | null>(null);
  const [wifiSsid, setWifiSsid] = useState(initialWifiSsid);
  const [wifiPass, setWifiPass] = useState("");
  const [showPass, setShowPass] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [stepStates, setStepStates] = useState<StepState[]>(() =>
    Array.from({ length: 6 }, () => "pending")
  );
  const [done, setDone] = useState(false);

  const clientRef = useRef<HomecoreBleClient | null>(null);
  const timeoutRef = useRef<number | null>(null);
  const expectedDisconnectRef = useRef(false);

  const cleanup = useCallback(() => {
    if (timeoutRef.current !== null) {
      window.clearTimeout(timeoutRef.current);
      timeoutRef.current = null;
    }
    expectedDisconnectRef.current = true;
    clientRef.current?.disconnect();
    clientRef.current = null;
    setWifiPass("");
    setShowPass(false);
  }, []);

  useEffect(() => {
    return cleanup;
  }, [cleanup]);

  useEffect(() => {
    if (initialWifiSsid && !wifiSsid) setWifiSsid(initialWifiSsid);
  }, [initialWifiSsid, wifiSsid]);

  const bleSupport = isWebBluetoothSupported();

  function setProgress(doneBefore: number, activeIdx: number, errIdx?: number) {
    setStepStates(
      Array.from({ length: 6 }, (_, i) => {
        if (errIdx !== undefined && i === errIdx) return "error";
        if (i < doneBefore) return "done";
        if (i === activeIdx && errIdx === undefined) return "active";
        return "pending";
      })
    );
  }

  async function handleDiscover() {
    setError(null);
    if (!bleSupport.supported) {
      setError(bleSupport.reason ?? "Web Bluetooth is unavailable.");
      return;
    }

    clientRef.current?.disconnect();
    expectedDisconnectRef.current = false;
    const client = new HomecoreBleClient();
    clientRef.current = client;
    setConnecting(true);

    try {
      const { deviceInfo: info } = await client.connectAndAuthenticate({
        candidatePins: initialSetupPin ? [initialSetupPin] : undefined,
        onDisconnected: () => {
          if (expectedDisconnectRef.current) return;
          setError("Bluetooth connection was lost. Click Discover BLE Controller to reconnect.");
          setWifiPass("");
          setScreen("discover");
        },
      });

      if (info.wifi === false || !supportsWifi) {
        expectedDisconnectRef.current = true;
        client.disconnect();
        clientRef.current = null;
        setError(
          "ESP32-H2 does not have an integrated Wi-Fi radio and cannot be configured as a standalone Wi-Fi/MQTT controller."
        );
        return;
      }

      setDeviceInfo(info);
      setConnectedName(
        client.deviceName ||
          controllerName ||
          (info.mac_suffix ? `HomecoreOS-${info.mac_suffix}` : "HomecoreOS Controller")
      );
      setScreen("wifi");
    } catch (err) {
      client.disconnect();
      clientRef.current = null;
      setError(
        err instanceof Error ? err.message : "Could not connect to controller via Bluetooth."
      );
    } finally {
      setConnecting(false);
    }
  }

  async function handleSubmitWifi(e: FormEvent) {
    e.preventDefault();
    const cleanSsid = wifiSsid.trim();
    if (!cleanSsid) {
      setError("Enter your 2.4 GHz Wi-Fi network name (SSID).");
      return;
    }

    const client = clientRef.current;
    if (!client || !client.isConnected) {
      setError("Bluetooth connection was lost. Reconnect and try again.");
      setScreen("discover");
      return;
    }

    setError(null);
    setDone(false);
    setScreen("progress");
    setProgress(1, 1);

    let errStep = 2;
    try {
      let code = initialPairingCode.trim();
      if (effectiveMode !== "wifi_only" && !/^\d{6}$/.test(code) && controllerId) {
        const regen = await apiFetch<{ pairingCode: string }>(
          `/api/controllers/${controllerId}/regenerate-pairing-code`,
          { method: "POST" }
        );
        code = regen.pairingCode;
      }

      const action =
        effectiveMode === "wifi_only"
          ? "wifi_only"
          : deviceInfo?.mode === "recovery"
            ? "recover"
            : "provision_wifi";

      const finalStatus = await new Promise<BleStatusPayload>((resolve, reject) => {
        timeoutRef.current = window.setTimeout(() => {
          reject(
            new BleClientError(
              "TIMEOUT",
              "Timed out waiting for Wi-Fi and MQTT confirmation."
            )
          );
        }, 45_000);

        client.onStatusUpdate((st) => {
          if (st.state === "connecting_wifi") {
            errStep = 2;
            setProgress(2, 2);
          } else if (st.state === "wifi_failed") {
            errStep = 2;
            if (timeoutRef.current !== null) window.clearTimeout(timeoutRef.current);
            reject(new Error(st.error || "Could not connect to Wi-Fi."));
          } else if (st.state === "wifi_connected") {
            if (effectiveMode === "wifi_only") {
              if (st.mqtt_connected) {
                expectedDisconnectRef.current = true;
                if (timeoutRef.current !== null) window.clearTimeout(timeoutRef.current);
                resolve(st);
              } else {
                errStep = 4;
                setProgress(4, 4);
              }
            } else {
              errStep = 3;
              setProgress(3, 3);
            }
          } else if (st.state === "pairing") {
            errStep = st.paired ? 4 : 3;
            setProgress(errStep, errStep);
          } else if (st.state === "paired") {
            if (st.mqtt_connected) {
              expectedDisconnectRef.current = true;
              if (timeoutRef.current !== null) window.clearTimeout(timeoutRef.current);
              resolve(st);
            } else {
              errStep = 4;
              setProgress(4, 4);
            }
          } else if (st.state === "error") {
            errStep = st.paired ? 4 : st.wifi_connected ? 3 : 2;
            if (timeoutRef.current !== null) window.clearTimeout(timeoutRef.current);
            reject(
              new Error(
                st.error ||
                  (st.paired
                    ? "Controller paired, but MQTT connection failed."
                    : "Controller pairing failed.")
              )
            );
          }
        });

        void client
          .sendEncryptedCommand(
            {
              action,
              ssid: cleanSsid,
              password: wifiPass,
              ...(effectiveMode !== "wifi_only" && code
                ? {
                    pair_code: code,
                    backend_url:
                      typeof window !== "undefined" ? window.location.origin : "",
                  }
                : {}),
              ...(deviceInfo?.mode === "recovery" ? { physical_confirm: true } : {}),
            },
            { supportsWifi: true }
          )
          .then(() => setProgress(2, 2))
          .catch((err) => {
            if (timeoutRef.current !== null) window.clearTimeout(timeoutRef.current);
            reject(err);
          });
      });

      errStep = 5;
      setProgress(5, 5);
      if (controllerId) {
        const res = await apiFetch<{ controller: { pairing_status?: string; mqtt_connected?: boolean } }>(
          `/api/controllers/${controllerId}`
        );
        if (res.controller?.pairing_status !== "paired" || !res.controller?.mqtt_connected) {
          throw new Error("Controller MQTT connection could not be verified yet.");
        }
      }

      expectedDisconnectRef.current = true;
      client.disconnect();
      clientRef.current = null;
      setWifiPass("");
      setShowPass(false);
      setStepStates(Array.from({ length: 6 }, () => "done"));
      setDone(true);
      onSuccess?.({ status: finalStatus, deviceName: connectedName });
    } catch (err) {
      setProgress(errStep, errStep, errStep);
      setError(
        err instanceof Error ? err.message : "Bluetooth provisioning failed."
      );
    }
  }

  if (!supportsBle) {
    return (
      <StatusAlert tone="warning" title="Bluetooth Not Available on This Board">
        {controllerName ?? "This board"} (ESP32-S2) uses Wi-Fi setup instead of Bluetooth. Power it on (or hold{" "}
        <strong>BOOT GPIO{bootButtonGpio}</strong> for 3 seconds), connect to{" "}
        <code className="rounded bg-muted px-1 font-mono">HomecoreOS-Setup-XXXX</code>, and open{" "}
        <code className="rounded bg-muted px-1 font-mono">http://192.168.4.1</code>.
      </StatusAlert>
    );
  }

  if (!supportsWifi) {
    return (
      <StatusAlert tone="warning" title="No Wi-Fi Radio on This Board">
        {controllerName ?? "This ESP32-H2 board"} does not have an integrated Wi-Fi radio and is unavailable as a standalone Wi-Fi/MQTT controller.
      </StatusAlert>
    );
  }

  return (
    <div className="space-y-4">
      {!bleSupport.supported && (
        <StatusAlert tone="warning" title="Bluetooth Unavailable in This Browser">
          {bleSupport.reason}
        </StatusAlert>
      )}

      {screen === "discover" && (
        <div className="space-y-3">
          <div className="rounded-xl bg-gradient-to-br from-[#2563eb] via-[#3b76f6] to-[#1d4ed8] p-5 text-center text-white">
            <div className="mx-auto mb-2.5 flex size-12 items-center justify-center rounded-xl bg-white/15">
              <RiBluetoothConnectLine className="size-6" aria-hidden="true" />
            </div>
            <p className="text-sm font-semibold">
              Turn on your HomecoreOS controller and keep it nearby.
            </p>
          </div>

          {error && <StatusAlert tone="danger">{error}</StatusAlert>}

          <div className="flex justify-end">
            <Button
              type="button"
              size="sm"
              disabled={!bleSupport.supported || connecting}
              onClick={() => void handleDiscover()}
            >
              {connecting ? (
                <RiLoader4Line className="size-4 animate-spin" aria-hidden="true" />
              ) : (
                <RiBluetoothConnectLine className="size-4" aria-hidden="true" />
              )}
              {connecting ? "Connecting..." : "Discover BLE Controller"}
            </Button>
          </div>
        </div>
      )}

      {screen === "wifi" && (
        <form onSubmit={handleSubmitWifi} className="space-y-3">
          <div className="flex items-center justify-between rounded-lg border border-primary/25 bg-primary/5 px-3 py-2">
            <span className="text-xs font-semibold text-foreground">{connectedName}</span>
            <Badge variant="success-light" size="xs">
              Connected
            </Badge>
          </div>

          {error && <StatusAlert tone="danger">{error}</StatusAlert>}

          <div className="grid gap-3 sm:grid-cols-2">
            <FormField id="ble-wifi-ssid" label="Wi-Fi Network Name (SSID)">
              <Input
                id="ble-wifi-ssid"
                required
                autoComplete="off"
                placeholder="MyHomeWiFi"
                value={wifiSsid}
                onChange={(e) => setWifiSsid(e.target.value)}
              />
            </FormField>
            <FormField id="ble-wifi-pass" label="Wi-Fi Password">
              <div className="relative">
                <Input
                  id="ble-wifi-pass"
                  type={showPass ? "text" : "password"}
                  autoComplete="off"
                  placeholder="Wi-Fi password"
                  value={wifiPass}
                  onChange={(e) => setWifiPass(e.target.value)}
                  className="pr-9"
                />
                <button
                  type="button"
                  aria-label={showPass ? "Hide Wi-Fi password" : "Show Wi-Fi password"}
                  onClick={() => setShowPass((v) => !v)}
                  className="absolute inset-y-0 right-0 flex items-center px-2.5 text-muted-foreground hover:text-foreground cursor-pointer"
                >
                  {showPass ? (
                    <RiEyeOffLine className="size-4" aria-hidden="true" />
                  ) : (
                    <RiEyeLine className="size-4" aria-hidden="true" />
                  )}
                </button>
              </div>
            </FormField>
          </div>

          <div className="flex items-center justify-between">
            <Button
              type="button"
              size="sm"
              variant="ghost"
              onClick={() => {
                cleanup();
                setScreen("discover");
              }}
            >
              <RiArrowLeftLine className="size-4" aria-hidden="true" />
              Back
            </Button>
            <Button type="submit" size="sm" disabled={!wifiSsid.trim()}>
              Save &amp; Connect
              <RiArrowRightLine className="size-4" aria-hidden="true" />
            </Button>
          </div>
        </form>
      )}

      {screen === "progress" && (
        <div className="space-y-3">
          <Frame spacing="sm">
            <FramePanel className="space-y-2 p-3">
              {PROGRESS_LABELS.map((label, idx) => {
                const st = stepStates[idx] ?? "pending";
                return (
                  <div
                    key={label}
                    className={cn(
                      "flex items-center gap-2.5 text-xs",
                      st === "active" && "font-medium text-foreground",
                      st === "done" && "text-foreground",
                      st === "error" && "font-medium text-destructive",
                      st === "pending" && "text-muted-foreground"
                    )}
                  >
                    {st === "done" ? (
                      <RiCheckboxCircleFill className="size-4 text-success" aria-hidden="true" />
                    ) : st === "active" ? (
                      <RiLoader4Line
                        className="size-4 animate-spin text-primary"
                        aria-hidden="true"
                      />
                    ) : st === "error" ? (
                      <RiErrorWarningLine
                        className="size-4 text-destructive"
                        aria-hidden="true"
                      />
                    ) : (
                      <span className="size-4 rounded-full border border-border" />
                    )}
                    <span>{label}</span>
                  </div>
                );
              })}
            </FramePanel>
          </Frame>

          {done && (
            <StatusAlert tone="success" title="Your controller is ready!">
              Connected and paired over Wi-Fi and MQTT.
            </StatusAlert>
          )}
          {error && <StatusAlert tone="danger">{error}</StatusAlert>}
        </div>
      )}
    </div>
  );
}

export function BleProvisioningModal({
  open,
  onClose,
  controllerId,
  controllerName,
  supportsWifi = true,
  supportsBle = true,
  bootButtonGpio = 0,
  initialSetupPin = "",
  initialPairingCode = "",
  initialWifiSsid = "",
  defaultProvisionMode,
  onSuccess,
}: {
  open: boolean;
  onClose: () => void;
  controllerId?: string;
  controllerName?: string;
  supportsWifi?: boolean;
  supportsBle?: boolean;
  bootButtonGpio?: number;
  initialSetupPin?: string;
  initialPairingCode?: string;
  initialWifiSsid?: string;
  defaultProvisionMode?: BleProvisionActionMode;
  allowModeToggle?: boolean;
  onSuccess?: (result: {
    status: BleStatusPayload;
    deviceName?: string;
  }) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="sm:max-w-lg max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <RiBluetoothConnectLine className="size-5 text-primary" aria-hidden="true" />
            {controllerName ? `Setup ${controllerName} with BLE` : "Setup with BLE"}
          </DialogTitle>
          <DialogDescription>
            Connect your HomecoreOS controller over Bluetooth and enter your Wi-Fi network.
          </DialogDescription>
        </DialogHeader>

        <BleProvisioningPanel
          controllerId={controllerId}
          controllerName={controllerName}
          supportsWifi={supportsWifi}
          supportsBle={supportsBle}
          bootButtonGpio={bootButtonGpio}
          initialSetupPin={initialSetupPin}
          initialPairingCode={initialPairingCode}
          initialWifiSsid={initialWifiSsid}
          defaultProvisionMode={defaultProvisionMode}
          onSuccess={onSuccess}
        />

        <DialogFooter>
          <Button type="button" variant="outline" size="sm" onClick={onClose}>
            Close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
