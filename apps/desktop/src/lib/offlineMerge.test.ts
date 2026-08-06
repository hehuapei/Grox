import { describe, expect, it } from "vitest";
import {
  blockContentKey,
  firstPrimaryUserBlock,
  insertLiveOnlyIntoOffline,
  isSyntheticToolCallId,
  mergeOfflineWithLive,
} from "./offlineMerge";
import type { Session } from "../bridge/types";

function sess(
  partial: Partial<Session> & Pick<Session, "id" | "blocks" | "status">,
): Session {
  return {
    cwd: "C:\\proj",
    title: "t",
    createdAt: 0,
    updatedAt: 0,
    model: "test",
    usage: {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      costUSD: 0,
      contextUsed: 0,
      contextMax: 0,
      turns: 0,
    },
    ...partial,
  };
}

describe("mergeOfflineWithLive (0.2.24 evidence-driven)", () => {
  it("keeps offline when live is empty", () => {
    const pending = sess({
      id: "a",
      status: "idle",
      blocks: [{ type: "user", id: "u1", text: "hi", ts: 1 }],
    });
    const out = mergeOfflineWithLive(pending, undefined);
    expect(out.blocks.map((b) => b.id)).toEqual(["u1"]);
  });

  it("inserts live-only 处理好了 BEFORE shared 你现在尝试 (not after Push)", () => {
    // Real disk: updates has 你现在尝试 + Push; chat_history also has 处理好了 first.
    // Live paint (preview) has correct order including 处理好了 as live-only vs updates.
    const pending = sess({
      id: "a",
      status: "idle",
      blocks: [
        { type: "user", id: "old", text: "ancient", ts: 1 },
        { type: "assistant", id: "old-a", text: "old reply", ts: 2, streaming: false },
        { type: "user", id: "u-try", text: "你现在尝试", ts: 3 },
        {
          type: "tool",
          id: "t1",
          ts: 4,
          call: {
            id: "call-164",
            kind: "execute",
            title: "run",
            status: "done",
            rawKind: "execute",
            startedAt: 4,
          },
        },
        { type: "assistant", id: "push", text: "# Push 成功\nok", ts: 5, streaming: false },
      ],
    });
    const cur = sess({
      id: "a",
      status: "idle",
      blocks: [
        { type: "user", id: "live-done", text: "处理好了，你现在尝试", ts: 2 },
        { type: "user", id: "live-try", text: "你现在尝试", ts: 3 },
        {
          type: "tool",
          id: "live-t",
          ts: 4,
          call: {
            id: "call-164",
            kind: "execute",
            title: "run",
            status: "done",
            rawKind: "execute",
            startedAt: 4,
          },
        },
        { type: "assistant", id: "live-push", text: "# Push 成功\nok", ts: 5, streaming: false },
      ],
    });
    const out = mergeOfflineWithLive(pending, cur);
    const texts = out.blocks
      .filter((b) => b.type === "user" || b.type === "assistant")
      .map((b) => ("text" in b ? b.text : ""));
    expect(texts).toEqual([
      "ancient",
      "old reply",
      "处理好了，你现在尝试",
      "你现在尝试",
      "# Push 成功\nok",
    ]);
  });

  it("repairs corrupt live order when offline spine is correct (post-enrich)", () => {
    // Corrupt session-cache / memory: 你现在尝试 → Push → 处理好了
    // Offline after chat_history enrich: 处理好了 → 你现在尝试 → Push
    const pending = sess({
      id: "a",
      status: "idle",
      blocks: [
        { type: "user", id: "off-done", text: "处理好了，你现在尝试", ts: 1 },
        { type: "user", id: "off-try", text: "你现在尝试", ts: 2 },
        { type: "assistant", id: "off-push", text: "# Push 成功\nok", ts: 3, streaming: false },
      ],
    });
    const cur = sess({
      id: "a",
      status: "idle",
      blocks: [
        { type: "user", id: "live-try", text: "你现在尝试", ts: 2 },
        { type: "assistant", id: "live-push", text: "# Push 成功\nok", ts: 3, streaming: false },
        { type: "user", id: "live-done", text: "处理好了，你现在尝试", ts: 4 },
      ],
    });
    const out = mergeOfflineWithLive(pending, cur);
    const texts = out.blocks.map((b) => ("text" in b ? b.text : ""));
    expect(texts).toEqual(["处理好了，你现在尝试", "你现在尝试", "# Push 成功\nok"]);
    // Live identities reused where keys match
    expect(out.blocks[1]?.id).toBe("live-try");
    expect(out.blocks[2]?.id).toBe("live-push");
  });

  it("prepends older offline history before live window", () => {
    const pending = sess({
      id: "a",
      status: "idle",
      blocks: [
        { type: "user", id: "old", text: "ancient github", ts: 1 },
        { type: "assistant", id: "old-a", text: "old", ts: 2, streaming: false },
        { type: "user", id: "u-try", text: "你现在尝试", ts: 3 },
        { type: "assistant", id: "push", text: "# Push 成功", ts: 4, streaming: false },
      ],
    });
    const cur = sess({
      id: "a",
      status: "idle",
      blocks: [
        { type: "user", id: "uuid-try", text: "你现在尝试", ts: 3 },
        { type: "assistant", id: "uuid-push", text: "# Push 成功", ts: 4, streaming: false },
      ],
    });
    const out = mergeOfflineWithLive(pending, cur);
    expect(out.blocks.map((b) => b.id)).toEqual([
      "old",
      "old-a",
      "uuid-try",
      "uuid-push",
    ]);
  });

  it("preserves busy status and live blocks", () => {
    const pending = sess({
      id: "a",
      status: "idle",
      blocks: [{ type: "user", id: "u1", text: "hi", ts: 1 }],
    });
    const cur = sess({
      id: "a",
      status: "running",
      blocks: [
        { type: "user", id: "u1", text: "hi", ts: 1 },
        { type: "assistant", id: "a1", text: "…", streaming: true, ts: 2 },
      ],
    });
    const out = mergeOfflineWithLive(pending, cur);
    expect(out.status).toBe("running");
    expect(out.blocks.map((b) => b.id)).toEqual(["u1", "a1"]);
  });

  it("preserves awaiting_permission and awaiting_input without offline rewrite", () => {
    const pending = sess({
      id: "a",
      status: "idle",
      blocks: [
        { type: "user", id: "off", text: "hi", ts: 1 },
        { type: "assistant", id: "off-a", text: "full offline body", ts: 2, streaming: false },
      ],
    });
    for (const status of ["awaiting_permission", "awaiting_input"] as const) {
      const cur = sess({
        id: "a",
        status,
        blocks: [
          { type: "user", id: "live", text: "hi", ts: 1 },
          { type: "assistant", id: "live-a", text: "short", streaming: false, ts: 2 },
        ],
      });
      const out = mergeOfflineWithLive(pending, cur);
      expect(out.status).toBe(status);
      expect(out.blocks.map((b) => b.id)).toEqual(["live", "live-a"]);
    }
  });

  it("stabilize prefers longer offline body when live is truncated", () => {
    // Content keys use first 240 chars — live must share that prefix to match.
    const long = "x".repeat(500);
    const pending = sess({
      id: "a",
      status: "idle",
      blocks: [
        { type: "user", id: "u", text: "q", ts: 1 },
        { type: "assistant", id: "off-a", text: long, ts: 2, streaming: false },
      ],
    });
    const cur = sess({
      id: "a",
      status: "idle",
      blocks: [
        { type: "user", id: "live-u", text: "q", ts: 1 },
        {
          type: "assistant",
          id: "live-a",
          text: long.slice(0, 240),
          ts: 2,
          streaming: false,
        },
      ],
    });
    const out = mergeOfflineWithLive(pending, cur);
    const asst = out.blocks.find((b) => b.type === "assistant");
    expect(asst && "text" in asst ? asst.text.length : 0).toBe(500);
    expect(asst?.id).toBe("live-a");
  });

  it("firstPrimaryUserBlock skips tools and interjects", () => {
    const blocks: Session["blocks"] = [
      {
        type: "tool",
        id: "t",
        ts: 1,
        call: {
          id: "c",
          kind: "execute",
          title: "x",
          status: "done",
          startedAt: 1,
        },
      },
      { type: "user", id: "i", text: "插话", ts: 2, interjected: true },
      { type: "user", id: "u", text: "主消息", ts: 3 },
    ];
    expect(firstPrimaryUserBlock(blocks)?.id).toBe("u");
  });

  it("blockContentKey distinguishes interjected users", () => {
    const a = blockContentKey({ type: "user", id: "1", text: "x", ts: 1 });
    const b = blockContentKey({ type: "user", id: "2", text: "x", ts: 1, interjected: true });
    expect(a).not.toBe(b);
  });

  it("insertLiveOnlyIntoOffline places user before next shared key", () => {
    const offline: Session["blocks"] = [
      { type: "user", id: "u-try", text: "你现在尝试", ts: 2 },
      { type: "assistant", id: "push", text: "# Push 成功", ts: 3, streaming: false },
    ];
    const live: Session["blocks"] = [
      { type: "user", id: "u-done", text: "处理好了，你现在尝试", ts: 1 },
      { type: "user", id: "u-try-live", text: "你现在尝试", ts: 2 },
      { type: "assistant", id: "push-live", text: "# Push 成功", ts: 3, streaming: false },
    ];
    const out = insertLiveOnlyIntoOffline(offline, live);
    expect(out.map((b) => ("text" in b ? b.text : ""))).toEqual([
      "处理好了，你现在尝试",
      "你现在尝试",
      "# Push 成功",
    ]);
  });

  it("skips synthetic disk-tool live-only so preview tools do not duplicate", () => {
    const offline: Session["blocks"] = [
      { type: "user", id: "u", text: "go", ts: 1 },
      {
        type: "tool",
        id: "off-t",
        ts: 2,
        call: {
          id: "call-real",
          kind: "execute",
          title: "run",
          status: "done",
          startedAt: 2,
        },
      },
    ];
    const live: Session["blocks"] = [
      { type: "user", id: "live-u", text: "go", ts: 1 },
      {
        type: "tool",
        id: "disk-t",
        ts: 2,
        call: {
          id: "disk-tool-5-0",
          kind: "other",
          title: "run_terminal_command",
          status: "done",
          startedAt: 2,
        },
      },
    ];
    const out = insertLiveOnlyIntoOffline(offline, live);
    expect(out.filter((b) => b.type === "tool")).toHaveLength(1);
    expect(out.find((b) => b.type === "tool")?.call.id).toBe("call-real");
    expect(isSyntheticToolCallId("disk-tool-1-0")).toBe(true);
    expect(isSyntheticToolCallId("call-real")).toBe(false);
  });
});
