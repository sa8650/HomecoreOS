import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * The 2D map is a plain surface: no brick/line grid behind the rooms.
 */
const css = readFileSync(resolve(__dirname, "../../styles/globals.css"), "utf8");

describe("2D floor map surface", () => {
  it("paints rgb(252,253,254) with no repeating grid", () => {
    const rule = css.slice(css.indexOf(".hc-blueprint-bg {"));
    const block = rule.slice(0, rule.indexOf("}") + 1);
    expect(block).toContain("#fcfdfe");
    expect(block).toContain("background-image: none");
    expect(block).not.toContain("linear-gradient(to right");
    expect(block).not.toContain("linear-gradient(to bottom");
  });

  it("no longer defines the blueprint grid colour token", () => {
    expect(css).not.toContain("--hc-floor-grid");
  });
});
