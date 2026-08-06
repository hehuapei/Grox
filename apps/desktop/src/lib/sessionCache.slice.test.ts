import { describe, expect, it } from "vitest";
import { sliceCacheBlocks } from "./sessionCache";
import type { SessionBlock } from "../bridge/types";

function tool(i: number): SessionBlock {
  return {
    type: "tool",
    id: `t${i}`,
    ts: i,
    call: {
      id: `c${i}`,
      kind: "execute",
      title: `tool ${i}`,
      status: "done",
      startedAt: i,
    },
  };
}

describe("sliceCacheBlocks", () => {
  it("does not start mid-tool when truncating", () => {
    const blocks: SessionBlock[] = [];
    for (let i = 0; i < 50; i++) {
      if (i % 10 === 0) {
        blocks.push({ type: "user", id: `u${i}`, text: `msg ${i}`, ts: i });
      } else {
        blocks.push(tool(i));
      }
    }
    const sliced = sliceCacheBlocks(blocks, 15);
    expect(sliced[0].type).toBe("user");
    expect(sliced.length).toBeGreaterThanOrEqual(11);
    expect(sliced.length).toBeLessThanOrEqual(30);
  });

  it("skips interjected user as turn boundary", () => {
    const blocks: SessionBlock[] = [
      { type: "user", id: "u0", text: "main", ts: 0 },
      tool(1),
      tool(2),
      { type: "user", id: "inj", text: "插话", ts: 3, interjected: true },
      tool(4),
      tool(5),
      tool(6),
      tool(7),
      tool(8),
      tool(9),
      tool(10),
      tool(11),
      tool(12),
    ];
    const sliced = sliceCacheBlocks(blocks, 8);
    expect(
      sliced[0].type === "user" ? (sliced[0] as { interjected?: boolean }).interjected : false,
    ).not.toBe(true);
    if (sliced[0].type === "user") {
      expect((sliced[0] as { text: string }).text).toBe("main");
    }
  });
});
