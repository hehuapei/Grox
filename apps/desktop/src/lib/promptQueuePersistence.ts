import { invoke } from "@tauri-apps/api/core";
import { EFFORTS } from "../bridge/types";
import type { AgentMode, Effort, PermissionMode, PromptAttachment } from "../bridge/types";

export interface PersistedQueuedPrompt {
  id: string;
  text: string;
  attachments: PromptAttachment[];
  model: string;
  effort: Effort;
  mode: AgentMode;
  permissionMode: PermissionMode;
  createdAt: number;
  source?: "local" | "cli";
  state?: "queued" | "interjected" | "sending";
  heldByCli?: boolean;
}

export type PersistedPromptQueues = Record<string, PersistedQueuedPrompt[]>;

const STORAGE_KEY = "grox.promptQueues.v1";
let nativeWriteChain = Promise.resolve();

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function attachment(value: unknown): PromptAttachment | null {
  if (!isRecord(value)) return null;
  if (
    typeof value.id !== "string"
    || !["image", "text", "binary"].includes(String(value.kind))
    || typeof value.name !== "string"
    || typeof value.mime !== "string"
    || typeof value.size !== "number"
  ) return null;
  return {
    id: value.id,
    kind: value.kind as PromptAttachment["kind"],
    name: value.name,
    mime: value.mime,
    size: value.size,
    ...(typeof value.text === "string" ? { text: value.text } : {}),
    ...(typeof value.data === "string" ? { data: value.data } : {}),
  };
}

function queuedPrompt(value: unknown): PersistedQueuedPrompt | null {
  if (!isRecord(value) || !Array.isArray(value.attachments)) return null;
  if (
    typeof value.id !== "string"
    || typeof value.text !== "string"
    || typeof value.model !== "string"
    || !EFFORTS.includes(value.effort as Effort)
    || !["agent", "plan", "ask"].includes(String(value.mode))
    || !["default", "auto", "bypass"].includes(String(value.permissionMode))
    || typeof value.createdAt !== "number"
  ) return null;
  const attachments = value.attachments.map(attachment);
  if (attachments.some((item) => item === null)) return null;
  const source = value.source === "local" || value.source === "cli" ? value.source : undefined;
  const state = ["queued", "interjected", "sending"].includes(String(value.state))
    ? value.state as PersistedQueuedPrompt["state"]
    : undefined;
  return {
    id: value.id,
    text: value.text,
    attachments: attachments as PromptAttachment[],
    model: value.model,
    effort: value.effort as Effort,
    mode: value.mode as AgentMode,
    permissionMode: value.permissionMode as PermissionMode,
    createdAt: value.createdAt,
    ...(source ? { source } : {}),
    ...(state ? { state } : {}),
    ...(value.heldByCli === true ? { heldByCli: true } : {}),
  };
}

/** 坏行按条丢弃；坏顶层拒绝，避免一个损坏附件清空所有会话队列。 */
export function parsePromptQueues(raw: string | null | undefined): PersistedPromptQueues {
  if (!raw?.trim()) return {};
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch (error) {
    throw new Error(`提示队列文件不是有效 JSON：${error instanceof Error ? error.message : String(error)}`);
  }
  if (!isRecord(value)) throw new Error("提示队列文件必须是 JSON 对象");
  return Object.fromEntries(
    Object.entries(value).flatMap(([sessionId, rows]) => {
      if (!sessionId || !Array.isArray(rows)) return [];
      const valid = rows.map(queuedPrompt).filter((row): row is PersistedQueuedPrompt => Boolean(row));
      return valid.length > 0 ? [[sessionId, valid] as const] : [];
    }),
  );
}

export function loadPromptQueuesFromBrowser(): PersistedPromptQueues {
  try {
    return parsePromptQueues(localStorage.getItem(STORAGE_KEY));
  } catch {
    return {};
  }
}

export async function loadPromptQueues(): Promise<PersistedPromptQueues> {
  if (!("__TAURI_INTERNALS__" in window)) return loadPromptQueuesFromBrowser();
  return parsePromptQueues(await invoke<string | null>("read_prompt_queues"));
}

/**
 * 当前进程新增的行优先，磁盘行只补缺。这样延迟到达的启动读取不会覆盖用户刚
 * 在首屏排入的提示。
 */
export function mergeHydratedPromptQueues(
  persisted: PersistedPromptQueues,
  current: PersistedPromptQueues,
): PersistedPromptQueues {
  const result: PersistedPromptQueues = { ...persisted };
  for (const [sessionId, rows] of Object.entries(current)) {
    const currentIds = new Set(rows.map((row) => row.id));
    result[sessionId] = [
      ...(persisted[sessionId] ?? []).filter((row) => !currentIds.has(row.id)),
      ...rows,
    ];
  }
  return result;
}

export function persistPromptQueues(queues: PersistedPromptQueues): Promise<void> {
  const content = JSON.stringify(queues);
  if (!("__TAURI_INTERNALS__" in window)) {
    try {
      localStorage.setItem(STORAGE_KEY, content);
      return Promise.resolve();
    } catch (error) {
      return Promise.reject(error);
    }
  }
  // 串行化原子写，防止较早的慢写覆盖较新的队列快照。
  nativeWriteChain = nativeWriteChain.catch(() => {}).then(() => (
    invoke("write_prompt_queues", { content })
  ));
  return nativeWriteChain;
}
