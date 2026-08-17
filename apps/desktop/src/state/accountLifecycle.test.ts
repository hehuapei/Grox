import { afterEach, describe, expect, it, vi } from "vitest";

const bridge = vi.hoisted(() => ({
  kind: "acp" as const,
  logout: vi.fn(async () => {}),
  getAuthState: vi.fn(async () => ({ required: true, inProgress: false })),
  getProviderStatus: vi.fn(async () => ({ kind: "oauth" as const, hasApiKey: false, secretBackend: "missing" as const })),
  getAccountInfo: vi.fn(async () => ({ authenticated: false })),
}));

vi.mock("../bridge", () => ({ bridge }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

import { useDesktop } from "./store";

const initialState = useDesktop.getState();

afterEach(() => {
  bridge.logout.mockClear();
  bridge.getAuthState.mockClear();
  bridge.getProviderStatus.mockClear();
  bridge.getAccountInfo.mockClear();
  useDesktop.setState(initialState, true);
});

describe("account lifecycle", () => {
  it("退出登录后立即清理旧账户并刷新认证状态", async () => {
    useDesktop.setState({
      auth: { required: false, inProgress: false },
      account: { authenticated: true, email: "old@example.com" },
      billing: { subscriptionTier: "SuperGrok" },
    });

    await useDesktop.getState().logout();

    expect(bridge.logout).toHaveBeenCalledOnce();
    expect(useDesktop.getState().auth).toEqual({ required: true, inProgress: false });
    expect(useDesktop.getState().account).toEqual({ authenticated: false });
    expect(useDesktop.getState().billing).toBeNull();
  });
});
