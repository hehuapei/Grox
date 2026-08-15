import { describe, expect, it } from "vitest";
import type { Session } from "../bridge/types";
import {
  reconcileSessionJournal,
  resumeInterruptedSessionIfHostActive,
} from "./sessionJournalReconcile";
import { sessionJournalSnapshot } from "./sessionCache";

const makeSession = (blocks: Session["blocks"], status: Session["status"] = "idle"): Session => ({
  id: "s1",
  title: "session",
  cwd: "/tmp/project",
  createdAt: 1,
  updatedAt: 2,
  model: "grok-build",
  status,
  blocks,
  usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, costUSD: 0, contextUsed: 0, contextMax: 0, turns: 0 },
});

describe("reconcileSessionJournal", () => {
  it("Agent 磁盘尾帧补回已落盘但较旧的应用 journal", () => {
    const journal = sessionJournalSnapshot(makeSession([
      { type: "user", id: "u1", text: "修好了吗", ts: 1 },
    ]), 10);
    const agent = makeSession([
      { type: "user", id: "du1", text: "修好了吗", ts: 1 },
      { type: "assistant", id: "da1", text: "已经修好", ts: 2 },
    ]);
    const result = reconcileSessionJournal(journal, agent);
    expect(result.outcome).toBe("reconciled");
    expect(result.changed).toBe(true);
    expect(result.session?.blocks.some((block) => block.type === "assistant" && block.text === "已经修好")).toBe(true);
  });

  it("活动回合崩溃后保持 interrupted，不把磁盘尾帧猜成完整成功", () => {
    const journal = sessionJournalSnapshot(makeSession([
      { type: "user", id: "u1", text: "继续", ts: 1 },
    ], "running"), 20);
    const agent = makeSession([
      { type: "user", id: "du1", text: "继续", ts: 1 },
      { type: "assistant", id: "da1", text: "部分输出", ts: 2 },
    ]);
    const result = reconcileSessionJournal(journal, agent);
    expect(result.outcome).toBe("interrupted");
    expect(result.session?.status).toBe("failed");
    expect(result.session?.blocks.at(-1)).toMatchObject({ type: "system", kind: "error" });
  });

  it("WebView 重载但 Host 回合仍存活时撤销错误的中断门禁", () => {
    const journal = sessionJournalSnapshot(makeSession([
      { type: "assistant", id: "a1", text: "仍在生成", ts: 1, streaming: true },
    ], "running"), 21);
    const interrupted = reconcileSessionJournal(journal, null).session;
    expect(interrupted).not.toBeNull();

    const resumed = resumeInterruptedSessionIfHostActive(interrupted!);
    expect(resumed.resumed).toBe(true);
    expect(resumed.session.status).toBe("running");
    expect(resumed.session.preview).toBe(false);
    expect(resumed.session.blocks.some((block) => block.id.startsWith("journal-interrupted-"))).toBe(false);
  });

  it("无 journal 时仍可使用 Agent 磁盘历史", () => {
    const agent = makeSession([{ type: "assistant", id: "a1", text: "历史", ts: 1 }]);
    expect(reconcileSessionJournal(null, agent)).toMatchObject({ session: agent, outcome: "agent_only" });
  });
});
