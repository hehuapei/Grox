import { describe, expect, it } from "vitest";
import {
  diffPromptQueues,
  loadPromptQueuesFromBrowser,
  mergeHydratedPromptQueues,
  parsePromptQueues,
} from "./promptQueuePersistence";

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

  it("只 patch 变化的会话并把空队列表达为删除", () => {
    expect(diffPromptQueues(
      { a: [row("same")], b: [row("remove")], c: [row("old")] },
      { a: [row("same")], b: [], c: [row("new")], d: [row("add")] },
    )).toEqual({
      upserts: { c: [row("new")], d: [row("add")] },
      deletes: ["b"],
    });
  });

  it("Tauri 首屏不从旧 localStorage 复活已删除队列", () => {
    localStorage.setItem("grox.promptQueues.v1", JSON.stringify({ stale: [row("old")] }));
    const tauriWindow = window as unknown as Record<string, unknown>;
    tauriWindow.__TAURI_INTERNALS__ = {};
    try {
      expect(loadPromptQueuesFromBrowser()).toEqual({});
    } finally {
      delete tauriWindow.__TAURI_INTERNALS__;
      localStorage.removeItem("grox.promptQueues.v1");
    }
  });
});
