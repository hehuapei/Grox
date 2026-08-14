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
let nativeCommittedQueues: PersistedPromptQueues = {};
let nativeDesiredQueues: PersistedPromptQueues = {};
let nativePersistenceStarted = false;

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

export function parsePromptQueueSnapshot(value: unknown): PersistedQueuedPrompt[] {
  if (!Array.isArray(value)) return [];
  return value.map(queuedPrompt).filter((row): row is PersistedQueuedPrompt => Boolean(row));
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
      const valid = parsePromptQueueSnapshot(rows);
      return valid.length > 0 ? [[sessionId, valid] as const] : [];
    }),
  );
}

function readLegacyPromptQueues(): PersistedPromptQueues {
  try {
    return parsePromptQueues(localStorage.getItem(STORAGE_KEY));
  } catch {
    return {};
  }
}

export function loadPromptQueuesFromBrowser(): PersistedPromptQueues {
  // Tauri 的旧数据由异步原生迁移读取；首屏不能先把已删除的 localStorage 队列复活。
  if ("__TAURI_INTERNALS__" in window) return {};
  return readLegacyPromptQueues();
}

export async function loadPromptQueues(): Promise<PersistedPromptQueues> {
  if (!("__TAURI_INTERNALS__" in window)) return loadPromptQueuesFromBrowser();
  const raw = await invoke<string | null>("read_prompt_queues");
  const persisted = parsePromptQueues(raw);
  if (raw === null) {
    // 仅在原生仓储从未初始化时导入旧 localStorage；`{}` 也是有效初始化标记。
    const legacy = readLegacyPromptQueues();
    nativeDesiredQueues = nativePersistenceStarted
      ? mergeHydratedPromptQueues(legacy, nativeDesiredQueues)
      : snapshotPromptQueues(legacy);
    nativeWriteChain = nativeWriteChain.catch(() => {}).then(async () => {
      const target = snapshotPromptQueues(nativeDesiredQueues);
      await invoke("patch_prompt_queues", { upserts: target, deletes: [] });
      nativeCommittedQueues = target;
    });
    await nativeWriteChain;
    clearLegacyPromptQueues();
    return snapshotPromptQueues(nativeDesiredQueues);
  }
  nativeCommittedQueues = snapshotPromptQueues(persisted);
  nativeDesiredQueues = nativePersistenceStarted
    ? mergeHydratedPromptQueues(persisted, nativeDesiredQueues)
    : snapshotPromptQueues(persisted);
  clearLegacyPromptQueues();
  return persisted;
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

export interface PromptQueuePatch {
  upserts: PersistedPromptQueues;
  deletes: string[];
}

/** 只提交变化的会话；Host 会在锁内合并，不能再由前端覆盖整个队列文件。 */
export function diffPromptQueues(
  previous: PersistedPromptQueues,
  next: PersistedPromptQueues,
): PromptQueuePatch {
  const upserts: PersistedPromptQueues = {};
  const deletes: string[] = [];
  const ids = new Set([...Object.keys(previous), ...Object.keys(next)]);
  for (const sessionId of ids) {
    const before = previous[sessionId] ?? [];
    const after = next[sessionId] ?? [];
    if (after.length === 0) {
      if (before.length > 0) deletes.push(sessionId);
      continue;
    }
    if (JSON.stringify(before) !== JSON.stringify(after)) {
      upserts[sessionId] = after;
    }
  }
  return { upserts, deletes: deletes.sort() };
}

function snapshotPromptQueues(queues: PersistedPromptQueues): PersistedPromptQueues {
  return Object.fromEntries(
    Object.entries(queues)
      .filter(([, rows]) => rows.length > 0)
      .map(([sessionId, rows]) => [
        sessionId,
        rows.map((row) => ({
          ...row,
          attachments: row.attachments.map((attachment) => ({ ...attachment })),
        })),
      ]),
  );
}

function clearLegacyPromptQueues(): void {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    // 原生仓储已经提交成功；浏览器隐私模式阻止清理时不回滚磁盘事务。
  }
}

export function persistPromptQueues(queues: PersistedPromptQueues): Promise<void> {
  if (!("__TAURI_INTERNALS__" in window)) {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(queues));
      return Promise.resolve();
    } catch (error) {
      return Promise.reject(error);
    }
  }
  nativePersistenceStarted = true;
  nativeDesiredQueues = snapshotPromptQueues(queues);
  // Promise 链只负责提交顺序；真正的 RMW 与跨窗口互斥在 Host 内完成。
  nativeWriteChain = nativeWriteChain.catch(() => {}).then(async () => {
    const target = snapshotPromptQueues(nativeDesiredQueues);
    const patch = diffPromptQueues(nativeCommittedQueues, target);
    if (Object.keys(patch.upserts).length === 0 && patch.deletes.length === 0) return;
    await invoke("patch_prompt_queues", {
      upserts: patch.upserts,
      deletes: patch.deletes,
    });
    nativeCommittedQueues = target;
  });
  return nativeWriteChain;
}
