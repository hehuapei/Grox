import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { useDesktop } from "../../state/store";
import { Sidebar } from "./Sidebar";

const initialState = useDesktop.getState();

afterEach(() => {
  useDesktop.setState(initialState, true);
  document.body.replaceChildren();
});

describe("Sidebar", () => {
  it("已有项目和会话时可以稳定挂载", async () => {
    useDesktop.setState({
      activeProjectId: "project-existing",
      projects: [{
        id: "project-existing",
        path: "C:/workspace/existing",
        name: "已有项目",
        pinned: false,
        archived: false,
        createdAt: 1,
        lastOpenedAt: 2,
      }],
      sessionIndex: [{
        id: "session-existing",
        title: "已有会话",
        cwd: "C:/workspace/existing",
        createdAt: 1,
        updatedAt: 2,
        model: "grok-build",
      }],
    });
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);

    await act(async () => root.render(<Sidebar />));

    expect(container.textContent).toContain("已有项目");
    expect(container.textContent).toContain("已有会话");
    await act(async () => root.unmount());
  });
});
