import type { ReactNode } from "react";
import { displayBoardRevision, resolveBoardHardwareSpecs } from "@homecoreos/shared";
import { RiShieldCheckLine } from "@remixicon/react";
import { BoardVectorSvg } from "@/components/boards/BoardVectorSvg";
import { Badge } from "@/components/reui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { MagicCard } from "@/components/ui/magic-card";
import type { BoardProfileItem } from "@/features/types";

/** How many GPIOs can actually be wired: header pins, plus extra solder pads. */
export function describeBoardPins(board: BoardProfileItem): string {
  const layout = board.board_layout;
  if (!layout) {
    const count = board.gpio_definitions.length;
    return `${count} GPIO${count === 1 ? "" : "s"}`;
  }
  const onHeaders = [...(layout.leftHeader?.pins ?? []), ...(layout.rightHeader?.pins ?? [])].filter(
    (pin) => pin.gpioPin !== null
  ).length;
  const onPads = (layout.extraPads?.pins ?? []).filter((pin) => pin.gpioPin !== null).length;
  return onPads > 0 ? `${onHeaders} on headers + ${onPads} pads` : `${onHeaders} on headers`;
}

/**
 * GPIOs the profile defines that are not brought out to a header pin or a
 * solder pad: a user LED, the BOOT button, a camera connector. They explain
 * why a profile can hold more GPIOs than the board has pins to wire.
 */
export function countOnBoardOnlyGpios(board: BoardProfileItem): number {
  const layout = board.board_layout;
  if (!layout) return 0;
  const wired = new Set<number>();
  for (const pin of [
    ...(layout.leftHeader?.pins ?? []),
    ...(layout.rightHeader?.pins ?? []),
    ...(layout.extraPads?.pins ?? []),
  ]) {
    if (pin.gpioPin !== null) wired.add(pin.gpioPin);
  }
  return board.gpio_definitions.filter((gpio) => !wired.has(gpio.pin)).length;
}

function FirmwareBadge({ board }: { board: BoardProfileItem }) {
  const status = board.firmware_status ?? "catalog_only";
  if (status === "firmware_supported") {
    return (
      <Badge variant="success-light" size="xs">
        Firmware Supported
      </Badge>
    );
  }
  if (status === "build_pending") {
    return (
      <Badge variant="warning-light" size="xs">
        Build Pending
      </Badge>
    );
  }
  if (status === "unsupported") {
    return (
      <Badge variant="destructive-light" size="xs">
        Unsupported
      </Badge>
    );
  }
  return (
    <Badge variant="secondary" size="xs">
      Catalog Only
    </Badge>
  );
}

/**
 * One board in the Board Library grid.
 *
 * Every card has the same anatomy, so a grid of them lines up: the board
 * drawing on top in a fixed-height stage, the name, five label/value rows on
 * a shared column grid, and the actions pinned to the bottom. Each text slot
 * is a single truncated line, which keeps all cards exactly the same height.
 * Everything else about a board lives in its Details view.
 */
export function BoardLibraryCard({
  board,
  source,
  compactDrawing = false,
  onOpenDetails,
  action,
}: {
  board: BoardProfileItem;
  /** Where the profile comes from. */
  source: "official" | "partner" | "custom";
  /** Use the simplified drawing (for boards without a documented layout). */
  compactDrawing?: boolean;
  onOpenDetails: () => void;
  /** Secondary action next to "Details": save, unsave or delete. */
  action?: ReactNode;
}) {
  const specs = resolveBoardHardwareSpecs(board);
  const verified = source !== "custom" && board.verification_status === "verified";
  const rows: Array<{ label: string; value: ReactNode; title?: string }> = [
    { label: "Chip", value: board.chip_variant, title: board.chip_variant },
    { label: "Memory", value: specs.memory, title: specs.memory },
    { label: "Wireless", value: specs.wireless, title: specs.wireless },
    { label: "Pins", value: describeBoardPins(board) },
    { label: "Firmware", value: <FirmwareBadge board={board} /> },
  ];

  return (
    <Card className="group h-full overflow-hidden border-none bg-transparent p-0 shadow-none ring-0 transition-[transform,box-shadow] duration-200 hover:-translate-y-0.5 hover:shadow-md">
      <MagicCard
        mode="orb"
        spotlightTone="orange"
        className="h-full rounded-xl p-0"
        contentClassName="h-full"
      >
        <CardContent className="flex h-full flex-col p-0">
          <button
            type="button"
            onClick={onOpenDetails}
            aria-label={`Preview ${board.model} vector pin diagram`}
            className="relative flex h-40 w-full shrink-0 cursor-pointer items-center justify-center overflow-hidden rounded-t-xl border-b border-border/60 bg-[#0b0e12] px-4 pb-3 pt-8 outline-none transition-colors hover:bg-[#10141a] focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/70"
          >
            <BoardVectorSvg
              board={board}
              orientation="horizontal"
              compact={compactDrawing}
              className="h-full max-h-full w-full transition-transform duration-300 group-hover:scale-[1.03]"
            />
            <span className="pointer-events-none absolute inset-x-2 top-2 flex items-center justify-between gap-2">
              <span className="rounded-md bg-white/10 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-white/90 backdrop-blur-sm">
                {source === "custom" ? "Custom" : source === "partner" ? "Partner" : "Official"}
              </span>
              {verified && (
                <span
                  className="inline-flex items-center gap-0.5 rounded-md bg-emerald-400/15 px-1.5 py-0.5 text-[10px] font-semibold text-emerald-300"
                  title="Pinout verified against the maker's documentation"
                >
                  <RiShieldCheckLine className="size-3" aria-hidden="true" />
                  Verified
                </span>
              )}
            </span>
          </button>

          <div className="flex flex-1 flex-col gap-3 p-3.5">
            <div className="min-w-0 space-y-0.5">
              <h3
                className="truncate text-sm font-bold tracking-tight text-foreground"
                title={board.model}
              >
                {board.model}
              </h3>
              <p className="truncate text-[11px] text-muted-foreground">
                {[board.manufacturer, displayBoardRevision(board.revision)]
                  .filter(Boolean)
                  .join(" · ")}
              </p>
            </div>

            <dl className="grid grid-cols-[4.25rem_minmax(0,1fr)] items-center gap-x-3 gap-y-1.5 text-xs">
              {rows.map((row) => (
                <div key={row.label} className="contents">
                  <dt className="text-muted-foreground">{row.label}</dt>
                  <dd className="flex h-5 min-w-0 items-center font-medium text-foreground">
                    <span className="truncate" title={row.title}>
                      {row.value}
                    </span>
                  </dd>
                </div>
              ))}
            </dl>

            <div className="mt-auto flex items-center gap-2 border-t border-border/60 pt-3">
              <Button
                variant="outline"
                size="sm"
                className="h-8 flex-1 border-primary/55 text-xs font-semibold text-primary hover:bg-primary/10 hover:text-primary"
                onClick={onOpenDetails}
              >
                Details
              </Button>
              {action}
            </div>
          </div>
        </CardContent>
      </MagicCard>
    </Card>
  );
}
