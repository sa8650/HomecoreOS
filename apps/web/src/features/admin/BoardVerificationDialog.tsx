import { useEffect, useState, type FormEvent } from "react";
import type { GpioPinDefinition } from "@homecoreos/shared";
import { RiAddLine, RiDeleteBinLine, RiShieldCheckLine } from "@remixicon/react";
import { toast } from "sonner";
import { apiFetch, ApiError } from "@/lib/api";
import { FormField, StatusAlert } from "@/components/shared/AppUi";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import type { BoardProfileItem } from "../types";

function makeDefaultGpio(pin: number): GpioPinDefinition {
  return {
    pin,
    label: `GPIO${pin}`,
    board_pin_name: `GPIO${pin}`,
    capabilities: {
      digital_in: true,
      digital_out: true,
      pwm: true,
      adc: false,
      i2c: true,
      spi: true,
      uart: true,
      touch: false,
      pull_up: true,
      pull_down: true,
    },
    restrictions: {
      input_only: false,
      reserved: false,
      strapping_pin: false,
      flash_psram_conflict: false,
      usb_jtag_conflict: false,
    },
  };
}

export function BoardVerificationDialog({
  board,
  onOpenChange,
  onSaved,
}: {
  board: BoardProfileItem | null;
  onOpenChange: (open: boolean) => void;
  onSaved: () => Promise<void> | void;
}) {
  const [gpios, setGpios] = useState<GpioPinDefinition[]>([]);
  const [bulkPins, setBulkPins] = useState("");
  const [docsUrl, setDocsUrl] = useState("");
  const [revisionNotes, setRevisionNotes] = useState("");
  const [markVerified, setMarkVerified] = useState(true);
  const [publishNow, setPublishNow] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!board) return;
    setGpios(
      (board.gpio_definitions ?? []).map((g) => ({
        ...g,
        capabilities: { ...g.capabilities },
        restrictions: { ...g.restrictions },
      }))
    );
    setBulkPins("");
    setDocsUrl(board.docs_url ?? "");
    setRevisionNotes(board.revision_notes ?? "");
    setMarkVerified(true);
    setPublishNow(Boolean(board.is_available));
    setError(null);
  }, [board]);

  function handleAddBulkPins() {
    const nums = bulkPins
      .split(/[\s,;]+/)
      .map((s) => Number(s.trim()))
      .filter((n) => Number.isInteger(n) && n >= 0 && n <= 54);
    if (nums.length === 0) {
      setError("Enter one or more GPIO numbers between 0 and 54 (comma-separated).");
      return;
    }
    setError(null);
    setGpios((prev) => {
      const existing = new Set(prev.map((g) => g.pin));
      const added = Array.from(new Set(nums))
        .filter((n) => !existing.has(n))
        .map((n) => makeDefaultGpio(n));
      return [...prev, ...added].sort((a, b) => a.pin - b.pin);
    });
    setBulkPins("");
  }

  function handleAddSinglePin() {
    const existing = new Set(gpios.map((g) => g.pin));
    let nextPin = 0;
    while (existing.has(nextPin) && nextPin < 54) nextPin += 1;
    setGpios((prev) => [...prev, makeDefaultGpio(nextPin)].sort((a, b) => a.pin - b.pin));
  }

  function updatePin(index: number, updater: (prev: GpioPinDefinition) => GpioPinDefinition) {
    setGpios((prev) => prev.map((item, i) => (i === index ? updater(item) : item)));
  }

  function removePin(index: number) {
    setGpios((prev) => prev.filter((_, i) => i !== index));
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (!board) return;
    setSaving(true);
    setError(null);
    try {
      const nextStatus = markVerified ? "verified" : "needs_verification";
      await apiFetch(`/api/admin/boards/${board.id}`, {
        method: "PATCH",
        body: JSON.stringify({
          gpio_definitions: gpios,
          verification_status: nextStatus,
          is_available: markVerified ? publishNow : false,
          docs_url: docsUrl.trim() || null,
          revision_notes: revisionNotes.trim() || null,
        }),
      });
      toast.success(
        markVerified
          ? `Verified pinout for "${board.manufacturer} ${board.model}" (${gpios.length} pins).`
          : `Saved draft pinout for "${board.manufacturer} ${board.model}".`
      );
      await onSaved();
      onOpenChange(false);
    } catch (err) {
      setError(
        err instanceof ApiError
          ? err.message
          : "Failed to save board GPIO verification."
      );
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={Boolean(board)} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-4xl max-h-[90dvh] overflow-y-auto p-4">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-base">
            <RiShieldCheckLine className="size-4 text-primary" aria-hidden="true" />
            Verify & Edit Pinout — {board?.manufacturer} {board?.model}
          </DialogTitle>
          <DialogDescription className="text-xs">
            {board?.chip_variant} · {board?.chip_family.toUpperCase()} · {board?.flash_size_mb} MB
            Flash / {board?.psram_size_mb} MB PSRAM. Verified pin definitions are validated against
            all active controllers before saving.
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={(e) => void handleSubmit(e)} className="space-y-4">
          {error && <StatusAlert tone="danger">{error}</StatusAlert>}

          <div className="grid gap-3 sm:grid-cols-2">
            <FormField label="Hardware Documentation URL" id="verify-docs-url">
              <Input
                id="verify-docs-url"
                value={docsUrl}
                onChange={(e) => setDocsUrl(e.target.value)}
                placeholder="https://docs.espressif.com/..."
              />
            </FormField>
            <FormField label="Verification / Revision Notes" id="verify-rev-notes">
              <Input
                id="verify-rev-notes"
                value={revisionNotes}
                onChange={(e) => setRevisionNotes(e.target.value)}
                placeholder="Verified against official schematic rev..."
              />
            </FormField>
          </div>

          <div className="space-y-2 rounded-lg border border-border bg-muted/20 p-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <p className="text-xs font-semibold text-foreground">
                  GPIO Definitions ({gpios.length})
                </p>
                <p className="text-[11px] text-muted-foreground">
                  Quick-add safe GPIO numbers or edit individual capabilities and restrictions.
                </p>
              </div>
              <div className="flex flex-wrap items-center gap-1.5">
                <Input
                  aria-label="Quick-add GPIO numbers"
                  className="h-8 w-52 font-mono text-xs"
                  value={bulkPins}
                  onChange={(e) => setBulkPins(e.target.value)}
                  placeholder="e.g. 2, 4, 5, 12, 13, 14"
                />
                <Button type="button" size="xs" variant="outline" onClick={handleAddBulkPins}>
                  Add List
                </Button>
                <Button type="button" size="xs" variant="outline" onClick={handleAddSinglePin}>
                  <RiAddLine className="size-3.5" aria-hidden="true" />
                  Add Pin
                </Button>
              </div>
            </div>

            {gpios.length === 0 ? (
              <p className="py-4 text-center text-xs text-muted-foreground">
                No GPIO pins defined yet. Add verified pins above before marking this board as
                verified.
              </p>
            ) : (
              <div className="max-h-72 overflow-auto rounded-md border border-border bg-background">
                <table className="w-full min-w-[540px] text-xs">
                  <thead className="sticky top-0 z-10 border-b border-border bg-muted text-left text-[11px] text-muted-foreground">
                    <tr>
                      <th className="px-2 py-1.5">GPIO</th>
                      <th className="px-2 py-1.5">Label</th>
                      <th className="px-2 py-1.5">Capabilities</th>
                      <th className="px-2 py-1.5">Restrictions</th>
                      <th className="px-2 py-1.5 text-right">Remove</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {gpios.map((g, idx) => (
                      <tr key={`${g.pin}-${idx}`}>
                        <td className="px-2 py-1.5">
                          <Input
                            type="number"
                            min={0}
                            max={54}
                            aria-label={`GPIO pin number row ${idx + 1}`}
                            className="h-7 w-16 font-mono text-xs"
                            value={g.pin}
                            onChange={(e) => {
                              const nextVal = Math.max(0, Math.min(54, Number(e.target.value) || 0));
                              updatePin(idx, (cur) => ({ ...cur, pin: nextVal }));
                            }}
                          />
                        </td>
                        <td className="px-2 py-1.5">
                          <Input
                            aria-label={`GPIO label row ${idx + 1}`}
                            className="h-7 w-28 text-xs"
                            value={g.label}
                            onChange={(e) =>
                              updatePin(idx, (cur) => ({ ...cur, label: e.target.value }))
                            }
                          />
                        </td>
                        <td className="px-2 py-1.5">
                          <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
                            {(
                              [
                                ["digital_out", "OUT"],
                                ["digital_in", "IN"],
                                ["pwm", "PWM"],
                                ["adc", "ADC"],
                                ["i2c", "I2C"],
                              ] as const
                            ).map(([capKey, capLbl]) => (
                              <label
                                key={capKey}
                                className="inline-flex items-center gap-1 text-[11px]"
                              >
                                <Checkbox
                                  checked={Boolean(g.capabilities[capKey])}
                                  onCheckedChange={(checked) =>
                                    updatePin(idx, (cur) => ({
                                      ...cur,
                                      capabilities: {
                                        ...cur.capabilities,
                                        [capKey]: Boolean(checked),
                                      },
                                    }))
                                  }
                                />
                                <span>{capLbl}</span>
                              </label>
                            ))}
                          </div>
                        </td>
                        <td className="px-2 py-1.5">
                          <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
                            {(
                              [
                                ["input_only", "In-only"],
                                ["reserved", "Reserved"],
                                ["strapping_pin", "Strap"],
                              ] as const
                            ).map(([resKey, resLbl]) => (
                              <label
                                key={resKey}
                                className="inline-flex items-center gap-1 text-[11px]"
                              >
                                <Checkbox
                                  checked={Boolean(g.restrictions[resKey])}
                                  onCheckedChange={(checked) => {
                                    const flag = Boolean(checked);
                                    updatePin(idx, (cur) => ({
                                      ...cur,
                                      capabilities:
                                        resKey === "input_only" && flag
                                          ? { ...cur.capabilities, digital_out: false, pwm: false }
                                          : cur.capabilities,
                                      restrictions: {
                                        ...cur.restrictions,
                                        [resKey]: flag,
                                      },
                                    }));
                                  }}
                                />
                                <span>{resLbl}</span>
                              </label>
                            ))}
                          </div>
                        </td>
                        <td className="px-2 py-1.5 text-right">
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon-sm"
                            aria-label={`Remove GPIO ${g.pin}`}
                            onClick={() => removePin(idx)}
                          >
                            <RiDeleteBinLine className="size-3.5 text-destructive" />
                          </Button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          <div className="flex flex-wrap items-center justify-between gap-4 rounded-lg border border-border px-3 py-2.5">
            <div className="flex items-center gap-2">
              <Switch
                id="verify-mark-verified"
                checked={markVerified}
                onCheckedChange={(checked) => {
                  setMarkVerified(checked);
                  if (!checked) setPublishNow(false);
                }}
              />
              <Label htmlFor="verify-mark-verified" className="text-xs font-medium">
                Mark pinout as Verified
              </Label>
            </div>
            <div className="flex items-center gap-2">
              <Switch
                id="verify-publish-now"
                checked={publishNow}
                disabled={!markVerified}
                onCheckedChange={setPublishNow}
              />
              <Label htmlFor="verify-publish-now" className="text-xs font-medium">
                Publish to Board Library immediately
              </Label>
            </div>
          </div>

          <DialogFooter>
            <Button type="button" variant="outline" size="sm" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" size="sm" disabled={saving}>
              {saving ? "Saving..." : markVerified ? "Save & Verify Pinout" : "Save Draft"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
