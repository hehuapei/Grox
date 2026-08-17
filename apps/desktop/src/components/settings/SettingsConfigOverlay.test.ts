import { describe, expect, it } from "vitest";
import type { ConfigDocument } from "../../bridge/types";
import { configOverlayNotice } from "./SettingsModal";

function config(overlay: ConfigDocument["overlay"]): ConfigDocument {
  return {
    id: "config",
    label: "config.toml",
    path: "/home/user/.grok/config.toml",
    content: "",
    exists: true,
    language: "toml",
    overlay,
  };
}

describe("Grok Build launcher config overlay notice", () => {
  it("explains the likely configured path source without treating it as config.toml", () => {
    const notice = configOverlayNotice(config({ source: "path", path: "/launcher/overlay.toml" }), false);
    expect(notice).toContain("GROK_CONFIG_PATH");
    expect(notice).toContain("/launcher/overlay.toml");
    expect(notice).toContain("If Grok Build accepts it");
    expect(notice).toContain("higher priority than config.toml");
    expect(notice).toContain("does not modify the overlay");
  });

  it("never needs or renders inline GROK_CONFIG contents", () => {
    const notice = configOverlayNotice(config({ source: "inline" }), true);
    expect(notice).toContain("GROK_CONFIG");
    expect(notice).toContain("内容为安全起见不会显示");
    expect(notice).not.toContain("api_key");
  });

  it("does not warn when no launcher overlay is active", () => {
    expect(configOverlayNotice(config({ source: "none" }), false)).toBeUndefined();
  });
});
