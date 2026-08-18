import { invoke } from "@tauri-apps/api/core";
import type { Session, SessionBlock, ToolImage } from "../bridge/types";
import { isSessionTerminal } from "../bridge/types";
import { displayReplayUserPrompt } from "./replayUserPrompt";

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
  hostEvents?: {
    streamId: string;
    sequences: number[];
  };
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

export function durableToolImages(images: ToolImage[] | undefined): ToolImage[] | undefined {
  const durable = images?.flatMap((image) => image.path ? [{ mime: image.mime, path: image.path }] : []);
  return durable && durable.length > 0 ? durable : undefined;
}

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
      images: durableToolImages(block.call.images),
      terminal: block.call.terminal ? { ...block.call.terminal, lines: block.call.terminal.lines.slice(-80) } : undefined,
    },
  };
  if (block.type === "system") return { ...block, text: truncate(block.text, MAX_TOOL_TEXT) ?? "" };
  return block;
}

function journalBlock(block: SessionBlock): SessionBlock {
  if (block.type === "assistant") return { ...block, text: truncate(block.text, MAX_BODY_TEXT) ?? "" };
  if (block.type === "thinking") return { ...block, text: truncate(block.text, MAX_BODY_TEXT) ?? "" };
  if (block.type === "user") return { ...block, text: truncate(block.text, MAX_BODY_TEXT) ?? "" };
  if (block.type === "tool") return {
    ...block,
    call: {
      ...block.call,
      input: truncate(block.call.input, MAX_TOOL_TEXT),
      output: truncate(block.call.output, MAX_TOOL_TEXT),
      images: durableToolImages(block.call.images),
      terminal: block.call.terminal ? { ...block.call.terminal, lines: block.call.terminal.lines.slice(-80) } : undefined,
    },
  };
  if (block.type === "system") return { ...block, text: truncate(block.text, MAX_TOOL_TEXT) ?? "" };
  return block;
}

function visibleJournalBlock(block: SessionBlock): SessionBlock[] {
  if (block.type !== "user") return [block];
  const text = displayReplayUserPrompt(block.text);
  return text ? [{ ...block, text }] : [];
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
    blocks: sliceCacheBlocks(session.blocks, MAX_JOURNAL_BLOCKS).map(freezeBlock).flatMap(visibleJournalBlock),
  };
}

function journalSession(session: Session): Session {
  return {
    ...session,
    blocks: sliceCacheBlocks(session.blocks, MAX_JOURNAL_BLOCKS).map(journalBlock).flatMap(visibleJournalBlock),
  };
}

interface PendingHostEvents {
  streamId: string;
  sequences: Set<number>;
}

const pendingHostEvents = new Map<string, PendingHostEvents>();

export function recordSessionJournalHostEvent(
  sessionId: string,
  streamId: string,
  sequence: number,
): void {
  if (!sessionId || !streamId || !Number.isSafeInteger(sequence) || sequence < 1) return;
  let pending = pendingHostEvents.get(sessionId);
  if (!pending || pending.streamId !== streamId) {
    pending = { streamId, sequences: new Set<number>() };
    pendingHostEvents.set(sessionId, pending);
  }
  pending.sequences.add(sequence);
  if (pending.sequences.size > 8_192) {
    const oldest = Math.min(...pending.sequences);
    pending.sequences.delete(oldest);
  }
}

function snapshotHostEvents(sessionId: string): SessionJournalSnapshot["hostEvents"] {
  const pending = pendingHostEvents.get(sessionId);
  if (!pending || pending.sequences.size === 0) return undefined;
  return {
    streamId: pending.streamId,
    sequences: [...pending.sequences].sort((left, right) => left - right),
  };
}

export function sessionJournalSnapshot(session: Session, savedAt = Date.now()): SessionJournalSnapshot {
  const hostEvents = snapshotHostEvents(session.id);
  return {
    version: 1,
    appSessionId: session.id,
    agentSessionId: session.id,
    savedAt,
    turnState: isSessionTerminal(session.status) ? "settled" : "active",
    ...(hostEvents ? { hostEvents } : {}),
    session: journalSession(session),
  };
}

