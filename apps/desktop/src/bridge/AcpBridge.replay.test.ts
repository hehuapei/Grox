import { describe, expect, it } from "vitest";
import { displayReplayUserPrompt } from "../lib/replayUserPrompt";

describe("ACP 会话回放用户消息", () => {
  it("隐藏 Grok Build 注入的上下文信封", () => {
    expect(displayReplayUserPrompt(`<user_info>\nOS Version: macos\n</user_info>\n\n<git_status>\n## main\n</git_status>`)).toBe("");
    expect(displayReplayUserPrompt(`<rules>\n内部规则\n</rules>`)).toBe("");
  });

  it("隐藏重复的 user_query 信封但保留真实请求", () => {
    expect(displayReplayUserPrompt(`<user_query>\n读取 README\n</user_query>`)).toBe("");
    expect(displayReplayUserPrompt("读取 README")).toBe("读取 README");
  });

  it("继续把深度研究传输命令还原为用户可见指令", () => {
    expect(displayReplayUserPrompt(`/workflow grox-deep-research {"query":"数据库"}`)).toBe("/deep-research 数据库");
  });
});
