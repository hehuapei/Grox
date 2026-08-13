import { describe, expect, it } from "vitest";
import { mergeHydratedPromptQueues, parsePromptQueues } from "./promptQueuePersistence";

const row = (id: string) => ({
  id,
  text: id,
  attachments: [],
  model: "grok-build",
  effort: "high" as const,
  mode: "agent" as const,
  permissionMode: "auto" as const,
  createdAt: 1,
});

describe("promptQueuePersistence", () => {
  it("顶层文件损坏时明确失败，不伪装成空队列", () => {
    expect(() => parsePromptQueues("not-json")).toThrow("不是有效 JSON");
    expect(() => parsePromptQueues("[]")).toThrow("必须是 JSON 对象");
  });

  it("逐条过滤坏数据，不让单条损坏拖垮全部队列", () => {
    const parsed = parsePromptQueues(JSON.stringify({
      a: [row("ok"), { ...row("bad"), effort: "unknown" }],
      b: "not-an-array",
    }));
    expect(parsed).toEqual({ a: [row("ok")] });
  });

  it("启动读盘到达较晚时保留当前进程新入队项", () => {
    const merged = mergeHydratedPromptQueues(
      { a: [row("disk"), row("same")] },
      { a: [{ ...row("same"), text: "newer" }, row("live")] },
    );
    expect(merged.a.map((item) => [item.id, item.text])).toEqual([
      ["disk", "disk"],
      ["same", "newer"],
      ["live", "live"],
    ]);
  });
});
