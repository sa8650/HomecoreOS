import type { BoardHeaderPin, GpioPinDefinition } from "@homecoreos/shared";
import { cn } from "@/lib/utils";
import type { BoardProfileItem } from "@/features/types";

export interface BoardPadRow {
  /** Where the pad sits: a main header, or the extra solder pads. */
  group: string;
  pad: string;
  gpio: number | null;
  kind: BoardHeaderPin["kind"];
  /** Short capability and restriction tags for the pad's GPIO. */
  tags: string[];
  restricted: boolean;
  note: string | null;
}

function tagsFor(def: GpioPinDefinition | undefined): { tags: string[]; restricted: boolean } {
  if (!def) return { tags: [], restricted: false };
  const caps = def.capabilities;
  const res = def.restrictions;
  const tags: string[] = [];
  if (res.reserved || res.flash_psram_conflict) return { tags: ["Reserved"], restricted: true };
  if (res.input_only) tags.push("Input only");
  if (caps.adc) tags.push("ADC");
  if (caps.pwm) tags.push("PWM");
  if (caps.i2c) tags.push("I2C");
  if (caps.touch) tags.push("Touch");
  if (res.strapping_pin) tags.push("Boot strap");
  if (res.usb_jtag_conflict) tags.push("USB");
  return { tags, restricted: Boolean(res.strapping_pin || res.usb_jtag_conflict) };
}

/**
 * Every pad of a board in the order the maker prints it: both main headers
 * and, when the board has them, the extra solder pads (for example D11 to D19
 * on the back of the XIAO ESP32-S3 Plus).
 */
export function listBoardPads(
  board: Pick<BoardProfileItem, "board_layout" | "gpio_definitions">,
  options?: { extraOnly?: boolean; gpioOnly?: boolean }
): BoardPadRow[] {
  const layout = board.board_layout;
  if (!layout) return [];
  const defByPin = new Map(board.gpio_definitions.map((g) => [g.pin, g]));
  const groups: Array<{ name: string; pins: BoardHeaderPin[] }> = [];
  if (!options?.extraOnly) {
    groups.push({ name: layout.leftHeader?.name || "Left header", pins: layout.leftHeader?.pins ?? [] });
    groups.push({ name: layout.rightHeader?.name || "Right header", pins: layout.rightHeader?.pins ?? [] });
  }
  if (layout.extraPads) {
    groups.push({ name: layout.extraPads.name || "Extra pads", pins: layout.extraPads.pins ?? [] });
  }

  const rows: BoardPadRow[] = [];
  for (const group of groups) {
    for (const pin of group.pins) {
      if (options?.gpioOnly && pin.gpioPin === null) continue;
      const { tags, restricted } = tagsFor(pin.gpioPin === null ? undefined : defByPin.get(pin.gpioPin));
      rows.push({
        group: group.name,
        pad: pin.pinName,
        gpio: pin.gpioPin,
        kind: pin.kind,
        tags,
        restricted,
        note: pin.note ?? null,
      });
    }
  }
  return rows;
}

/** A compact, readable table of board pads and the GPIO behind each one. */
export function BoardPadTable({
  rows,
  caption,
  className,
}: {
  rows: BoardPadRow[];
  caption: string;
  className?: string;
}) {
  if (rows.length === 0) return null;
  return (
    <div className={cn("overflow-hidden rounded-lg border", className)}>
      <table className="w-full table-fixed border-collapse text-[11px]">
        <caption className="sr-only">{caption}</caption>
        <thead>
          <tr className="bg-muted/50 text-left text-[10px] uppercase tracking-wide text-muted-foreground">
            <th scope="col" className="w-[30%] px-2.5 py-1.5 font-semibold">
              Pad
            </th>
            <th scope="col" className="w-[22%] px-2.5 py-1.5 font-semibold">
              GPIO
            </th>
            <th scope="col" className="px-2.5 py-1.5 font-semibold">
              Functions
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row, index) => (
            <tr key={`${row.group}-${row.pad}-${index}`} className="border-t">
              <th scope="row" className="break-words px-2.5 py-1 text-left font-medium text-foreground">
                {row.pad}
              </th>
              <td className="px-2.5 py-1 font-mono tabular-nums text-foreground">
                {row.gpio === null ? (
                  <span className="font-sans text-muted-foreground">
                    {row.kind === "power" ? "Power" : row.kind === "ground" ? "Ground" : "—"}
                  </span>
                ) : (
                  `GPIO${row.gpio}`
                )}
              </td>
              <td
                className={cn(
                  "break-words px-2.5 py-1",
                  row.restricted ? "text-warning-foreground" : "text-muted-foreground"
                )}
              >
                {row.tags.length > 0 ? row.tags.join(" · ") : row.gpio === null ? "" : "Digital I/O"}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
