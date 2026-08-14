import { describe, expect, it } from "vitest";
import { worktreeRemovalBlocker } from "./worktreeOwnership";

describe("worktreeRemovalBlocker", () => {
  it("阻止删除当前工作区", () => {
    expect(worktreeRemovalBlocker("C:\\Repo\\WT", "c:/repo/wt/", [], [])).toEqual({
      kind: "current_workspace",
    });
  });

  it("统计引用目标目录的会话和自动化", () => {
    expect(worktreeRemovalBlocker("/repo/wt", "/repo/main", ["/repo/wt", "/other"], ["/repo/wt"])).toEqual({
      kind: "references",
      sessions: 1,
      automations: 1,
    });
  });

  it("无引用时允许继续原生校验", () => {
    expect(worktreeRemovalBlocker("/repo/wt", "/repo/main", ["/other"], [])).toBeNull();
  });
});
