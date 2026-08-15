import { describe, expect, it } from "vitest";
import type { Session } from "../bridge/types";
import { preferRicherSession } from "./offlineSessionHydrate";
import { sessionFromDiskPreview } from "./sessionDiskPreview";

const base = (blocks: Session["blocks"], preview?: boolean): Session => ({
  id: "s1",
  title: "t",
  cwd: "/tmp",
  createdAt: 1,
  updatedAt: 2,
  model: "m",
  blocks,
  usage: {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    costUSD: 0,
    contextUsed: 0,
    contextMax: 0,
    turns: 0,
  },
  status: "idle",
  preview,
});

describe("preferRicherSession", () => {
  it("keeps a fuller live session over a thin preview", () => {
    const live = base([
      { type: "user", id: "u1", text: "a", ts: 1 },
      { type: "assistant", id: "a1", text: "b", ts: 2 },
    ]);
    const preview = base([{ type: "user", id: "u0", text: "x", ts: 1 }], true);
    expect(preferRicherSession(live, preview)).toBe(live);
  });

  it("accepts incoming when current is empty shell", () => {
    const shell = base([], true);
    const incoming = base([{ type: "user", id: "u1", text: "hi", ts: 1 }], true);
    expect(preferRicherSession(shell, incoming).blocks).toHaveLength(1);
  });
});

describe("sessionFromDiskPreview", () => {
  it("filters transport envelopes before painting offline history", () => {
    const session = sessionFromDiskPreview(base([]), {
      entries: [
        { type: "message", role: "user", text: "<user_info>internal</user_info>" },
        { type: "message", role: "user", text: "<user_query>duplicate</user_query>" },
        { type: "message", role: "user", text: "真实请求" },
      ],
      truncated: false,
    });

    expect(session.blocks).toHaveLength(1);
    expect(session.blocks[0]).toMatchObject({ type: "user", text: "真实请求" });
  });

  it("restores durable tool calls with their real identity and result", () => {
    const session = sessionFromDiskPreview(base([]), {
      entries: [
        { type: "message", role: "assistant", text: "先读取文件" },
        {
          type: "tool",
          id: "call-1",
          name: "read_file",
          title: "read_file",
          input: "{\"path\":\"README.md\"}",
          output: "file body",
          status: "done",
        },
      ],
      truncated: false,
    });

    expect(session.preview).toBe(true);
    expect(session.blocks[1]).toMatchObject({
      type: "tool",
      call: {
        id: "call-1",
        kind: "read",
        status: "done",
        input: "{\"path\":\"README.md\"}",
        output: "file body",
      },
    });
  });

  it("marks a call without durable result as cancelled instead of successful", () => {
    const session = sessionFromDiskPreview(base([]), {
      entries: [{
        type: "tool",
        id: "call-2",
        name: "run_terminal_command",
        title: "run_terminal_command",
        status: "cancelled",
      }],
      truncated: false,
    });

    expect(session.blocks[0]).toMatchObject({ type: "tool", call: { status: "cancelled" } });
  });

  it("makes a truncated offline transcript explicit", () => {
    const session = sessionFromDiskPreview(base([]), {
      entries: [{ type: "message", role: "assistant", text: "recent" }],
      truncated: true,
    });

    expect(session.blocks[0]).toMatchObject({ type: "system", kind: "info" });
    expect(session.blocks[1]).toMatchObject({ type: "assistant", text: "recent" });
  });
});
