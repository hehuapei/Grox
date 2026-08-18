import { describe, expect, it } from "vitest";
import { fmtDuration } from "./format";

describe("fmtDuration", () => {
  it("keeps short durations precise", () => {
    expect(fmtDuration(42_500)).toBe("42.5s");
    expect(fmtDuration(125_000)).toBe("2m 5s");
  });

  it("does not render long session spans as thousands of minutes", () => {
    expect(fmtDuration(7_380_000)).toBe("2h 3m");
    expect(fmtDuration(176_400_000)).toBe("2d 1h");
  });
});
