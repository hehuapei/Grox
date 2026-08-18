import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { useDesktop } from "../../state/store";
import { CommandPalette } from "./CommandPalette";

const initialState = useDesktop.getState();

afterEach(() => {
  useDesktop.setState(initialState, true);
  document.body.replaceChildren();
});

describe("CommandPalette", () => {
  it("输入查询后可以找到最近六条之外的会话", async () => {
    useDesktop.setState({
      paletteOpen: true,
      sessionIndex: Array.from({ length: 58 }, (_, index) => ({
        id: `session-${index}`,
        title: index === 57 ? "远期唯一任务" : `最近任务 ${index}`,
        cwd: "/workspace",
        createdAt: index + 1,
        updatedAt: 100 - index,
        model: "grok-build",
      })),
    });
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(<CommandPalette />);
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    });
    const input = container.querySelector<HTMLInputElement>('input[aria-label="输入命令或搜索任务"]');
    expect(container.textContent).not.toContain("远期唯一任务");
    await act(async () => {
      if (!input) return;
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(input, "远期唯一");
      input.dispatchEvent(new Event("input", { bubbles: true }));
      await Promise.resolve();
    });

    expect(container.textContent).toContain("远期唯一任务");
    await act(async () => root.unmount());
  });
});
