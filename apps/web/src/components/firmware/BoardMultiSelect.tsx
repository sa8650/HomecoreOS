import { useMemo, useState } from "react";
import { RiArrowDownSLine, RiCheckLine, RiCloseLine, RiSearchLine } from "@remixicon/react";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/reui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { ScrollArea } from "@/components/ui/scroll-area";
import type { BoardProfileItem } from "@/features/types";

export function BoardMultiSelect({
  boards,
  selectedIds,
  onChange,
  chipFamily,
  getBoardConflictReason,
  placeholder = "Select compatible boards...",
  ariaLabel = "Compatible Boards",
}: {
  boards: BoardProfileItem[];
  selectedIds: string[];
  onChange: (ids: string[]) => void;
  chipFamily?: string;
  getBoardConflictReason?: (board: BoardProfileItem) => string | null;
  placeholder?: string;
  ariaLabel?: string;
}) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");

  const filteredBoards = useMemo(() => {
    const q = search.trim().toLowerCase();
    return boards.filter((b) => {
      if (!q) return true;
      return `${b.manufacturer} ${b.model} ${b.slug} ${b.chip_family}`
        .toLowerCase()
        .includes(q);
    });
  }, [boards, search]);

  const selectedBoards = useMemo(
    () => boards.filter((b) => selectedIds.includes(b.id)),
    [boards, selectedIds]
  );

  function toggleBoard(id: string) {
    if (selectedIds.includes(id)) {
      onChange(selectedIds.filter((x) => x !== id));
    } else {
      onChange([...selectedIds, id]);
    }
  }

  function selectMatchingChip() {
    if (!chipFamily) return;
    const matching = boards
      .filter((b) => b.chip_family === chipFamily)
      .map((b) => b.id);
    onChange(Array.from(new Set([...selectedIds, ...matching])));
  }

  return (
    <div className="space-y-2">
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button
            type="button"
            variant="outline"
            role="combobox"
            aria-label={ariaLabel}
            aria-expanded={open}
            className="w-full justify-between font-normal text-xs"
          >
            <span className="truncate">
              {selectedBoards.length === 0
                ? placeholder
                : `${selectedBoards.length} board${selectedBoards.length === 1 ? "" : "s"} selected`}
            </span>
            <RiArrowDownSLine className="size-4 opacity-60 shrink-0" aria-hidden="true" />
          </Button>
        </PopoverTrigger>
        <PopoverContent align="start" className="w-[340px] sm:w-[400px] p-2.5">
          <div className="space-y-2">
            <div className="relative">
              <RiSearchLine
                className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground"
                aria-hidden="true"
              />
              <Input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search board model, manufacturer, chip..."
                className="h-8 pl-8 text-xs"
              />
            </div>

            <div className="flex items-center justify-between gap-2 text-[11px]">
              {chipFamily && (
                <button
                  type="button"
                  onClick={selectMatchingChip}
                  className="font-medium text-primary hover:underline cursor-pointer"
                >
                  Select all {chipFamily.toUpperCase()} boards
                </button>
              )}
              {selectedIds.length > 0 && (
                <button
                  type="button"
                  onClick={() => onChange([])}
                  className="text-muted-foreground hover:text-foreground cursor-pointer ml-auto"
                >
                  Clear all
                </button>
              )}
            </div>

            <ScrollArea className="h-[220px] pr-2">
              {filteredBoards.length === 0 ? (
                <div className="py-8 text-center text-xs text-muted-foreground">
                  No matching boards found.
                </div>
              ) : (
                <div className="space-y-1">
                  {filteredBoards.map((board) => {
                    const checked = selectedIds.includes(board.id);
                    const chipMismatch = Boolean(
                      chipFamily && board.chip_family !== chipFamily
                    );
                    const conflictReason =
                      getBoardConflictReason?.(board) ??
                      (chipMismatch ? "Chip mismatch" : null);
                    return (
                      <label
                        key={board.id}
                        className={cn(
                          "flex cursor-pointer items-center justify-between gap-2 rounded-md px-2 py-1.5 text-xs transition hover:bg-muted/60",
                          checked && "bg-primary/[0.06]"
                        )}
                      >
                        <div className="flex items-center gap-2 min-w-0">
                          <Checkbox
                            checked={checked}
                            onCheckedChange={() => toggleBoard(board.id)}
                          />
                          <div className="min-w-0">
                            <p className="truncate font-medium text-foreground">
                              {board.manufacturer} {board.model}
                            </p>
                            <p className="truncate font-mono text-[10px] text-muted-foreground">
                              {board.chip_family.toUpperCase()} · {board.flash_size_mb}MB Flash
                            </p>
                          </div>
                        </div>
                        {conflictReason ? (
                          <Badge variant="warning-light" size="xs">
                            {conflictReason}
                          </Badge>
                        ) : (
                          checked && <RiCheckLine className="size-3.5 text-primary shrink-0" />
                        )}
                      </label>
                    );
                  })}
                </div>
              )}
            </ScrollArea>
          </div>
        </PopoverContent>
      </Popover>

      {selectedBoards.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {selectedBoards.map((board) => {
            const chipMismatch = Boolean(chipFamily && board.chip_family !== chipFamily);
            const hasConflict = Boolean(
              chipMismatch || getBoardConflictReason?.(board)
            );
            return (
              <Badge
                key={board.id}
                variant={hasConflict ? "destructive-light" : "primary-light"}
                size="sm"
                radius="full"
                className="gap-1 pr-1"
              >
                <span>
                  {board.model} ({board.flash_size_mb}MB)
                </span>
                <button
                  type="button"
                  aria-label={`Remove ${board.model}`}
                  onClick={() => toggleBoard(board.id)}
                  className="rounded-full p-0.5 hover:bg-foreground/10 cursor-pointer"
                >
                  <RiCloseLine className="size-3" />
                </button>
              </Badge>
            );
          })}
        </div>
      )}
    </div>
  );
}
