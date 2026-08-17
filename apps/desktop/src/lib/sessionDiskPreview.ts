import type { Session, SessionBlock, SessionMeta, ToolStatus } from "../bridge/types";
import { mapToolKind } from "./toolKind";
import { displayDiskUserPrompt } from "./replayUserPrompt";

export type SessionDiskPreviewEntry =
  | { type: "message"; role: "user" | "assistant"; text: string }
  | {
      type: "tool";
      id: string;
      name: string;
      title: string;
      input?: string;
      output?: string;
      status: "done" | "cancelled";
    };

export interface SessionDiskPreview {
  entries: SessionDiskPreviewEntry[];
  truncated: boolean;
}

const EMPTY_USAGE = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  costUSD: 0,
  contextUsed: 0,
  contextMax: 0,
  turns: 0,
};

export function sessionFromDiskPreview(meta: SessionMeta, preview: SessionDiskPreview): Session {
  const entries = preview.entries.flatMap((entry, index): SessionBlock[] => {
    const ts = meta.createdAt + index;
    if (entry.type === "message") {
      const text = entry.role === "user" ? displayDiskUserPrompt(entry.text) : entry.text;
      if (!text) return [];
      return [{
        type: entry.role,
        id: `preview-${meta.id}-${index}`,
        text,
        ts,
      }];
    }
    const kind = mapToolKind(entry.name, entry.title);
    const status: ToolStatus = entry.status === "done" ? "done" : "cancelled";
    return [{
      type: "tool",
      id: `preview-tool-${entry.id || index}`,
      call: {
        id: entry.id || `disk-tool-${meta.id}-${index}`,
        kind,
        ...(kind === "other" && entry.name ? { rawKind: entry.name } : {}),
        title: entry.title || entry.name || "工具调用",
        status,
        startedAt: ts,
        ...(status === "done" || status === "cancelled" ? { endedAt: ts } : {}),
        ...(entry.input ? { input: entry.input } : {}),
        ...(entry.output ? { output: entry.output } : {}),
      },
      ts,
    }];
  });
  const blocks: SessionBlock[] = preview.truncated
    ? [{
        type: "system",
        id: `preview-${meta.id}-truncated`,
        text: "磁盘预览已截断，较早的公开事件暂未显示；连接 Agent 后会继续加载规范会话历史。",
        ts: meta.createdAt - 1,
        kind: "info",
      }, ...entries]
    : entries;
  return {
    ...meta,
    blocks,
    usage: { ...EMPTY_USAGE },
    status: "idle",
    preview: true,
  };
}
