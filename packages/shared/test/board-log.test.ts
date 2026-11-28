import { describe, expect, it } from "vitest";
import {
  BOARD_LOG_CATEGORIES,
  BOARD_LOG_DEFAULT_PAGE_SIZE,
  BOARD_LOG_FILTERS,
  BOARD_LOG_MAX_PAGE_SIZE,
  BOARD_LOG_METHODS,
  BOARD_LOG_SEVERITIES,
  boardLogCategoryLabel,
  boardLogFilterById,
  boardLogStatusLabel,
  isBoardLogCategory,
  isBoardLogSeverity,
} from "../src/board-log";

describe("per-board live Log vocabulary", () => {
  it("keeps the console filters to the seven documented chips", () => {
    expect(BOARD_LOG_FILTERS.map((filter) => filter.id)).toEqual([
      "all",
      "communication",
      "device_activity",
      "connection",
      "command",
      "warning",
      "error",
    ]);
    expect(BOARD_LOG_FILTERS.map((filter) => filter.label)).toEqual([
      "All",
      "Communication",
      "Device Activity",
      "Connection",
      "Commands",
      "Warning",
      "Error",
    ]);
  });

  it("resolves a filter and falls back to All", () => {
    expect(boardLogFilterById("command").category).toBe("command");
    expect(boardLogFilterById("warning").severity).toBe("warning");
    expect(boardLogFilterById("error").severity).toBe("error");
    expect(boardLogFilterById("nonsense").id).toBe("all");
  });

  it("keeps the delivery states distinct from the execution states", () => {
    // A publish is never a receipt: the two labels must not collapse.
    expect(boardLogStatusLabel("sent")).toBe("Sent");
    expect(boardLogStatusLabel("received")).toBe("Received");
    expect(boardLogStatusLabel("acknowledged")).toBe("Acknowledged");
    expect(boardLogStatusLabel("executed")).toBe("Executed");
    expect(boardLogStatusLabel("failed")).toBe("Failed");
    expect(boardLogStatusLabel("timeout")).toBe("Timeout");
    expect(boardLogStatusLabel("offline")).toBe("Offline");
    expect(boardLogStatusLabel("duplicate")).toBe("Duplicate");
    expect(boardLogStatusLabel("rejected")).toBe("Rejected");
    expect(boardLogStatusLabel(null)).toBe("—");
  });

  it("validates the category and severity vocabularies", () => {
    expect(isBoardLogCategory("communication")).toBe(true);
    expect(isBoardLogCategory("device_activity")).toBe(true);
    expect(isBoardLogCategory("nope")).toBe(false);
    expect(isBoardLogSeverity("warning")).toBe(true);
    expect(isBoardLogSeverity("critical")).toBe(false);
    expect(BOARD_LOG_CATEGORIES).toContain("binding");
    expect(BOARD_LOG_SEVERITIES).toContain("error");
    expect(BOARD_LOG_METHODS).toContain("espnow");
    expect(BOARD_LOG_METHODS).toContain("mqtt");
  });

  it("labels the categories for the console", () => {
    expect(boardLogCategoryLabel("device_activity")).toBe("Device Activity");
    expect(boardLogCategoryLabel("command")).toBe("Command");
    expect(boardLogCategoryLabel("connection")).toBe("Connection");
  });

  it("bounds the page size", () => {
    expect(BOARD_LOG_DEFAULT_PAGE_SIZE).toBeLessThan(BOARD_LOG_MAX_PAGE_SIZE);
    expect(BOARD_LOG_MAX_PAGE_SIZE).toBeGreaterThan(0);
  });
});
