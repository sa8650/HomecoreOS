import { useCallback, useEffect, useState } from "react";
import {
  RiAddLine,
  RiCheckLine,
  RiDeleteBinLine,
  RiEditLine,
  RiVipCrownLine,
} from "@remixicon/react";
import { toast } from "sonner";
import {
  ACTION_BUTTON_CATEGORY_LABELS,
  isGestureConfigured,
} from "@homecoreos/shared";
import { apiFetch, ApiError } from "@/lib/api";
import {
  ConfirmDeleteDialog,
  EmptyStatePanel,
} from "@/components/shared/AppUi";
import {
  ActionButtonGlyph,
  actionButtonColorHex,
  aggregateStateLabel,
} from "@/components/action-button/action-button-glyphs";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/reui/badge";
import { Switch } from "@/components/ui/switch";
import { cn } from "cn";
import type { ActionButtonConfigItem } from "@/features/types";
import { useActionButtonInventory } from "./action-button-inventory";
import { ActionButtonEditorModal } from "./ActionButtonEditorModal";
import { notifyActionButtonConfigChanged } from "@/components/dynamic-island/IslandActionButton";

function GestureDots({ config }: { config: ActionButtonConfigItem }) {
  const items: Array<{ key: "single" | "double" | "long"; label: string }> = [
    { key: "single", label: "Single press" },
    { key: "double", label: "Double press" },
    { key: "long", label: "Long press" },
  ];
  return (
    <span className="flex items-center gap-1" aria-hidden="true">
      {items.map(({ key, label }) => {
        const configured =
          key === "single" || isGestureConfigured(config.config, key);
        return (
          <span
            key={key}
            title={label}
            className={cn(
              "flex h-4 rounded-full border px-1 font-mono text-[8px] font-bold leading-[14px]",
              configured
                ? "border-primary/30 bg-primary/10 text-primary"
                : "border-transparent text-muted-foreground/40"
            )}
          >
            {key === "single" ? "S" : key === "double" ? "D" : "L"}
          </span>
        );
      })}
    </span>
  );
}

