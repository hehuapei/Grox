import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  deleteSession: vi.fn(),
  cancel: vi.fn(),
  listSessions: vi.fn(),
  invoke: vi.fn(),
}));

vi.mock("../bridge", () => ({
  bridge: {
    deleteSession: mocks.deleteSession,
    cancel: mocks.cancel,
    listSessions: mocks.listSessions,
  },
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));

import { useDesktop } from "./store";

const initialState = useDesktop.getState();

beforeEach(() => {
  localStorage.clear();
  mocks.deleteSession.mockReset();
  mocks.cancel.mockReset();
  mocks.listSessions.mockReset();
  mocks.invoke.mockReset();
});

afterEach(() => {
  useDesktop.setState(initialState, true);
});

describe("durable deletion", () => {
  it("项目先从侧栏消失，不等待 CLI 会话枚举或删除响应", async () => {
    mocks.listSessions.mockImplementation(() => new Promise(() => {}));
    mocks.deleteSession.mockImplementation(() => new Promise(() => {}));
    useDesktop.setState({
      activeProjectId: "c:/workspace/project",
      projects: [{
        id: "c:/workspace/project",
        path: "C:/workspace/project",
        name: "Project",
        pinned: false,
        archived: false,
        createdAt: 1,
        lastOpenedAt: 2,
      }],
      sessionIndex: [{
        id: "session-a",
        title: "Session A",
        cwd: "C:/workspace/project",
        createdAt: 1,
        updatedAt: 2,
        model: "grok-build",
      }],
    });

    const removal = useDesktop.getState().removeProject("c:/workspace/project");
    expect(useDesktop.getState().projects).toEqual([]);
    expect(useDesktop.getState().sessionIndex).toEqual([]);
    await removal;

    expect(mocks.listSessions).not.toHaveBeenCalled();
    expect(mocks.deleteSession).toHaveBeenCalledWith("session-a");
    expect(mocks.cancel).toHaveBeenCalledWith("session-a");
    expect(JSON.parse(localStorage.getItem("grox.deletedSessions") ?? "[]")).toContain("session-a");
    expect(JSON.parse(localStorage.getItem("grox.dismissedProjects") ?? "[]")).toContain("c:/workspace/project");
  });

  it("会话删除完成不受 CLI 删除响应阻塞", async () => {
    mocks.deleteSession.mockImplementation(() => new Promise(() => {}));
    useDesktop.setState({
      activeId: "session-a",
      restoringSessionId: "session-a",
      view: "session",
      sessionIndex: [{
        id: "session-a",
        title: "Session A",
        cwd: "C:/workspace/project",
        createdAt: 1,
        updatedAt: 2,
        model: "grok-build",
      }],
    });

    await useDesktop.getState().deleteSession("session-a");

    expect(useDesktop.getState().sessionIndex).toEqual([]);
    expect(useDesktop.getState().activeId).toBeNull();
    expect(useDesktop.getState().restoringSessionId).toBeNull();
    expect(useDesktop.getState().view).toBe("home");
    expect(mocks.deleteSession).toHaveBeenCalledWith("session-a");
    expect(mocks.cancel).toHaveBeenCalledWith("session-a");
  });
});
