import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { TechnologyEcosystem } from "./TechnologyEcosystem";

describe("TechnologyEcosystem", () => {
  it("renders one compact row of brand marks and one row of tech labels", () => {
    render(<TechnologyEcosystem />);

    const brands = screen.getByTestId("technology-brands");
    const marks = within(brands).getAllByRole("listitem");
    expect(marks).toHaveLength(6);
    for (const name of ["Espressif", "EMQX", "Cloudflare", "Supabase", "GitHub", "Brevo"]) {
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
    const brands = within(screen.getByTestId("technology-brands")).getAllByRole("listitem");
    const fills = brands.map((item) => item.querySelector("svg")?.getAttribute("fill"));
    // The Brevo mark is a raster disc, so it has no inline SVG fill.
    expect(fills).toEqual([
      "#E7352C",
      "currentColor",
      "#F38020",
      "#3FCF8E",
      "currentColor",
      undefined,
    ]);
    for (const item of brands) {
      expect(item.className).not.toMatch(/bg-/);
      expect(item.querySelector("svg")?.className.baseVal ?? "").not.toMatch(/bg-/);
    }
  });

  it("renders the Brevo mark as an icon-only brand asset", () => {
    render(<TechnologyEcosystem />);

    const brands = screen.getByTestId("technology-brands");
    const brevo = within(brands).getByText("Brevo").closest("li");
    expect(brevo).not.toBeNull();
    expect(brevo?.querySelector("img")).toHaveAttribute("src", "/brand/brevo-icon.png");
    // The credit is the icon alone — never the "delivered by" wording.
    expect(within(brands).queryByText(/delivered/i)).not.toBeInTheDocument();
  });
});
