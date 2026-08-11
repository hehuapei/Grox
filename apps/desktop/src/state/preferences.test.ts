import { describe, expect, it } from "vitest";
import { fontScaleToRank, parseFontScale, usePreferences } from "./preferences";

describe("parseFontScale", () => {
  it("accepts discrete labels", () => {
    expect(parseFontScale("sm")).toBe("sm");
    expect(parseFontScale("md")).toBe("md");
    expect(parseFontScale("lg")).toBe("lg");
    expect(parseFontScale("xl")).toBe("xl");
  });

  it("maps legacy numeric offsets without fractions in output", () => {
    expect(parseFontScale("-1")).toBe("sm");
    expect(parseFontScale("0")).toBe("md");
    expect(parseFontScale("0.25")).toBe("md");
    expect(parseFontScale("1.5")).toBe("lg");
    expect(parseFontScale("3.5")).toBe("xl");
    expect(parseFontScale("6")).toBe("xl");
  });

  it("maps legacy named sizes", () => {
    expect(parseFontScale("compact")).toBe("sm");
    expect(parseFontScale("comfortable")).toBe("md");
    expect(parseFontScale("large")).toBe("lg");
  });
});

describe("fontScaleToRank", () => {
  it("is stable and ordered", () => {
    expect(fontScaleToRank("sm")).toBe(0);
    expect(fontScaleToRank("md")).toBe(1);
    expect(fontScaleToRank("lg")).toBe(2);
    expect(fontScaleToRank("xl")).toBe(3);
  });
});

describe("sidebar visibility", () => {
  it("persists every toggle", () => {
    const initial = usePreferences.getState().sidebarVisible;
    usePreferences.getState().toggleSidebar();
    expect(usePreferences.getState().sidebarVisible).toBe(!initial);
    expect(localStorage.getItem("grox.sidebarVisible")).toBe(initial ? "0" : "1");

    usePreferences.getState().toggleSidebar();
    expect(usePreferences.getState().sidebarVisible).toBe(initial);
  });
});
