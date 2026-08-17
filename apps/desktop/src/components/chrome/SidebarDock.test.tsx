import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { SidebarDock } from "./SidebarDock";

afterEach(() => {
  document.body.replaceChildren();
});

describe("SidebarDock", () => {
  it("隐藏时从窗口左缘临时展开，并在指针离开后收起", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);

    await act(async () => root.render(<SidebarDock visible={false} width={260} onResize={() => {}} />));
    const edgeZone = container.querySelector<HTMLElement>('[data-testid="sidebar-edge-zone"]');
    const peek = container.querySelector<HTMLElement>('[data-testid="sidebar-peek"]');

    expect(edgeZone?.style.width).toBe("14px");
    expect(peek?.dataset.state).toBe("closed");

    await act(async () => {
      edgeZone?.dispatchEvent(new MouseEvent("pointerover", { bubbles: true }));
    });
    expect(edgeZone?.style.width).toBe("14px");
    expect(peek?.dataset.state).toBe("open");

    await act(async () => {
      window.dispatchEvent(new MouseEvent("pointermove", { bubbles: true, clientX: 300 }));
      await new Promise((resolve) => window.setTimeout(resolve, 20));
      window.dispatchEvent(new MouseEvent("pointermove", { bubbles: true, clientX: 100 }));
      await new Promise((resolve) => window.setTimeout(resolve, 60));
    });
    expect(peek?.dataset.state).toBe("open");

    await act(async () => {
      window.dispatchEvent(new MouseEvent("pointermove", { bubbles: true, clientX: 300 }));
      await new Promise((resolve) => window.setTimeout(resolve, 80));
    });
    expect(edgeZone?.style.width).toBe("14px");
    expect(peek?.dataset.state).toBe("closed");

    await act(async () => root.unmount());
  });
});
