import { invoke } from "@tauri-apps/api/core";
import type { Session, SessionBlock } from "../bridge/types";
import { isSessionTerminal } from "../bridge/types";

const MAX_JOURNAL_BLOCKS = 600;
const MAX_BODY_TEXT = 64_000;
const MAX_TOOL_TEXT = 16_000;
/** Live streaming debounce — short enough that a hard crash loses little UI journal. */
const LIVE_SAVE_DEBOUNCE_MS = 250;
/** Completed turns flush immediately (0). */
const TERMINAL_SAVE_DEBOUNCE_MS = 0;

export type SessionJournalTurnState = "active" | "settled";

export interface SessionJournalSnapshot {
  version: 1;
  appSessionId: string;
  /** v0.3.2 仍与应用会话同 ID；字段为后续身份拆分保留稳定迁移点。 */
  agentSessionId: string;
  savedAt: number;
  turnState: SessionJournalTurnState;
  session: Session;
}

type SessionJournalFailureHandler = (sessionId: string, cause: unknown) => void;
let journalFailureHandler: SessionJournalFailureHandler | null = null;

export function setSessionJournalFailureHandler(handler: SessionJournalFailureHandler | null): void {
  journalFailureHandler = handler;
}

const truncate = (value: string | undefined, limit: number) => {
  if (value == null || value.length <= limit) return value;
  return `${value.slice(0, limit)}\n…[缓存已截断]`;
};

function freezeBlock(block: SessionBlock): SessionBlock {
  if (block.type === "assistant") return { ...block, streaming: false, text: truncate(block.text, MAX_BODY_TEXT) ?? "" };
  if (block.type === "thinking") return { ...block, live: false, text: truncate(block.text, MAX_BODY_TEXT) ?? "" };
  if (block.type === "user") return { ...block, text: truncate(block.text, MAX_BODY_TEXT) ?? "" };
  if (block.type === "tool") return {
    ...block,
    call: {
      ...block.call,
      status: block.call.status === "running" || block.call.status === "pending" ? "done" : block.call.status,
      input: truncate(block.call.input, MAX_TOOL_TEXT),
      output: truncate(block.call.output, MAX_TOOL_TEXT),
      images: undefined,
      terminal: block.call.terminal ? { ...block.call.terminal, lines: block.call.terminal.lines.slice(-80) } : undefined,
    },
  };
  if (block.type === "system") return { ...block, text: truncate(block.text, MAX_TOOL_TEXT) ?? "" };
  return block;
}

/**
 * Take the last N blocks but never start mid-turn.
 * Evidence: raw slice(-160) can begin on a tool mid-stream and seam badly on reopen.
 */
export function sliceCacheBlocks(
  blocks: readonly SessionBlock[],
  max = MAX_JOURNAL_BLOCKS,
): SessionBlock[] {
  if (blocks.length <= max) return [...blocks];
  let start = blocks.length - max;
  for (let i = start; i >= 0; i -= 1) {
    const b = blocks[i];
    if (b.type === "user" && !("interjected" in b && b.interjected)) {
      start = i;
      break;
    }
    if (i === 0) start = 0;
  }
  if (blocks.length - start > max * 2) {
    start = blocks.length - max;
  }
  return blocks.slice(start);
}

export function compactSession(session: Session): Session {
  return {
    ...session,
    status: "idle",
    preview: true,
    blocks: sliceCacheBlocks(session.blocks, MAX_JOURNAL_BLOCKS).map(freezeBlock),
  };
}

export function sessionJournalSnapshot(session: Session, savedAt = Date.now()): SessionJournalSnapshot {
  return {
    version: 1,
    appSessionId: session.id,
    agentSessionId: session.id,
    savedAt,
    turnState: isSessionTerminal(session.status) ? "settled" : "active",
    session: compactSession(session),
  };
}

