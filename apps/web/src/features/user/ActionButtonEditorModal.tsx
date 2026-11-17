import { useEffect, useRef, useState } from "react";
import {
  RiGlobalLine,
  RiGroupLine,
  RiHome4Line,
  RiMagicLine,
  RiRobot2Line,
  RiShieldCheckLine,
} from "@remixicon/react";
import { toast } from "sonner";
import {
  ACTION_BUTTON_CATEGORIES,
  ACTION_BUTTON_CATEGORY_LABELS,
  ACTION_BUTTON_COLORS,
  ACTION_BUTTON_ICONS,
  validateActionButtonGestures,
  type ActionButtonCategory,
  type ActionButtonColor,
  type ActionButtonGestures,
} from "@homecoreos/shared";
import { apiFetch, ApiError } from "@/lib/api";
import {
  ActionButtonGlyph,
  actionButtonColorHex,
} from "@/components/action-button/action-button-glyphs";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { FormField } from "@/components/shared/AppUi";
import { cn } from "@/lib/utils";
import type { ActionButtonConfigItem } from "@/features/types";
import type { ActionButtonInventory } from "./action-button-inventory";
import { nextStepId } from "./action-button-summary";
import { ActionButtonStepsEditor } from "./ActionButtonStepsEditor";
import { notifyActionButtonConfigChanged } from "@/components/dynamic-island/IslandActionButton";

const CATEGORY_ICONS: Record<ActionButtonCategory, typeof RiGlobalLine> = {
  global: RiGlobalLine,
  room: RiHome4Line,
  group: RiGroupLine,
  automation: RiRobot2Line,
  custom: RiMagicLine,
};

function defaultGesturesFor(
  category: ActionButtonCategory,
  inventory: ActionButtonInventory
): ActionButtonGestures {
  switch (category) {
    case "global":
      return {
        single: [{ id: nextStepId(), kind: "all", target: "all", op: "off" }],
        double: null,
        long: null,
      };
    case "room":
      return {
        single: inventory.rooms[0]
          ? [
              {
                id: nextStepId(),
                kind: "room",
                roomId: inventory.rooms[0].id,
                target: "all",
                op: "off",
              },
            ]
          : [],
        double: null,
        long: null,
      };
    case "group":
      return { single: [], double: null, long: null };
    case "automation":
      return {
        single: inventory.automations[0]
          ? [
              {
                id: nextStepId(),
                kind: "automation",
                automationId: inventory.automations[0].id,
              },
            ]
          : [],
        double: null,
        long: null,
      };
    case "custom":
      return { single: [], double: null, long: null };
  }
}

