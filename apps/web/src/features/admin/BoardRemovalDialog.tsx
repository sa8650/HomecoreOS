import { useEffect, useRef, useState } from "react";
import { RiAlertLine, RiLoader4Line } from "@remixicon/react";
import { toast } from "sonner";
import { apiFetch, ApiError } from "@/lib/api";
import { StatusAlert } from "@/components/shared/AppUi";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Skeleton } from "@/components/ui/skeleton";
import type { BoardProfileItem, BoardUsageInfo } from "../types";

/**
 * Confirmation for removing a board from the global catalog. It first asks
 * the server what depends on the board, shows exactly that, and only offers
 * the removal when nothing would break.
 */
export function BoardRemovalDialog({
  board,
  onOpenChange,
  onRemoved,
}: {
  /** The board to remove; null keeps the dialog closed. */
  board: BoardProfileItem | null;
  onOpenChange: (open: boolean) => void;
  onRemoved: () => Promise<void> | void;
}) {
  const [usage, setUsage] = useState<BoardUsageInfo | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [removing, setRemoving] = useState(false);
  const removingRef = useRef(false);
  const boardId = board?.id ?? null;

  useEffect(() => {
    setUsage(null);
    setLoadError(null);
    if (!boardId) return;
    let cancelled = false;
    apiFetch<{ usage: BoardUsageInfo }>(`/api/admin/boards/${boardId}/usage`)
      .then((res) => {
        if (!cancelled) setUsage(res.usage);
      })
      .catch((err) => {
        if (!cancelled) {
          setLoadError(
            err instanceof ApiError ? err.message : "Could not check what uses this board."
          );
        }
      });
    return () => {
      cancelled = true;
    };
  }, [boardId]);

  async function handleRemove() {
    if (!board || removingRef.current) return;
    removingRef.current = true;
    setRemoving(true);
    try {
      await apiFetch(`/api/admin/boards/${board.id}`, { method: "DELETE" });
      toast.success(`Removed "${board.manufacturer} ${board.model}" from the Board Library.`);
      onOpenChange(false);
      await onRemoved();
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        // Something started using the board in the meantime: show the fresh state.
        setLoadError(err.message);
        try {
          const res = await apiFetch<{ usage: BoardUsageInfo }>(
            `/api/admin/boards/${board.id}/usage`
          );
          setUsage(res.usage);
          setLoadError(null);
        } catch {
          // keep the server message
        }
      } else {
        toast.error(err instanceof ApiError ? err.message : "The board could not be removed.");
      }
    } finally {
      removingRef.current = false;
      setRemoving(false);
    }
  }

  const name = board ? `${board.manufacturer} ${board.model}` : "";
  const blocked = usage !== null && !usage.canRemove;

  return (
    <AlertDialog open={Boolean(board)} onOpenChange={(open) => !removing && onOpenChange(open)}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>
            {blocked ? `"${name}" cannot be removed` : `Remove "${name}"?`}
          </AlertDialogTitle>
          <AlertDialogDescription>
            {blocked
              ? "This board is in use. Removing it would break existing controllers."
              : "The board is taken out of the global Board Library. Its configuration is kept and can be restored."}
          </AlertDialogDescription>
        </AlertDialogHeader>

        <div className="space-y-3 text-xs">
          {!usage && !loadError && (
            <div role="status" className="space-y-2">
              <p className="flex items-center gap-2 text-muted-foreground">
                <RiLoader4Line className="size-4 animate-spin" aria-hidden="true" />
                Checking what uses this board...
              </p>
              <Skeleton className="h-4 w-4/5" />
              <Skeleton className="h-4 w-3/5" />
            </div>
          )}

          {loadError && <StatusAlert tone="danger">{loadError}</StatusAlert>}

          {usage && (
            <>
              <dl className="grid grid-cols-3 gap-2 text-center">
                {(
                  [
                    ["Controllers", usage.controllerCount],
                    ["Saved by accounts", usage.savedByAccountCount],
                    ["Firmware releases", usage.firmwareReleaseCount],
                  ] as const
                ).map(([label, value]) => (
                  <div key={label} className="rounded-lg border bg-muted/30 px-2 py-2">
                    <dd className="text-base font-semibold tabular-nums text-foreground">{value}</dd>
                    <dt className="text-[10px] text-muted-foreground">{label}</dt>
                  </div>
                ))}
              </dl>

              {usage.blockers.length > 0 && (
                <ul className="space-y-1.5" aria-label="Why the board cannot be removed">
                  {usage.blockers.map((line) => (
                    <li key={line} className="flex items-start gap-1.5 text-destructive">
                      <RiAlertLine className="mt-px size-3.5 shrink-0" aria-hidden="true" />
                      <span>{line}</span>
                    </li>
                  ))}
                </ul>
              )}

              {usage.canRemove && (
                <ul
                  className="list-disc space-y-1 pl-4 text-muted-foreground"
                  aria-label="What removing the board does"
                >
                  {usage.consequences.map((line) => (
                    <li key={line}>{line}</li>
                  ))}
                </ul>
              )}
            </>
          )}
        </div>

        <AlertDialogFooter>
          <AlertDialogCancel disabled={removing}>{blocked ? "Close" : "Cancel"}</AlertDialogCancel>
          {!blocked && (
            <AlertDialogAction
              variant="destructive"
              disabled={!usage || removing}
              onClick={(e) => {
                e.preventDefault();
                void handleRemove();
              }}
            >
              {removing ? "Removing..." : "Remove board"}
            </AlertDialogAction>
          )}
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
