import { describe, expect, it } from "vitest";
import { formatGroxError, groxFailure, toGroxError } from "./errorModel";

describe("errorModel", () => {
  it("保留已经分类的运行时失败", () => {
    const original = {
      domain: "environment" as const,
      code: "ACP_PROCESS_EXITED",
      message: "Agent 已退出",
      recoverable: true,
      fatal: true,
      holdQueue: true,
      action: "重新发送前检查运行时",
    };
    expect(toGroxError(groxFailure(original), { domain: "protocol", code: "PROMPT" })).toEqual(original);
  });

  it("把 ACP RPC 错误呈现为协议错误", () => {
    const cause = Object.assign(new Error("invalid params"), { name: "AcpRpcError" });
    const error = toGroxError(cause, { domain: "operation", code: "SESSION_LOAD", fatal: true });
    expect(error.domain).toBe("protocol");
    expect(formatGroxError(error)).toContain("ACP 协议错误");
  });

  it("环境退出会覆盖普通协议兜底", () => {
    const error = toGroxError(new Error("Grok Agent 已退出（代码 1）"), {
      domain: "protocol",
      code: "PROMPT_FAILED",
      fatal: true,
    });
    expect(error.domain).toBe("environment");
    expect(error.holdQueue).toBe(true);
  });

  it("保留原生 Host 提供的稳定错误代码和恢复动作", () => {
    const error = toGroxError({
      domain: "environment",
      code: "ACP_PROCESS_EXITED",
      message: "Grok Agent 已退出",
      recoverable: true,
      fatal: true,
      holdQueue: true,
      action: "重连后检查最后一轮结果",
    }, { domain: "protocol", code: "SESSION_PROMPT_FAILED" });
    expect(error).toEqual({
      domain: "environment",
      code: "ACP_PROCESS_EXITED",
      message: "Grok Agent 已退出",
      recoverable: true,
      fatal: true,
      holdQueue: true,
      action: "重连后检查最后一轮结果",
    });
  });
});
