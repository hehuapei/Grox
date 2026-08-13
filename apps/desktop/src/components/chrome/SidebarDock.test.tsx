import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SidebarDock } from "./SidebarDock";

vi.mock("./Sidebar", () => ({
  Sidebar: () => <aside data-testid="sidebar" />,
}));

afterEach(() => {
  document.body.replaceChildren();
});

describe("SidebarDock", () => {
  it("隐藏时不保留会抢占指针的边缘热区", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);

    await act(async () => root.render(<SidebarDock visible={false} width={260} onResize={() => {}} />));
    expect(container.querySelector('[data-testid="sidebar"]')).toBeNull();
    expect(container.querySelector('[role="separator"]')).toBeNull();

    await act(async () => root.unmount());
  });

  it("显示时渲染可调整宽度的固定侧栏", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);

    await act(async () => root.render(<SidebarDock visible width={260} onResize={() => {}} />));
    expect(container.querySelector('[data-testid="sidebar"]')).not.toBeNull();
    expect(container.querySelector('[role="separator"]')).not.toBeNull();

    await act(async () => root.unmount());
  });
});
