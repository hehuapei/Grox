import { describe, expect, it } from "vitest";
import {
  failLatestAutomationSessionRun,
  parseAutomationRunHistory,
  recoverInterruptedAutomationRuns,
  redactAutomationDetail,
} from "./automationRunHistory";

const run = (outcome: "starting" | "started" = "starting") => ({
  id: "run-1",
  automationId: "auto-1",
  title: "Review",
  at: 1,
  outcome,
  source: "scheduled" as const,
  sessionId: "session-1",
});

describe("automationRunHistory", () => {
  it("保留 Host 已结算的 completed 终态", () => {
    expect(parseAutomationRunHistory([{ ...run("started"), outcome: "completed" }])[0]?.outcome).toBe("completed");
  });

  it("把崩溃窗口里的启动记录标成未知而不是伪成功或自动重放", () => {
    expect(recoverInterruptedAutomationRuns([run()], 2 * 60_000 + 2)[0]).toMatchObject({ outcome: "unknown" });
  });

  it("按会话只修正最近一个未完成运行", () => {
    const history = failLatestAutomationSessionRun([run("started"), { ...run(), id: "older" }], "session-1", "failed");
    expect(history.map((item) => item.outcome)).toEqual(["error", "starting"]);
  });

  it("持久化解析过滤坏行并脱敏常见令牌", () => {
    expect(parseAutomationRunHistory([run(), { bad: true }])).toHaveLength(1);
    expect(redactAutomationDetail("Bearer secret-token sk_abcdefghijklmnopqrstuvwxyz")).toBe("Bearer ******** ********");
  });
});
