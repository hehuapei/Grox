import { describe, expect, it } from "vitest";
import {
  getSettingsCatalog,
  searchSettings,
  settingsHash,
  settingsSectionFromHash,
} from "./settingsCatalog";

describe("settingsCatalog", () => {
  it("搜索中英文关键词并定位到设置分区", () => {
    const catalog = getSettingsCatalog(true);
    expect(searchSettings(catalog, "CLI").map((entry) => entry.section)).toContain("general");
    expect(searchSettings(catalog, "登录").map((entry) => entry.section)).toEqual(["account"]);
    expect(searchSettings(catalog, "不存在")).toEqual([]);
  });

  it("设置分区使用稳定深链", () => {
    expect(settingsHash("plugins")).toBe("#/settings/plugins");
    expect(settingsSectionFromHash("#/settings/plugins")).toBe("plugins");
    expect(settingsSectionFromHash("#/settings/unknown")).toBeNull();
  });
});
