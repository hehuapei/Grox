import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));

import { useDesktop } from "../../state/store";
import { Sidebar } from "./Sidebar";

const initialState = useDesktop.getState();

afterEach(() => {
  vi.useRealTimers();
  mocks.invoke.mockReset();
  useDesktop.setState(initialState, true);
  document.body.replaceChildren();
});

it("CLI 历史导入错误在按钮附近直接呈现", async () => {
  useDesktop.setState({ historyError: "会话目录无权访问" });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);

  await act(async () => root.render(<Sidebar />));

  expect(container.querySelector('[role="alert"]')?.textContent).toContain("CLI 历史导入失败：会话目录无权访问");
  await act(async () => root.unmount());
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

  it("项目加号在切换项目失败时不会继续创建会话", async () => {
    const openProject = vi.fn(async () => { throw new Error("工作区不可读"); });
    const newSession = vi.fn(async () => {});
    useDesktop.setState({
      activeProjectId: "another-project",
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
      openProject,
      newSession,
    });
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);

    await act(async () => root.render(<Sidebar />));
    const add = container.querySelector<HTMLButtonElement>('button[aria-label="在此项目中新建会话"]');
    await act(async () => {
      add?.click();
      await Promise.resolve();
    });

    expect(openProject).toHaveBeenCalledWith("project-existing");
    expect(newSession).not.toHaveBeenCalled();
    await act(async () => root.unmount());
  });

  it("搜索失败可见且清除搜索会恢复项目列表", async () => {
    vi.useFakeTimers();
    mocks.invoke.mockRejectedValue(new Error("历史索引损坏"));
    useDesktop.setState({
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
    const input = container.querySelector<HTMLInputElement>('input[aria-label="搜索会话标题与内容"]');
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(input, "不存在的正文");
      input!.dispatchEvent(new Event("input", { bubbles: true }));
      await Promise.resolve();
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(230);
      await Promise.resolve();
    });

    expect(container.textContent).toContain("历史内容搜索失败：历史索引损坏");
    expect(container.textContent).not.toContain("没有匹配的历史会话");
    const clear = container.querySelector<HTMLButtonElement>('button[aria-label="清除搜索"]');
    await act(async () => clear?.click());
    expect(input?.value).toBe("");
    expect(container.textContent).toContain("已有项目");
    await act(async () => root.unmount());
  });

  it("永久删除会话使用应用内确认框并触发删除动作", async () => {
    const removeSessionFromSidebar = vi.fn(async () => {});
    const openSession = vi.fn(async () => {});
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
      openSession,
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
    expect(openSession).not.toHaveBeenCalled();
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
