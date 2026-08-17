import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));

import { useDesktop } from "../../state/store";
import { EnvironmentSummary } from "./EnvironmentSummary";

const initialState = useDesktop.getState();

const runtimeStatus = {
  topology: "shared_process",
  processCapacity: 1,
  running: true,
  ready: true,
  phase: "ready",
  pendingRequests: 0,
  pendingInteractions: 0,
  pendingClientCallbacks: 0,
  boundClientSessions: 0,
  activeTerminals: 0,
  automaticReconnectActive: false,
  lastConnectConfigured: true,
  worktreeSessionBindings: 0,
};

function installTauri() {
  (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
}

function mockSummary(worktrees: Array<Record<string, unknown>>) {
  mocks.invoke.mockImplementation(async (command: string) => {
    if (command === "git_summary") return {
      isRepository: true,
      branch: "feature",
      branches: ["main", "feature"],
      added: 0,
      removed: 0,
      changedFiles: 0,
      ahead: 0,
      behind: 0,
    };
    if (command === "git_worktrees") return worktrees;
    if (command === "session_journal_status") return { count: 0, totalBytes: 0, migrationPending: 0, unreadableCount: 0 };
    if (command === "agent_runtime_status") return runtimeStatus;
    if (command === "prepare_git_worktree_remove") return "confirm-token";
    if (command === "git_worktree_remove") return "Worktree 已移除";
    throw new Error(`unexpected command: ${command}`);
  });
}

beforeEach(() => {
  installTauri();
  mocks.invoke.mockReset();
  useDesktop.setState({ workspace: "/managed/current" });
});

afterEach(() => {
  delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
  useDesktop.setState(initialState, true);
  document.body.replaceChildren();
});

describe("EnvironmentSummary worktree controls", () => {
  it("主工作树和当前工作树不可删除，其他工作树走双重确认协议", async () => {
    mockSummary([
      { path: "/repo/primary", branch: "main", bare: false, detached: false, locked: false, prunable: false },
      { path: "/managed/current", branch: "current", bare: false, detached: false, locked: false, prunable: false },
      { path: "/managed/removable", branch: "removable", bare: false, detached: false, locked: false, prunable: false },
    ]);
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(<EnvironmentSummary />);
      await Promise.resolve();
    });
    await act(async () => {
      container.querySelector<HTMLButtonElement>('button[title="环境摘要"]')?.click();
      await Promise.resolve();
      await Promise.resolve();
    });

    const removeButtons = [...container.querySelectorAll<HTMLButtonElement>("button")]
      .filter((button) => button.textContent === "删除");
    expect(removeButtons).toHaveLength(3);
    expect(removeButtons[0].disabled).toBe(true);
    expect(removeButtons[0].title).toBe("不能删除仓库主工作树");
    expect(removeButtons[1].disabled).toBe(true);
    expect(removeButtons[1].title).toBe("不能删除当前工作树");
    expect(removeButtons[2].disabled).toBe(false);

    await act(async () => removeButtons[2].click());
    const confirm = [...document.body.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent === "删除工作树");
    await act(async () => {
      confirm?.click();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(mocks.invoke).toHaveBeenCalledWith("prepare_git_worktree_remove", {
      cwd: "/managed/current",
      path: "/managed/removable",
    });
    expect(mocks.invoke).toHaveBeenCalledWith("git_worktree_remove", {
      request: { cwd: "/managed/current", path: "/managed/removable", confirmToken: "confirm-token" },
    });
    await act(async () => root.unmount());
  });

  it("worktree 枚举失败不会伪装成空列表", async () => {
    mockSummary([]);
    mocks.invoke.mockImplementation(async (command: string) => {
      if (command === "git_worktrees") throw new Error("worktree 索引损坏");
      if (command === "git_summary") return { isRepository: true, branch: "main", branches: ["main"], added: 0, removed: 0, changedFiles: 0, ahead: 0, behind: 0 };
      if (command === "session_journal_status") return { count: 0, totalBytes: 0, migrationPending: 0, unreadableCount: 0 };
      if (command === "agent_runtime_status") return runtimeStatus;
      throw new Error(`unexpected command: ${command}`);
    });
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);

    await act(async () => root.render(<EnvironmentSummary />));
    await act(async () => {
      container.querySelector<HTMLButtonElement>('button[title="环境摘要"]')?.click();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(container.textContent).toContain("worktree 索引损坏");
    expect(container.textContent).not.toContain("暂无附加 worktree");
    await act(async () => root.unmount());
  });
});
