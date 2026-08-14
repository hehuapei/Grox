import { describe, expect, it, beforeEach } from "vitest";
import type { Session } from "../bridge/types";
import {
  clearDraftBuffer,
  compactSession,
  loadDraftBuffer,
  parseSessionJournal,
  saveDraftBuffer,
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

  it("journal 在体积边界内保留最近 600 个块", () => {
    const blocks = Array.from({ length: 610 }, (_, index) => ({ type: "user" as const, id: String(index), text: String(index), ts: index }));
    const result = compactSession(session(blocks));
    expect(result.blocks).toHaveLength(600);
    expect(result.blocks[0].id).toBe("10");
  });

  it("版本化 journal 保留崩溃前的回合活动事实", () => {
    const snapshot = sessionJournalSnapshot(session([], "running"), 42);
    expect(snapshot).toMatchObject({ version: 1, appSessionId: "session-1", agentSessionId: "session-1", savedAt: 42, turnState: "active" });
    expect(snapshot.session.status).toBe("idle");
    expect(parseSessionJournal(JSON.stringify(snapshot), "session-1")).toEqual(snapshot);
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

describe("draft buffer", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("persists and reloads unsent draft text per cwd", () => {
    saveDraftBuffer("C:\\Work\\Repo", "未发送的提示词");
    const loaded = loadDraftBuffer("C:/Work/Repo");
    expect(loaded?.text).toBe("未发送的提示词");
  });

  it("persists attachments for first-send crash recovery", () => {
    saveDraftBuffer("C:\\Work\\Repo", "with file", [
      {
        id: "a1",
        kind: "text",
        name: "notes.txt",
        mime: "text/plain",
        size: 4,
        text: "body",
      },
    ]);
    const loaded = loadDraftBuffer("C:/Work/Repo");
    expect(loaded?.text).toBe("with file");
    expect(loaded?.attachments).toEqual([
      {
        id: "a1",
        kind: "text",
        name: "notes.txt",
        mime: "text/plain",
        size: 4,
        text: "body",
      },
    ]);
  });

  it("falls back to text-only when attachments blow the size budget", () => {
    const huge = "x".repeat(900_000);
    saveDraftBuffer("C:\\Work\\Repo", "keep me", [
      {
        id: "img",
        kind: "image",
        name: "big.png",
        mime: "image/png",
        size: huge.length,
        data: huge,
      },
      {
        id: "img2",
        kind: "image",
        name: "big2.png",
        mime: "image/png",
        size: huge.length,
        data: huge,
      },
    ]);
    const loaded = loadDraftBuffer("C:/Work/Repo");
    expect(loaded?.text).toBe("keep me");
    // Full dual payloads exceed budget; metadata-only or empty attachments OK.
    const bodies = (loaded?.attachments ?? []).filter((a) => a.data || a.text);
    expect(bodies.length).toBe(0);
  });

  it("clears empty drafts", () => {
    saveDraftBuffer("C:\\Work\\Repo", "x");
    saveDraftBuffer("C:\\Work\\Repo", "   ");
    expect(loadDraftBuffer("C:\\Work\\Repo")).toBeNull();
  });

  it("clearDraftBuffer removes entry", () => {
    saveDraftBuffer("C:\\A", "hello");
    clearDraftBuffer("C:\\A");
    expect(loadDraftBuffer("C:\\A")).toBeNull();
  });
});
