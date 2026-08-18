import type { PromptAttachment } from "../bridge/types";

export interface ComposerSubmission {
  text: string;
  attachmentIds: string[];
}

/** 只提交按下发送键时的快照，不覆盖异步准备附件期间产生的新草稿。 */
export function commitComposerSubmission<T extends { text: string; attachments: PromptAttachment[] }>(
  current: T,
  submission?: ComposerSubmission,
): T {
  if (!submission) return current;
  const sentAttachmentIds = new Set(submission.attachmentIds);
  return {
    ...current,
    text: current.text === submission.text ? "" : current.text,
    attachments: current.attachments.filter((attachment) => !sentAttachmentIds.has(attachment.id)),
  };
}