export function ActionButtonSettingsCard() {
  const [configs, setConfigs] = useState<ActionButtonConfigItem[] | null>(null);
  const [busyIds, setBusyIds] = useState<Record<string, boolean>>({});
  const [editorOpen, setEditorOpen] = useState(false);
  const [editing, setEditing] = useState<ActionButtonConfigItem | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<ActionButtonConfigItem | null>(null);
  const [deleting, setDeleting] = useState(false);
  const inventory = useActionButtonInventory(true);

  const load = useCallback(async () => {
    try {
      const res = await apiFetch<{ configs?: ActionButtonConfigItem[] }>(
        "/api/action-button/configs"
      );
      setConfigs(res.configs ?? []);
    } catch (err) {
      setConfigs([]);
      toast.error(
        err instanceof ApiError
          ? err.message
          : "Failed to load action button configurations."
      );
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const setBusy = (id: string, busy: boolean) =>
    setBusyIds((prev) => {
      const next = { ...prev };
      if (busy) next[id] = true;
      else delete next[id];
      return next;
    });

  const patchConfig = useCallback(
    async (
      id: string,
      body: Record<string, unknown>,
      successMessage: string
    ) => {
      setBusy(id, true);
      try {
        await apiFetch(`/api/action-button/configs/${id}`, {
          method: "PATCH",
          body: JSON.stringify(body),
        });
        notifyActionButtonConfigChanged();
        await load();
        toast.success(successMessage);
      } catch (err) {
        toast.error(
          err instanceof ApiError ? err.message : "Failed to update the button."
        );
      } finally {
        setBusy(id, false);
      }
    },
    [load]
  );

  const toggleEnabled = (config: ActionButtonConfigItem) =>
    void patchConfig(
      config.id,
      { isEnabled: !config.isEnabled },
      config.isEnabled ? `"${config.name}" disabled.` : `"${config.name}" enabled.`
    );

  const toggleIslandAssignment = (config: ActionButtonConfigItem) =>
    void patchConfig(
      config.id,
      config.isActive
        ? { isActive: false }
        : { isActive: true, isEnabled: true },
      config.isActive
        ? `"${config.name}" removed from the Dynamic Island.`
        : `"${config.name}" is now your island action button.`
    );

  const handleDelete = async () => {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      await apiFetch(`/api/action-button/configs/${deleteTarget.id}`, {
        method: "DELETE",
      });
      notifyActionButtonConfigChanged();
      toast.success(`Action button "${deleteTarget.name}" deleted.`);
      setDeleteTarget(null);
      await load();
    } catch (err) {
      toast.error(
        err instanceof ApiError ? err.message : "Failed to delete the button."
      );
    } finally {
      setDeleting(false);
    }
  };

  return (
    <Card className="py-5" data-testid="action-button-settings">
      <CardContent className="space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <span className="flex size-9 items-center justify-center rounded-xl bg-primary/10">
              <RiVipCrownLine className="size-5 text-primary" aria-hidden="true" />
            </span>
            <div>
              <h2 className="text-sm font-semibold text-foreground">
                Dynamic Island Action Button
              </h2>
              <p className="text-xs text-muted-foreground">
                A gesture-driven shortcut in your workspace pill — per user, synced everywhere.
              </p>
            </div>
          </div>
          <Button
            size="sm"
            onClick={() => {
              setEditing(null);
              setEditorOpen(true);
            }}
          >
            <RiAddLine className="size-4" aria-hidden="true" />
            New Button
          </Button>
        </div>

        {configs === null ? (
          <div className="space-y-2" aria-hidden="true">
            {[0, 1].map((i) => (
              <div key={i} className="h-16 animate-pulse rounded-xl bg-accent/60" />
            ))}
          </div>
        ) : configs.length === 0 ? (
          <EmptyStatePanel
            compact
            icon={<RiVipCrownLine className="size-6" />}
            title="No action buttons yet"
            description="Create one — e.g. a Movie Time scene, Goodnight, or an all-off switch — and assign it to your Dynamic Island."
            action={
              <Button
                size="sm"
                onClick={() => {
                  setEditing(null);
                  setEditorOpen(true);
                }}
              >
                <RiAddLine className="size-4" aria-hidden="true" />
                Create First Button
              </Button>
            }
          />
        ) : (
          <ul className="divide-y rounded-xl border">
            {configs.map((config) => {
              const busy = Boolean(busyIds[config.id]);
              const stateLabel = aggregateStateLabel(config.states);
              const colorHex = actionButtonColorHex(config.color);
              return (
                <li
                  key={config.id}
                  className="flex flex-wrap items-center gap-3 px-3 py-3 sm:flex-nowrap"
                >
                  <span
                    className="flex size-10 shrink-0 items-center justify-center rounded-xl"
                    style={{ backgroundColor: `${colorHex}1f`, color: colorHex }}
                  >
                    <ActionButtonGlyph icon={config.icon} className="size-5" />
                  </span>

                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <span className="truncate text-sm font-semibold">
                        {config.name}
                      </span>
                      {config.isActive && (
                        <Badge variant="primary-light" radius="full">
                          On island
                        </Badge>
                      )}
                      {!config.isEnabled && (
                        <Badge variant="secondary" radius="full">
                          Disabled
                        </Badge>
                      )}
                      {stateLabel && (
                        <Badge
                          variant={
                            stateLabel === "ON"
                              ? "success-light"
                              : stateLabel === "MIXED"
                                ? "warning-light"
                                : "secondary"
                          }
                          radius="full"
                        >
                          {stateLabel}
                        </Badge>
                      )}
                    </div>
                    <div className="mt-1 flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
                      <span>{ACTION_BUTTON_CATEGORY_LABELS[config.category]}</span>
                      <GestureDots config={config} />
                      {config.lastExecutedAt && (
                        <span className="flex items-center gap-1">
                          <span
                            className={cn(
                              "size-1.5 rounded-full",
                              config.lastExecutionStatus === "success" && "bg-emerald-500",
                              config.lastExecutionStatus === "partial" && "bg-amber-500",
                              config.lastExecutionStatus === "failed" && "bg-red-500"
                            )}
                            aria-hidden="true"
                          />
                          Last run{" "}
                          {config.lastExecutionStatus === "success"
                            ? "succeeded"
                            : config.lastExecutionStatus === "partial"
                              ? "partially completed"
                              : "failed"}
                        </span>
                      )}
                    </div>
                    {config.lastExecutionStatus === "failed" && config.lastError && (
                      <p className="mt-1 truncate text-[11px] text-destructive" title={config.lastError}>
                        {config.lastError}
                      </p>
                    )}
                  </div>

                  <div className="flex shrink-0 items-center gap-1.5">
                    <Switch
                      checked={config.isEnabled}
                      disabled={busy}
                      onCheckedChange={() => toggleEnabled(config)}
                      aria-label={`Enable ${config.name}`}
                    />
                    <Button
                      size="sm"
                      variant={config.isActive ? "default" : "outline"}
                      className="h-8 gap-1.5 px-2 text-[11px]"
                      disabled={busy}
                      onClick={() => toggleIslandAssignment(config)}
                      aria-pressed={config.isActive}
                      title={
                        config.isActive
                          ? "Remove from Dynamic Island"
                          : "Assign to Dynamic Island"
                      }
                    >
                      {config.isActive ? (
                        <>
                          <RiCheckLine className="size-3.5" aria-hidden="true" />
                          Island
                        </>
                      ) : (
                        <>
                          <RiVipCrownLine className="size-3.5" aria-hidden="true" />
                          Island
                        </>
                      )}
                    </Button>
                    <button
                      type="button"
                      className="rounded-lg p-2 text-muted-foreground transition hover:bg-accent hover:text-foreground disabled:opacity-50"
                      aria-label={`Edit ${config.name}`}
                      disabled={busy}
                      onClick={() => {
                        setEditing(config);
                        setEditorOpen(true);
                      }}
                    >
                      <RiEditLine className="size-4" aria-hidden="true" />
                    </button>
                    <button
                      type="button"
                      className="rounded-lg p-2 text-muted-foreground transition hover:bg-destructive/10 hover:text-destructive disabled:opacity-50"
                      aria-label={`Delete ${config.name}`}
                      disabled={busy}
                      onClick={() => setDeleteTarget(config)}
                    >
                      <RiDeleteBinLine className="size-4" aria-hidden="true" />
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>
        )}

        <ActionButtonEditorModal
          open={editorOpen}
          onOpenChange={setEditorOpen}
          editing={editing}
          inventory={inventory}
          onSaved={() => void load()}
        />

        <ConfirmDeleteDialog
          open={Boolean(deleteTarget)}
          onOpenChange={(open) => {
            if (!open) setDeleteTarget(null);
          }}
          title="Delete action button?"
          description={
            deleteTarget
              ? `"${deleteTarget.name}" will be removed from your workspace and the Dynamic Island. Switches, devices and automations stay untouched.`
              : ""
          }
          confirmLabel="Delete Button"
          busy={deleting}
          onConfirm={() => void handleDelete()}
        />
      </CardContent>
    </Card>
  );
}