export function parseSessionJournal(raw: string, id: string): SessionJournalSnapshot {
  const parsed = JSON.parse(raw) as Partial<SessionJournalSnapshot> & Partial<Session>;
  // v0.3.1/v0.3.2 early builds wrote a bare Session into session-cache.
  if (parsed.version !== 1) {
    if (parsed.id !== id || !Array.isArray(parsed.blocks)) throw new Error("应用会话 journal 与目标会话不匹配");
    const session = compactSession(parsed as Session);
    return {
      version: 1,
      appSessionId: id,
      agentSessionId: id,
      savedAt: Number(parsed.updatedAt) || Date.now(),
      turnState: "settled",
      session,
    };
  }
  if (
    parsed.appSessionId !== id
    || typeof parsed.agentSessionId !== "string"
    || typeof parsed.savedAt !== "number"
    || !["active", "settled"].includes(String(parsed.turnState))
    || !parsed.session
    || parsed.session.id !== id
    || !Array.isArray(parsed.session.blocks)
  ) {
    throw new Error("应用会话 journal 格式无效或会话身份不匹配");
  }
  return {
    version: 1,
    appSessionId: id,
    agentSessionId: parsed.agentSessionId,
    savedAt: parsed.savedAt,
    turnState: parsed.turnState as SessionJournalTurnState,
    session: compactSession(parsed.session),
  };
}

export async function loadSessionJournal(id: string): Promise<SessionJournalSnapshot | null> {
  const raw = await invoke<string | null>("read_session_journal", { id });
  return raw ? parseSessionJournal(raw, id) : null;
}

const timers = new Map<string, number>();
/** Latest payload per id waiting for disk (survives debounce cancellation). */
const pendingPayloads = new Map<string, string>();
const inFlight = new Map<string, Promise<void>>();

function writePayload(id: string, content: string): Promise<void> {
  pendingPayloads.set(id, content);
  const prior = inFlight.get(id) ?? Promise.resolve();
  const next = prior
    .catch(() => {})
    .then(async () => {
      const latest = pendingPayloads.get(id);
      if (latest === undefined) return;
      // Drop if a newer payload replaced this one while we waited.
      if (latest !== content && pendingPayloads.get(id) !== content) {
        // Still write the absolute latest once.
      }
      const toWrite = pendingPayloads.get(id);
      if (toWrite === undefined) return;
      pendingPayloads.delete(id);
      await invoke("write_session_journal", { id, content: toWrite });
    })
    .catch((cause) => {
      journalFailureHandler?.(id, cause);
    })
    .finally(() => {
      if (inFlight.get(id) === next) inFlight.delete(id);
    });
  inFlight.set(id, next);
  return next;
}

/**
 * Schedule a durable UI snapshot. Terminal sessions flush immediately so a
 * BSOD right after turn completion still has a cache of the finished transcript.
 */
export function scheduleSaveSessionJournal(session: Session): void {
  if (!session.id || session.blocks.length === 0) return;
  if (session.id.startsWith("draft-") || session.id.startsWith("pending-")) return;

  const content = JSON.stringify(sessionJournalSnapshot(session));
  const delay = isSessionTerminal(session.status) ? TERMINAL_SAVE_DEBOUNCE_MS : LIVE_SAVE_DEBOUNCE_MS;

  const previous = timers.get(session.id);
  if (previous !== undefined) window.clearTimeout(previous);

  if (delay <= 0) {
    timers.delete(session.id);
    void writePayload(session.id, content);
    return;
  }

  timers.set(session.id, window.setTimeout(() => {
    timers.delete(session.id);
    void writePayload(session.id, content);
  }, delay));
}

/** Force any debounced snapshot for one session to disk now. */
export function flushSessionJournal(session: Session): void {
  if (!session.id || session.blocks.length === 0) return;
  if (session.id.startsWith("draft-") || session.id.startsWith("pending-")) return;
  const previous = timers.get(session.id);
  if (previous !== undefined) window.clearTimeout(previous);
  timers.delete(session.id);
  void writePayload(session.id, JSON.stringify(sessionJournalSnapshot(session)));
}

/**
 * Flush every pending debounce using the last scheduled payload map and any
 * timers. Call on visibility hidden / pagehide for crash-window shrinkage.
 */
export function flushAllPendingSessionJournals(
  sessions: Record<string, Session>,
): void {
  for (const [id, timer] of [...timers.entries()]) {
    window.clearTimeout(timer);
    timers.delete(id);
    const session = sessions[id];
    if (session && session.blocks.length > 0) {
      void writePayload(id, JSON.stringify(sessionJournalSnapshot(session)));
    }
  }
}

