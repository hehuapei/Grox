import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { usePreferences } from "../../state/preferences";
import { TitleBar } from "./TitleBar";

const initialPreferences = usePreferences.getState();

afterEach(() => {
  usePreferences.setState(initialPreferences, true);
  document.body.replaceChildren();
});

describe("TitleBar", () => {
  it("仅在侧栏隐藏时显示左上角恢复按钮", async () => {
    usePreferences.setState({ sidebarVisible: true });
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);

    await act(async () => root.render(<TitleBar />));
    expect(container.querySelector('button[aria-label="显示侧栏"]')).toBeNull();

    await act(async () => usePreferences.setState({ sidebarVisible: false }));
    expect(container.querySelector('button[aria-label="显示侧栏"]')).not.toBeNull();

    await act(async () => root.unmount());
  });
});
