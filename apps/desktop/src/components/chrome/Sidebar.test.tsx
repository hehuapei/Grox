import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
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

  it("编辑项目会在菜单关闭后保留可聚焦的名称输入框", async () => {
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
      sessionIndex: [],
    });
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);

    await act(async () => root.render(<Sidebar />));
    await act(async () => container.querySelector<HTMLButtonElement>('button[aria-label="项目操作"]')?.click());
    const edit = [...container.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent?.includes("编辑项目"));
    await act(async () => {
      edit?.click();
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    });

    const input = container.querySelector<HTMLInputElement>('input[value="已有项目"]');
    expect(input).not.toBeNull();
    expect(input?.closest("button")).toBeNull();
    await act(async () => root.unmount());
  });

  it("永久删除会话使用应用内确认框并触发删除动作", async () => {
    const removeSessionFromSidebar = vi.fn(async () => {});
    useDesktop.setState({
      activeProjectId: "c:/workspace/existing",
      projects: [{
        id: "c:/workspace/existing",
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
      removeSessionFromSidebar,
    });
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);

    await act(async () => root.render(<Sidebar />));
    const actions = container.querySelector<HTMLButtonElement>('button[aria-label="会话操作"]');
    expect(actions).not.toBeNull();
    await act(async () => actions?.click());
    const deleteMenuItem = [...container.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent?.includes("永久删除会话"));
    expect(deleteMenuItem).not.toBeUndefined();
    await act(async () => deleteMenuItem?.click());
    expect(document.body.textContent).toContain("永久删除会话？");
    const confirm = [...document.body.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent === "永久删除");
    await act(async () => confirm?.click());

    expect(removeSessionFromSidebar).toHaveBeenCalledWith("session-existing");
    await act(async () => root.unmount());
  });

  it("本地支持包在读取完整对话 trace 前明确说明隐私边界", async () => {
    useDesktop.setState({
      activeProjectId: "c:/workspace/existing",
      projects: [{
        id: "c:/workspace/existing",
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
    await act(async () => container.querySelector<HTMLButtonElement>('button[aria-label="会话操作"]')?.click());
    const exportItem = [...container.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent?.includes("导出本地支持包"));
    await act(async () => exportItem?.click());

    expect(document.body.textContent).toContain("导出本地会话支持包？");
    expect(document.body.textContent).toContain("完整对话和工具记录");
    expect(document.body.textContent).toContain("Grox 不会上传");
    await act(async () => root.unmount());
  });
});
