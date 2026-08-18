import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useDesktop } from "../../state/store";
import { WorkbenchPanel } from "./WorkbenchPanel";

const initialState = useDesktop.getState();

afterEach(() => {
  useDesktop.setState(initialState, true);
  document.body.replaceChildren();
});

describe("WorkbenchPanel", () => {
  it("并行任务创建失败时保留草稿并显示错误", async () => {
    useDesktop.setState({
      activeId: null,
      sessions: {},
      newSession: vi.fn(async () => { throw new Error("运行时离线"); }),
    });
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    await act(async () => root.render(<WorkbenchPanel />));

    const sideTab = [...container.querySelectorAll<HTMLButtonElement>('button[role="tab"]')]
      .find((button) => button.textContent?.includes("并行任务"));
    await act(async () => sideTab?.click());
    const textarea = container.querySelector<HTMLTextAreaElement>('textarea[aria-label="并行侧任务描述"]');
    await act(async () => {
      if (!textarea) return;
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set?.call(textarea, "检查构建");
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
      await Promise.resolve();
    });
    const launch = [...container.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent?.includes("开始并行任务"));
    await act(async () => launch?.click());

    expect(textarea?.value).toBe("检查构建");
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("运行时离线");
    await act(async () => root.unmount());
  });
});