export function ActionButtonEditorModal({
  open,
  onOpenChange,
  editing,
  inventory,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  editing: ActionButtonConfigItem | null;
  inventory: ActionButtonInventory;
  onSaved: () => void;
}) {
  const [name, setName] = useState("");
  const [icon, setIcon] = useState<string>("zap");
  const [color, setColor] = useState<ActionButtonColor>("blue");
  const [category, setCategory] = useState<ActionButtonCategory>("global");
  const [gestures, setGestures] = useState<ActionButtonGestures>({
    single: [],
    double: null,
    long: null,
  });
  const [confirmationRequired, setConfirmationRequired] = useState(false);
  const [isEnabled, setIsEnabled] = useState(true);
  const [saving, setSaving] = useState(false);

  const initKeyRef = useRef<string | null>(null);
  useEffect(() => {
    if (!open) {
      initKeyRef.current = null;
      return;
    }
    const initKey = `${editing?.id ?? "new"}`;
    if (initKeyRef.current === initKey) return;
    initKeyRef.current = initKey;
    if (editing) {
      setName(editing.name);
      setIcon(editing.icon);
      setColor((editing.color as ActionButtonColor) ?? "blue");
      setCategory(editing.category);
      setGestures(editing.config);
      setConfirmationRequired(editing.confirmationRequired);
      setIsEnabled(editing.isEnabled);
    } else {
      setName("");
      setIcon("zap");
      setColor("blue");
      setCategory("global");
      setGestures(defaultGesturesFor("global", inventory));
      setConfirmationRequired(false);
      setIsEnabled(true);
    }
    setSaving(false);
  }, [open, editing, inventory]);

  const changeCategory = (next: ActionButtonCategory) => {
    setCategory(next);
    // Steps are builder-shaped per category; reset predictably on switch.
    setGestures(defaultGesturesFor(next, inventory));
  };

  const handleSave = async () => {
    const trimmed = name.trim();
    if (!trimmed) {
      toast.error("Give this button a name.");
      return;
    }
    const sanitized: ActionButtonGestures = {
      single: gestures.single,
      double: gestures.double && gestures.double.length > 0 ? gestures.double : null,
      long: gestures.long && gestures.long.length > 0 ? gestures.long : null,
    };
    const validation = validateActionButtonGestures(sanitized);
    if (!validation.ok) {
      toast.error(validation.errors[0] ?? "Fix the action steps before saving.");
      return;
    }

    setSaving(true);
    const body = {
      name: trimmed,
      icon,
      color,
      category,
      config: sanitized,
      confirmationRequired,
      isEnabled,
    };
    try {
      if (editing) {
        await apiFetch(`/api/action-button/configs/${editing.id}`, {
          method: "PATCH",
          body: JSON.stringify(body),
        });
        toast.success(`Action button "${trimmed}" updated.`);
      } else {
        await apiFetch("/api/action-button/configs", {
          method: "POST",
          body: JSON.stringify({ ...body, isActive: false }),
        });
        toast.success(`Action button "${trimmed}" created.`);
      }
      notifyActionButtonConfigChanged();
      onSaved();
      onOpenChange(false);
    } catch (err) {
      toast.error(
        err instanceof ApiError ? err.message : "Failed to save the action button."
      );
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[92dvh] max-w-2xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{editing ? "Edit action button" : "New action button"}</DialogTitle>
          <DialogDescription>
            Assign a gesture-driven action to your Dynamic Island. It only drives
            existing switches, devices, rooms and automations.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          {/* Name */}
          <FormField id="ab-name" label="Name">
            <Input
              id="ab-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Movie Time, Goodnight, All Off"
              maxLength={60}
              autoFocus={!editing}
            />
          </FormField>

          {/* Icon + color */}
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-[1fr_auto]">
            <div className="space-y-1.5">
              <span className="text-xs font-medium text-muted-foreground">Icon</span>
              <div className="flex flex-wrap gap-1.5">
                {ACTION_BUTTON_ICONS.map((iconKey) => (
                  <button
                    key={iconKey}
                    type="button"
                    aria-pressed={icon === iconKey}
                    aria-label={`Icon ${iconKey}`}
                    onClick={() => setIcon(iconKey)}
                    className={cn(
                      "flex size-9 items-center justify-center rounded-lg border transition",
                      icon === iconKey
                        ? "border-primary bg-primary/10 ring-2 ring-primary/40"
                        : "hover:border-primary/40 hover:bg-accent"
                    )}
                  >
                    <ActionButtonGlyph icon={iconKey} className="size-4" />
                  </button>
                ))}
              </div>
            </div>
            <div className="space-y-1.5">
              <span className="text-xs font-medium text-muted-foreground">Color</span>
              <div className="flex max-w-[136px] flex-wrap gap-1.5">
                {ACTION_BUTTON_COLORS.map((colorKey) => (
                  <button
                    key={colorKey}
                    type="button"
                    aria-pressed={color === colorKey}
                    aria-label={`Color ${colorKey}`}
                    onClick={() => setColor(colorKey)}
                    className={cn(
                      "size-7 rounded-full transition",
                      color === colorKey
                        ? "scale-110 ring-2 ring-foreground/30 ring-offset-2"
                        : "hover:scale-105"
                    )}
                    style={{ backgroundColor: actionButtonColorHex(colorKey) }}
                  />
                ))}
              </div>
            </div>
          </div>

          {/* Category */}
          <div className="space-y-1.5">
            <span className="text-xs font-medium text-muted-foreground">What should it do?</span>
            <div
              role="radiogroup"
              aria-label="Action type"
              className="flex flex-wrap gap-1.5"
            >
              {ACTION_BUTTON_CATEGORIES.map((cat) => {
                const IconComponent = CATEGORY_ICONS[cat];
                const selected = category === cat;
                return (
                  <button
                    key={cat}
                    type="button"
                    role="radio"
                    aria-checked={selected}
                    onClick={() => changeCategory(cat)}
                    className={cn(
                      "flex items-center gap-1.5 rounded-full border px-2.5 py-1.5 text-[11px] font-medium transition",
                      selected
                        ? "border-primary bg-primary/10 text-primary ring-1 ring-primary/40"
                        : "text-muted-foreground hover:border-primary/40 hover:text-foreground"
                    )}
                  >
                    <IconComponent className="size-3.5" aria-hidden="true" />
                    {ACTION_BUTTON_CATEGORY_LABELS[cat]}
                  </button>
                );
              })}
            </div>
            <p className="text-[10px] text-muted-foreground">
              Switching the action type resets the gesture steps.
            </p>
          </div>

          {/* Gestures */}
          <ActionButtonStepsEditor
            category={category}
            gestures={gestures}
            onChange={setGestures}
            inventory={inventory}
          />

          {/* Toggles */}
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <label className="flex cursor-pointer items-start justify-between gap-3 rounded-xl border p-3">
              <span>
                <span className="flex items-center gap-1.5 text-xs font-semibold">
                  <RiShieldCheckLine className="size-4 text-primary" aria-hidden="true" />
                  Confirm before running
                </span>
                <span className="mt-0.5 block text-[11px] text-muted-foreground">
                  First tap arms the island button; second tap executes.
                </span>
              </span>
              <Switch
                checked={confirmationRequired}
                onCheckedChange={setConfirmationRequired}
                aria-label="Confirm before running"
              />
            </label>
            <label className="flex cursor-pointer items-start justify-between gap-3 rounded-xl border p-3">
              <span>
                <span className="text-xs font-semibold">Enabled</span>
                <span className="mt-0.5 block text-[11px] text-muted-foreground">
                  Disabled buttons stay saved but won&apos;t run from the island.
                </span>
              </span>
              <Switch
                checked={isEnabled}
                onCheckedChange={setIsEnabled}
                aria-label="Enable this button"
              />
            </label>
          </div>
        </div>

        <DialogFooter className="gap-2">
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={() => void handleSave()} disabled={saving}>
            {saving ? "Saving..." : editing ? "Save changes" : "Create button"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
