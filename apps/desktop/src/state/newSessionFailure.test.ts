import { afterEach, describe, expect, it, vi } from "vitest";

const bridge = vi.hoisted(() => ({
  invalidateWorkspaceSelection: vi.fn(),
  closeSession: vi.fn(async () => {}),
  newSession: vi.fn(async () => { throw new Error("运行时离线"); }),
}));

vi.mock("../bridge", () => ({ bridge }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

import { useDesktop } from "./store";

const initialState = useDesktop.getState();

afterEach(() => {
  bridge.invalidateWorkspaceSelection.mockClear();
  bridge.closeSession.mockClear();
  bridge.newSession.mockClear();
  useDesktop.setState(initialState, true);
});

describe("newSession failure", () => {
  it("恢复 store 草稿并向调用方返回失败", async () => {
    useDesktop.setState({
      workspace: "/repo",
      activeId: null,
      sessions: {},
      sessionComposers: {},
      startupError: null,
    });

    await expect(useDesktop.getState().newSession({ text: "保留这段任务" }))
      .rejects.toThrow("运行时离线");

    const state = useDesktop.getState();
    expect(state.activeId).toMatch(/^draft-/);
    expect(state.activeId && state.sessionComposers[state.activeId]?.text).toBe("保留这段任务");
    expect(state.startupError).toContain("运行时离线");
  });
});
