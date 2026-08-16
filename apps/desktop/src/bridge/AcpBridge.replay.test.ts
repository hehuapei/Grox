import { describe, expect, it } from "vitest";
import { displayDiskUserPrompt, displayReplayUserPrompt } from "../lib/replayUserPrompt";

describe("ACP 会话回放用户消息", () => {
  it("隐藏 Grok Build 注入的上下文信封", () => {
    expect(displayReplayUserPrompt(`<user_info>\nOS Version: macos\n</user_info>\n\n<git_status>\n## main\n</git_status>`)).toBe("");
    expect(displayReplayUserPrompt(`<rules>\n内部规则\n</rules>`)).toBe("");
  });

  it("隐藏重复的 user_query 信封但保留真实请求", () => {
    expect(displayReplayUserPrompt(`<user_query>\n读取 README\n</user_query>`)).toBe("");
    expect(displayReplayUserPrompt(`The user interrupted the previous turn:\n<user_query>\n继续检查\n</user_query>\nMake sure to complete any unfinished tasks from previous turns.`)).toBe("");
    expect(displayReplayUserPrompt("读取 README")).toBe("读取 README");
  });

  it("磁盘恢复会还原用户正文且不泄漏中断信封", () => {
    expect(displayDiskUserPrompt(`<user_query>\n读取 README\n</user_query>`)).toBe("读取 README");
    expect(displayDiskUserPrompt(`The user interrupted the previous turn:\n<user_query>\n继续检查\n</user_query>\nMake sure to complete any unfinished tasks from previous turns.`)).toBe("继续检查");
  });

  it("继续把深度研究传输命令还原为用户可见指令", () => {
    expect(displayReplayUserPrompt(`/workflow grox-deep-research {"query":"数据库"}`)).toBe("/deep-research 数据库");
  });
});
