import { invoke } from "@tauri-apps/api/core";

const LEGACY_DRAFT_BUFFER_KEY = "grox.draftBuffer.v1";
const DRAFT_BUFFER_MAX_CHARS = 1_500_000;
const MAX_DRAFT_AGE_MS = 7 * 24 * 60 * 60 * 1000;

export type DraftAttachment = {
  id: string;
  kind: "image" | "text" | "binary";
  name: string;
  mime: string;
  size: number;
  text?: string;
  data?: string;
};

export type DraftBuffer = {
  cwd: string;
  text: string;
  attachments: DraftAttachment[];
  updatedAt: number;
};

interface DraftSnapshot {
  revision: number;
  draft: DraftBuffer | null;
}

type DraftFailureHandler = (cwd: string, cause: unknown) => void;
type DesiredDraft = { sequence: number; draft: DraftBuffer | null };

let failureHandler: DraftFailureHandler | null = null;
let sequence = 0;
const revisions = new Map<string, number>();
const desired = new Map<string, DesiredDraft>();
const flushes = new Map<string, Promise<void>>();

export function setDraftFailureHandler(handler: DraftFailureHandler | null): void {
  failureHandler = handler;
}

function isNative(): boolean {
  return "__TAURI_INTERNALS__" in window;
}

function normalizeDraftCwd(cwd: string): string {
  const normalized = cwd.replace(/\\/g, "/").replace(/\/+$/, "");
  return /^[a-z]:\//i.test(normalized) ? normalized.toLowerCase() : normalized;
}

/**
 * 附件正文超出恢复预算时只保存元数据；发送路径仍持有原始附件，不能由持久化
 * 限制反向修改当前编辑器内容。
 */
export function compactDraftBuffer(
  cwd: string,
  text: string,
  attachments: DraftAttachment[] = [],
  updatedAt = Date.now(),
): DraftBuffer | null {
  const trimmed = text.trimEnd();
  if (!trimmed && attachments.length === 0) return null;
  const candidates: DraftBuffer[] = [
    { cwd, text: trimmed, attachments, updatedAt },
    {
      cwd,
      text: trimmed,
      attachments: attachments.map(({ id, kind, name, mime, size }) => ({ id, kind, name, mime, size })),
      updatedAt,
    },
    { cwd, text: trimmed, attachments: [], updatedAt },
  ];
  return candidates.find((candidate) => JSON.stringify(candidate).length <= DRAFT_BUFFER_MAX_CHARS)
    ?? candidates[candidates.length - 1]!;
}

function parseLegacyDrafts(): Record<string, DraftBuffer> {
  const raw = localStorage.getItem(LEGACY_DRAFT_BUFFER_KEY);
  if (!raw) return {};
  const parsed = JSON.parse(raw) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("旧版草稿缓存必须是 JSON 对象");
  }
  return parsed as Record<string, DraftBuffer>;
}

function readLegacyDraft(cwd: string): DraftBuffer | null {
  const value = parseLegacyDrafts()[normalizeDraftCwd(cwd)];
  if (!value || typeof value.text !== "string") return null;
  const attachments = Array.isArray(value.attachments) ? value.attachments : [];
  if (!value.text.trim() && attachments.length === 0) return null;
  return { ...value, cwd: value.cwd || cwd, attachments };
}

function writeBrowserDraft(cwd: string, draft: DraftBuffer | null): void {
  const drafts = parseLegacyDrafts();
  const key = normalizeDraftCwd(cwd);
  if (draft) drafts[key] = draft;
  else delete drafts[key];
  localStorage.setItem(LEGACY_DRAFT_BUFFER_KEY, JSON.stringify(drafts));
}

function clearLegacyDraft(cwd: string): void {
  try {
    writeBrowserDraft(cwd, null);
  } catch {
    // Host 已经是权威；旧 WebView 数据清理失败不能回滚原生事务。
  }
}

async function ensureRevision(cwd: string, key: string): Promise<number> {
  const known = revisions.get(key);
  if (known !== undefined) return known;
  const snapshot = await invoke<DraftSnapshot>("read_draft", { cwd });
  revisions.set(key, snapshot.revision);
  return snapshot.revision;
}

