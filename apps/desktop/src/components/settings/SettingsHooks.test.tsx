import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { useDesktop } from "../../state/store";
import { SettingsModal } from "./SettingsModal";

const initialState = useDesktop.getState();

afterEach(() => {
  useDesktop.setState(initialState, true);
  window.location.hash = "#/";
  localStorage.removeItem("grox.hooks");
  document.body.replaceChildren();
});

describe("Hooks settings", () => {
  it("未接入运行时时只展示禁用入口且不写入假偏好", async () => {
    window.location.hash = "#/settings/hooks";
    useDesktop.setState({ settingsOpen: true });
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);

    await act(async () => root.render(<SettingsModal />));

    expect(container.textContent).toContain("运行时尚未接入，本版本仅展示、不生效");
    const switches = [...container.querySelectorAll<HTMLButtonElement>('button[role="switch"]')];
    expect(switches).toHaveLength(4);
    expect(switches.every((button) => button.disabled)).toBe(true);
    expect(localStorage.getItem("grox.hooks")).toBeNull();

    await act(async () => root.unmount());
  });
});
