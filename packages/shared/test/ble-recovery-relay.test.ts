import { describe, expect, it } from "vitest";
import { validateBleProvisioningInputs, type BleCommandPayload } from "../src/ble-provisioning";

describe("BLE recovery console relay", () => {
  it.each(["HC PING", "HC HELLO", "HC STATUS", 'HC REPAIR {"action":"mqtt"}'])(
    "accepts %s without requiring provisioning credentials", (command) => {
      const payload: BleCommandPayload = { action: `hc ${command}` };
      expect(validateBleProvisioningInputs(payload)).toEqual({ valid: true });
    }
  );

  it("accepts long Wi-Fi repair relay commands up to HC_RECOVERY_LINE_MAX (512 bytes)", () => {
    const longWifiCmd = `HC REPAIR {"action":"wifi","ssid":"${"S".repeat(32)}","password":"${"P".repeat(63)}","websiteUrl":"https://${"a".repeat(120)}.example.com"}`;
    expect(longWifiCmd.length).toBeGreaterThan(240);
    expect(longWifiCmd.length).toBeLessThanOrEqual(512);
    expect(validateBleProvisioningInputs({ action: `hc ${longWifiCmd}` })).toEqual({ valid: true });
  });

  it.each(["hc ", "hc reboot", "hc HC STATUS\nHC REPAIR {}", `hc HC REPAIR {"x":"${"a".repeat(500)}"}`])(
    "rejects malformed, multiline or oversized relay commands", (action) => {
      expect(validateBleProvisioningInputs({ action: action as `hc ${string}` }).valid).toBe(false);
    }
  );

  it("still requires a recovery code for legacy re-pairing", () => {
    expect(validateBleProvisioningInputs({ action: "recover" }).valid).toBe(false);
  });
});