function scheduleNativeMutation(cwd: string, draft: DraftBuffer | null): Promise<void> {
  const key = normalizeDraftCwd(cwd);
  desired.set(key, { sequence: ++sequence, draft });
  const current = flushes.get(key);
  if (current) return current;

  const flush = (async () => {
    while (true) {
      const target = desired.get(key);
      if (!target) return;
      const expectedRevision = await ensureRevision(cwd, key);
      let snapshot: DraftSnapshot;
      try {
        snapshot = target.draft
          ? await invoke<DraftSnapshot>("write_draft", {
              cwd,
              expectedRevision,
              text: target.draft.text,
              attachments: target.draft.attachments,
            })
          : await invoke<DraftSnapshot>("delete_draft", { cwd, expectedRevision });
      } catch (cause) {
        // revision 冲突绝不能自动重放，否则发送成功后的旧窗口会复活草稿。
        if (desired.get(key)?.sequence === target.sequence) desired.delete(key);
        failureHandler?.(cwd, cause);
        throw cause;
      }
      revisions.set(key, snapshot.revision);
      if (desired.get(key)?.sequence === target.sequence) desired.delete(key);
    }
  })().finally(() => {
    if (flushes.get(key) === flush) {
      flushes.delete(key);
      const pending = desired.get(key);
      if (pending) void scheduleNativeMutation(pending.draft?.cwd ?? cwd, pending.draft).catch(() => {});
    }
  });
  flushes.set(key, flush);
  return flush;
}

export function saveDraftBuffer(
  cwd: string,
  text: string,
  attachments: DraftAttachment[] = [],
): Promise<void> {
  const draft = compactDraftBuffer(cwd, text, attachments);
  if (!isNative()) {
    try {
      writeBrowserDraft(cwd, draft);
      return Promise.resolve();
    } catch (cause) {
      failureHandler?.(cwd, cause);
      return Promise.reject(cause);
    }
  }
  return scheduleNativeMutation(cwd, draft);
}

export function clearDraftBuffer(cwd: string): Promise<void> {
  if (!isNative()) {
    try {
      writeBrowserDraft(cwd, null);
      return Promise.resolve();
    } catch (cause) {
      failureHandler?.(cwd, cause);
      return Promise.reject(cause);
    }
  }
  return scheduleNativeMutation(cwd, null);
}

export async function loadDraftBuffer(cwd: string): Promise<DraftBuffer | null> {
  if (!isNative()) {
    const draft = readLegacyDraft(cwd);
    if (draft && Date.now() - (draft.updatedAt || 0) > MAX_DRAFT_AGE_MS) {
      writeBrowserDraft(cwd, null);
      return null;
    }
    return draft;
  }

  const key = normalizeDraftCwd(cwd);
  await flushes.get(key);
  let snapshot = await invoke<DraftSnapshot>("read_draft", { cwd });
  revisions.set(key, snapshot.revision);

  // 只在 Host 从未见过该工作区时迁移旧 WebView 草稿。revision > 0 包含
  // 删除墓碑，必须压过 localStorage，避免已发送内容在重启后复活。
  if (!snapshot.draft && snapshot.revision === 0) {
    const legacy = readLegacyDraft(cwd);
    if (legacy) {
      await scheduleNativeMutation(cwd, compactDraftBuffer(
        cwd,
        legacy.text,
        legacy.attachments,
        legacy.updatedAt,
      ));
      snapshot = await invoke<DraftSnapshot>("read_draft", { cwd });
      revisions.set(key, snapshot.revision);
    }
  }
  clearLegacyDraft(cwd);

  const draft = snapshot.draft;
  if (draft && Date.now() - (draft.updatedAt || 0) > MAX_DRAFT_AGE_MS) {
    await clearDraftBuffer(cwd);
    return null;
  }
  return draft;
}

export function flushDraftPersistence(): void {
  for (const [key, target] of desired) {
    if (!flushes.has(key)) {
      void scheduleNativeMutation(target.draft?.cwd ?? key, target.draft).catch(() => {});
    }
  }
}

/** Test/HMR boundary: production state is process-scoped and monotonic. */
export function resetDraftPersistenceForTests(): void {
  revisions.clear();
  desired.clear();
  flushes.clear();
  sequence = 0;
  failureHandler = null;
}
