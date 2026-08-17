import { describe, expect, it } from "vitest";
import { nextViewNavigation, shouldCommitViewNavigation } from "./viewNavigation";

describe("view navigation generation", () => {
  it("只允许最后一次导航意图提交异步结果", () => {
    const initial = { generation: 0, sessionId: null };
    const first = nextViewNavigation(initial, "session-a", "/repo/a");
    const second = nextViewNavigation(first, "session-b", "/repo/b");
    expect(shouldCommitViewNavigation(first, second)).toBe(false);
    expect(shouldCommitViewNavigation(second, second)).toBe(true);
  });
});
