import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  setWorkspace: vi.fn(),
  renameSession: vi.fn(),
  listSessions: vi.fn(),
  invoke: vi.fn(),
}));

vi.mock("../bridge", () => ({
  bridge: {
    setWorkspace: mocks.setWorkspace,
    renameSession: mocks.renameSession,
    listSessions: mocks.listSessions,
  },
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));

import { useDesktop } from "./store";

const initialState = useDesktop.getState();
const project = {
  id: "c:/workspace/project",
  path: "C:/workspace/project",
  name: "Project",
  pinned: false,
  archived: false,
  createdAt: 1,
  lastOpenedAt: 2,
};
const session = {
  id: "session-a",
  title: "Session A",
  cwd: project.path,
  createdAt: 1,
  updatedAt: 2,
  model: "grok-build",
};

beforeEach(() => {
  localStorage.clear();
  mocks.setWorkspace.mockReset();
  mocks.renameSession.mockReset();
  mocks.listSessions.mockReset();
  mocks.invoke.mockReset();
  useDesktop.setState({
    projects: [project],
    sessionIndex: [session],
    startupError: null,
  });
});

afterEach(() => {
  useDesktop.setState(initialState, true);
});

describe("project and session actions", () => {
  it("项目切换失败会呈现错误并保持拒绝语义", async () => {
    mocks.setWorkspace.mockRejectedValue(new Error("工作区不可读"));

    await expect(useDesktop.getState().openProject(project.id)).rejects.toThrow("工作区不可读");

    expect(useDesktop.getState().startupError).toBe("工作区不可读");
  });

  it("Finder 打开失败会呈现错误而不是产生未处理拒绝", async () => {
    mocks.invoke.mockRejectedValue(new Error("Finder 不可用"));

    await expect(useDesktop.getState().openProjectInExplorer(project.id)).resolves.toBeUndefined();

    expect(useDesktop.getState().startupError).toBe("Finder 不可用");
  });

  it("会话重命名失败时保留本地标题并明确上游未同步", async () => {
    mocks.renameSession.mockRejectedValue(new Error("CLI 不支持 rename"));

    useDesktop.getState().renameSession(session.id, "新的标题");
    await Promise.resolve();

    expect(useDesktop.getState().sessionIndex[0].title).toBe("新的标题");
    expect(useDesktop.getState().startupError).toContain("CLI 重命名失败：CLI 不支持 rename");
  });

  it("固定、归档、取消归档和未读状态均写入唯一 flags 存储", () => {
    useDesktop.getState().pinSession(session.id);
    useDesktop.getState().markSessionUnread(session.id);
    useDesktop.getState().archiveSession(session.id);
    expect(useDesktop.getState().sessionIndex[0]).toMatchObject({
      pinned: true,
      completionUnread: true,
      archived: true,
    });

    useDesktop.getState().archiveSession(session.id);
    expect(useDesktop.getState().sessionIndex[0].archived).toBe(false);
    expect(JSON.parse(localStorage.getItem("grox.sessionFlags") ?? "{}")[session.id]).toEqual({
      pinned: true,
      completionUnread: true,
      archived: false,
    });
  });

  it("项目归档先完整枚举磁盘会话，并可再次恢复全部会话", async () => {
    mocks.listSessions.mockResolvedValue([{ ...session, id: "session-b", title: "Session B" }]);

    await useDesktop.getState().archiveProject(project.id);

    expect(mocks.listSessions).toHaveBeenCalledWith(project.path);
    expect(useDesktop.getState().sessionIndex.map((entry) => entry.id).sort()).toEqual(["session-a", "session-b"]);
    expect(useDesktop.getState().sessionIndex.every((entry) => entry.archived)).toBe(true);

    await useDesktop.getState().archiveProject(project.id);
    expect(useDesktop.getState().sessionIndex.every((entry) => !entry.archived)).toBe(true);
  });

  it("永久工作树创建成功后立即在 Finder 中显示，失败则呈现错误", async () => {
    mocks.invoke.mockImplementation(async (command: string) => {
      if (command === "create_permanent_worktree") return "/managed/new";
      if (command === "open_in_explorer") return undefined;
      throw new Error(`unexpected command: ${command}`);
    });

    await useDesktop.getState().createProjectWorktree(project.id);

    expect(mocks.invoke).toHaveBeenNthCalledWith(1, "create_permanent_worktree", { cwd: project.path });
    expect(mocks.invoke).toHaveBeenNthCalledWith(2, "open_in_explorer", { cwd: "/managed/new", path: null });

    mocks.invoke.mockReset();
    mocks.invoke.mockRejectedValue(new Error("源目录不是 Git 仓库"));
    await useDesktop.getState().createProjectWorktree(project.id);
    expect(useDesktop.getState().startupError).toBe("源目录不是 Git 仓库");
  });
});