export function cancelPendingSessionJournal(id: string): void {
  const timer = timers.get(id);
  if (timer !== undefined) window.clearTimeout(timer);
  timers.delete(id);
  pendingPayloads.delete(id);
}

export async function scrubSessionJournalOrphans(): Promise<number> {
  try {
    return await invoke<number>("scrub_session_journal_orphans");
  } catch {
    return 0;
  }
}

// ── Draft composer crash buffer ─────────────────────────────────────────
// Unsent draft text/attachments never reach CLI disk. Persist a local copy so
// BSOD mid-compose or a failed first-send (session/new) can restore after reboot.

const DRAFT_BUFFER_KEY = "grox.draftBuffer.v1";
/** Soft cap for the entire draftBuffer map payload (localStorage quota). */
const DRAFT_BUFFER_MAX_CHARS = 1_500_000;

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
  /** Full payloads when they fit; otherwise empty after size fallback. */
  attachments?: DraftAttachment[];
  updatedAt: number;
};

export function saveDraftBuffer(
  cwd: string,
  text: string,
  attachments: DraftAttachment[] = [],
): void {
  const trimmed = text.trimEnd();
  if (!trimmed && attachments.length === 0) {
    clearDraftBuffer(cwd);
    return;
  }
  try {
    const all = loadAllDraftBuffers();
    const key = normalizeDraftCwd(cwd);
    const updatedAt = Date.now();
    // Prefer full recovery (text + attachment bodies). If over budget, keep
    // text and strip heavy payloads; if still over, text only.
    const candidates: DraftBuffer[] = [
      { cwd, text: trimmed, attachments, updatedAt },
      {
        cwd,
        text: trimmed,
        attachments: attachments.map((item) => ({
          id: item.id,
          kind: item.kind,
          name: item.name,
          mime: item.mime,
          size: item.size,
        })),
        updatedAt,
      },
      { cwd, text: trimmed, attachments: [], updatedAt },
    ];
    let chosen = candidates[candidates.length - 1]!;
    for (const candidate of candidates) {
      all[key] = candidate;
      if (JSON.stringify(all).length <= DRAFT_BUFFER_MAX_CHARS) {
        chosen = candidate;
        break;
      }
    }
    all[key] = chosen;
    localStorage.setItem(DRAFT_BUFFER_KEY, JSON.stringify(all));
  } catch {
    // quota / private mode — best-effort text-only retry
    try {
      const all = loadAllDraftBuffers();
      if (trimmed) {
        all[normalizeDraftCwd(cwd)] = { cwd, text: trimmed, attachments: [], updatedAt: Date.now() };
        localStorage.setItem(DRAFT_BUFFER_KEY, JSON.stringify(all));
      }
    } catch {
      // ignore
    }
  }
}

export function loadDraftBuffer(cwd: string): DraftBuffer | null {
  try {
    const entry = loadAllDraftBuffers()[normalizeDraftCwd(cwd)];
    if (!entry || typeof entry.text !== "string") return null;
    const attachments = Array.isArray(entry.attachments) ? entry.attachments : [];
    if (!entry.text.trim() && attachments.length === 0) return null;
    // Drop stale buffers older than 7 days.
    if (Date.now() - (entry.updatedAt || 0) > 7 * 24 * 60 * 60 * 1000) {
      clearDraftBuffer(cwd);
      return null;
    }
    return {
      cwd: entry.cwd,
      text: entry.text,
      attachments,
      updatedAt: entry.updatedAt,
    };
  } catch {
    return null;
  }
}

export function clearDraftBuffer(cwd: string): void {
  try {
    const all = loadAllDraftBuffers();
    delete all[normalizeDraftCwd(cwd)];
    localStorage.setItem(DRAFT_BUFFER_KEY, JSON.stringify(all));
  } catch {
    // ignore
  }
}

function normalizeDraftCwd(cwd: string): string {
  return cwd.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}

function loadAllDraftBuffers(): Record<string, DraftBuffer> {
  try {
    const raw = localStorage.getItem(DRAFT_BUFFER_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Record<string, DraftBuffer>;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}
