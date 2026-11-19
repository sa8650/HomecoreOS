import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { TechnologyEcosystem } from "./TechnologyEcosystem";

describe("TechnologyEcosystem", () => {
  it("renders one compact row of brand marks and one row of tech labels", () => {
    render(<TechnologyEcosystem />);

    const brands = screen.getByRole("list", { name: /Built with/i });
    const marks = within(brands).getAllByRole("listitem");
    expect(marks).toHaveLength(5);
    for (const name of ["Espressif", "EMQX", "Cloudflare", "Supabase", "GitHub"]) {
      expect(within(brands).getByText(name)).toBeInTheDocument();
    }

    const tech = screen.getByRole("list", { name: /Technologies/i });
    const labels = within(tech)
      .getAllByRole("listitem")
      .map((item) => item.textContent?.replace(/·/g, "").trim());
    expect(labels).toEqual(["ESP32", "ESP-NOW", "MQTT", "BLE", "Wi-Fi", "HTTPS", "OTA"]);
  });

  it("uses brand colours with no container backgrounds behind the marks", () => {
    render(<TechnologyEcosystem />);
    const brands = within(screen.getByRole("list", { name: /Built with/i })).getAllByRole("listitem");
    const fills = brands.map((item) => item.querySelector("svg")?.getAttribute("fill"));
    expect(fills).toEqual(["#E7352C", "currentColor", "#F38020", "#3FCF8E", "currentColor"]);
    for (const item of brands) {
      expect(item.className).not.toMatch(/bg-/);
      expect(item.querySelector("svg")?.className.baseVal ?? "").not.toMatch(/bg-/);
    }
  });
});
