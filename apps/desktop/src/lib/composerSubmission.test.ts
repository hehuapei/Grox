import { describe, expect, it } from "vitest";
import type { PromptAttachment } from "../bridge/types";
import { commitComposerSubmission } from "./composerSubmission";

const attachment = (id: string): PromptAttachment => ({
  id,
  kind: "text",
  name: `${id}.txt`,
  mime: "text/plain",
  size: 1,
  data: id,
});

const composer = (text: string, attachments: PromptAttachment[]) => ({
  text,
  attachments,
  model: "grok-build",
});

describe("commitComposerSubmission", () => {
  it("发送快照未变化时清空已发送内容", () => {
    expect(commitComposerSubmission(composer("hello", [attachment("old")]), {
      text: "hello",
      attachmentIds: ["old"],
    })).toMatchObject({ text: "", attachments: [] });
  });

  it("异步发送期间输入的新文字不会被清空", () => {
    expect(commitComposerSubmission(composer("hello again", [attachment("old")]), {
      text: "hello",
      attachmentIds: ["old"],
    }).text).toBe("hello again");
  });

  it("只移除已发送附件并保留稍后添加的附件", () => {
    const result = commitComposerSubmission(composer("hello", [attachment("old"), attachment("new")]), {
      text: "hello",
      attachmentIds: ["old"],
    });
    expect(result.attachments.map((item) => item.id)).toEqual(["new"]);
  });

  it("非编辑器触发的内部发送不改动草稿", () => {
    const current = composer("unsent", [attachment("draft")]);
    expect(commitComposerSubmission(current)).toBe(current);
  });
});