export function nextSessionJournalSavedAt(previous: number | undefined, now = Date.now()): number {
  return Math.max(now, (previous ?? 0) + 1);
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
  const hostEvents = parsed.hostEvents;
  if (hostEvents && (
    typeof hostEvents.streamId !== "string"
    || !hostEvents.streamId
    || hostEvents.streamId.length > 128
    || !/^[A-Za-z0-9_.:-]+$/.test(hostEvents.streamId)
    || !Array.isArray(hostEvents.sequences)
    || hostEvents.sequences.length > 8_192
    || hostEvents.sequences.some((sequence, index) => (
      !Number.isSafeInteger(sequence)
      || sequence < 1
      || (index > 0 && sequence <= hostEvents.sequences[index - 1])
    ))
  )) {
    throw new Error("应用会话 journal 的 Host 事件确认无效");
  }
  return {
    version: 1,
    appSessionId: id,
    agentSessionId: parsed.agentSessionId,
    savedAt: parsed.savedAt,
    turnState: parsed.turnState as SessionJournalTurnState,
    ...(hostEvents ? { hostEvents } : {}),
    session: journalSession(parsed.session),
  };
}

export async function loadSessionJournal(id: string): Promise<SessionJournalSnapshot | null> {
  const raw = await invoke<string | null>("read_session_journal", { id });
  if (!raw) {
    journalSavedAt.delete(id);
    journalWriteConflicts.delete(id);
    return null;
  }
  const snapshot = parseSessionJournal(raw, id);
  rememberSessionJournalSnapshot(snapshot);
  return snapshot;
}

const timers = new Map<string, number>();
/** Per-session logical clock seeded from disk; survives wall-clock rollback. */
const journalSavedAt = new Map<string, number>();
/** A stale writer must reload before it can write this session again. */
const journalWriteConflicts = new Set<string>();
/** Latest payload per id waiting for disk (survives debounce cancellation). */
const pendingPayloads = new Map<string, string>();
const inFlight = new Map<string, Promise<void>>();

export function rememberSessionJournalSnapshot(snapshot: SessionJournalSnapshot): void {
  journalSavedAt.set(
    snapshot.appSessionId,
    Math.max(journalSavedAt.get(snapshot.appSessionId) ?? 0, snapshot.savedAt),
  );
  journalWriteConflicts.delete(snapshot.appSessionId);
}

function writePayload(id: string, content: string): Promise<void> {
  if (journalWriteConflicts.has(id)) return Promise.resolve();
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
      clearAcknowledgedHostEvents(id, toWrite);
    })
    .catch((cause) => {
      if (String(cause).includes("journal 写入冲突")) journalWriteConflicts.add(id);
      journalFailureHandler?.(id, cause);
    })
    .finally(() => {
      if (inFlight.get(id) === next) inFlight.delete(id);
    });
  inFlight.set(id, next);
  return next;
}

function clearAcknowledgedHostEvents(id: string, content: string): void {
  let acknowledged: SessionJournalSnapshot["hostEvents"];
  try {
    acknowledged = (JSON.parse(content) as Partial<SessionJournalSnapshot>).hostEvents;
  } catch {
    return;
  }
  const pending = pendingHostEvents.get(id);
  if (!acknowledged || !pending || pending.streamId !== acknowledged.streamId) return;
  for (const sequence of acknowledged.sequences) pending.sequences.delete(sequence);
  if (pending.sequences.size === 0) pendingHostEvents.delete(id);
}

function nextSessionJournalSnapshot(session: Session): SessionJournalSnapshot {
  const savedAt = nextSessionJournalSavedAt(journalSavedAt.get(session.id));
  journalSavedAt.set(session.id, savedAt);
  return sessionJournalSnapshot(session, savedAt);
}

/**
 * Schedule a durable UI snapshot. Terminal sessions flush immediately so a
 * BSOD right after turn completion still has a cache of the finished transcript.
 */
export function scheduleSaveSessionJournal(session: Session): void {
  if (!session.id || session.blocks.length === 0) return;
  if (session.id.startsWith("draft-") || session.id.startsWith("pending-")) return;

  const content = JSON.stringify(nextSessionJournalSnapshot(session));
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
  void writePayload(session.id, JSON.stringify(nextSessionJournalSnapshot(session)));
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
      void writePayload(id, JSON.stringify(nextSessionJournalSnapshot(session)));
    }
  }
}

export function cancelPendingSessionJournal(id: string): void {
  const timer = timers.get(id);
  if (timer !== undefined) window.clearTimeout(timer);
  timers.delete(id);
  pendingPayloads.delete(id);
  journalSavedAt.delete(id);
  journalWriteConflicts.delete(id);
  pendingHostEvents.delete(id);
}

export async function scrubSessionJournalOrphans(): Promise<number> {
  try {
    return await invoke<number>("scrub_session_journal_orphans");
  } catch {
    return 0;
  }
}
