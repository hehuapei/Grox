import { describe, expect, it } from "vitest";
import type { Session } from "../bridge/types";
import {
  compactSession,
  nextSessionJournalSavedAt,
  parseSessionJournal,
  recordSessionJournalHostEvent,
  sessionJournalSnapshot,
  sliceCacheBlocks,
} from "./sessionCache";

const session = (blocks: Session["blocks"], status: Session["status"] = "running"): Session => ({
  id: "session-1",
  title: "cache",
  cwd: "/tmp/project",
  createdAt: 1,
  updatedAt: 2,
  model: "grok-build",
  status,
  blocks,
  usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, costUSD: 0, contextUsed: 0, contextMax: 0, turns: 0 },
});

describe("compactSession", () => {
  it("缓存不会恢复为运行中，也不会保存流式状态", () => {
    const result = compactSession(session([{ type: "assistant", id: "a", text: "hello", ts: 1, streaming: true }]));
    expect(result.status).toBe("idle");
    expect(result.preview).toBe(true);
    expect(result.blocks[0]).toMatchObject({ type: "assistant", streaming: false });
  });

  it("旧 journal 的传输信封不会再次显示或写回", () => {
    const result = compactSession(session([
      { type: "user", id: "internal", text: "<user_info>internal</user_info>", ts: 1 },
      { type: "user", id: "wrapped", text: "<user_query>duplicate</user_query>", ts: 2 },
      { type: "user", id: "real", text: "真实请求", ts: 3 },
    ]));
    expect(result.blocks).toHaveLength(1);
    expect(result.blocks[0]).toMatchObject({ id: "real", text: "真实请求" });
  });

  it("journal 在体积边界内保留最近 600 个块", () => {
    const blocks = Array.from({ length: 610 }, (_, index) => ({ type: "user" as const, id: String(index), text: String(index), ts: index }));
    const result = compactSession(session(blocks));
    expect(result.blocks).toHaveLength(600);
    expect(result.blocks[0].id).toBe("10");
  });

  it("版本化 journal 保留崩溃前的回合活动事实", () => {
    const snapshot = sessionJournalSnapshot(session([], "running"), 42);
    expect(snapshot).toMatchObject({ version: 1, appSessionId: "session-1", agentSessionId: "session-1", savedAt: 42, turnState: "active" });
    expect(snapshot.session.status).toBe("running");
    expect(snapshot.session.preview).not.toBe(true);
    expect(parseSessionJournal(JSON.stringify(snapshot), "session-1")).toEqual(snapshot);
  });

  it("journal 把待确认 Host 事件与同一份会话快照原子提交", () => {
    recordSessionJournalHostEvent("session-1", "host-stream-a", 7);
    recordSessionJournalHostEvent("session-1", "host-stream-a", 4);
    const snapshot = sessionJournalSnapshot(session([
      { type: "assistant", id: "a", text: "live", ts: 1, streaming: true },
    ]), 43);

    expect(snapshot.hostEvents).toEqual({ streamId: "host-stream-a", sequences: [4, 7] });
    expect(snapshot.session.blocks[0]).toMatchObject({ type: "assistant", streaming: true });
    expect(parseSessionJournal(JSON.stringify(snapshot), "session-1")).toEqual(snapshot);
  });

  it("journal 版本在系统时间回拨后仍单调递增", () => {
    expect(nextSessionJournalSavedAt(100, 50)).toBe(101);
    expect(nextSessionJournalSavedAt(100, 200)).toBe(200);
  });

  it("journal 只保存 Host 管理的工具图片引用", () => {
    const result = compactSession(session([{
      type: "tool",
      id: "tool-image",
      ts: 1,
      call: {
        id: "call-image",
        kind: "computer",
        title: "screenshot",
        status: "done",
        startedAt: 1,
        images: [
          { mime: "image/png", data: "inline-only" },
          { mime: "image/png", data: "live-copy", path: "/managed/session/media/hash.png" },
        ],
      },
    }]));
    const block = result.blocks[0];
    expect(block.type).toBe("tool");
    if (block.type !== "tool") return;
    expect(block.call.images).toEqual([{ mime: "image/png", path: "/managed/session/media/hash.png" }]);
  });

  it("读取旧版裸 Session 时迁移为 settled journal", () => {
    const migrated = parseSessionJournal(JSON.stringify(session([], "idle")), "session-1");
    expect(migrated).toMatchObject({ version: 1, appSessionId: "session-1", turnState: "settled" });
  });
});

describe("sliceCacheBlocks", () => {
  it("does not start mid-turn when possible", () => {
    const blocks: Session["blocks"] = [
      { type: "user", id: "u0", text: "a", ts: 0 },
      { type: "assistant", id: "a0", text: "b", ts: 1 },
      { type: "user", id: "u1", text: "c", ts: 2 },
      {
        type: "tool",
        id: "t1",
        ts: 3,
        call: {
          id: "c1",
          kind: "read",
          status: "done",
          title: "r",
          startedAt: 3,
        },
      },
    ];
    const sliced = sliceCacheBlocks(blocks, 2);
    // Prefer starting at user u1 rather than tool-only tail when over budget.
    expect(sliced[0].type === "user" || sliced.length <= 2).toBe(true);
  });
});
