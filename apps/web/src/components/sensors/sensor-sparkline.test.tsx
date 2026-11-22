import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { SensorSparkline } from "./SensorSparkline";

const points = (values: number[]) =>
  values.map((value, index) => ({
    value,
    unit: "°C",
    recordedAt: new Date(2026, 10, 16, 10, index, 0).toISOString(),
  }));

describe("SensorSparkline", () => {
  it("shows a compact empty state when history is unavailable", () => {
    render(<SensorSparkline sensorType="temperature_bme280" points={undefined} />);
    expect(screen.getByTestId("sensor-sparkline-empty")).toBeInTheDocument();
    expect(screen.queryByTestId("sensor-sparkline")).not.toBeInTheDocument();
  });

  it("shows the empty state with fewer than two points", () => {
    render(
      <SensorSparkline sensorType="temperature_bme280" points={points([21.5])} />
    );
    expect(screen.getByTestId("sensor-sparkline-empty")).toBeInTheDocument();
  });

  it("renders the trend line from real history points", () => {
    const { container } = render(
      <SensorSparkline
        sensorType="temperature_bme280"
        points={points([20.1, 20.9, 21.4, 21.1, 22.0])}
      />
    );
    const svg = screen.getByTestId("sensor-sparkline");
    expect(svg).toBeInTheDocument();
    // Smooth curve + soft area fill + endpoint dot
    expect(container.querySelectorAll("path").length).toBe(2);
    expect(container.querySelectorAll("circle").length).toBe(1);
  });

  it("handles a flat series without dividing by zero", () => {
    render(
      <SensorSparkline sensorType="humidity_dht22" points={points([45, 45, 45])} />
    );
    expect(screen.getByTestId("sensor-sparkline")).toBeInTheDocument();
  });
});
