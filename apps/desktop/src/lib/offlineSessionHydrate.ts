import { invoke } from "@tauri-apps/api/core";
import type { Session, SessionMeta } from "../bridge/types";
import { loadSessionJournal } from "./sessionCache";
import {
  reconcileSessionJournal,
  type SessionJournalReconcileOutcome,
} from "./sessionJournalReconcile";
import { sanitizeSessionForOpen } from "./sessionOpenPolicy";

type SessionDiskPreview = {
  messages: Array<{ role: "user" | "assistant"; text: string }>;
  truncated: boolean;
};

function sessionFromDiskPreview(meta: SessionMeta, preview: SessionDiskPreview): Session {
  return {
    ...meta,
    blocks: preview.messages.map((message, index) => ({
      type: message.role,
      id: `preview-${meta.id}-${index}`,
      text: message.text,
      ts: meta.createdAt + index,
    })),
    usage: {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      costUSD: 0,
      contextUsed: 0,
      contextMax: 0,
      turns: 0,
    },
    status: "idle",
    preview: true,
  };
}

/**
 * When ACP catalogue no longer knows a sidebar mission (stale id / other CLI),
 * still try local UI cache + on-disk chat_history.jsonl so open is not empty.
 */
export async function hydrateSessionOffline(id: string, meta: SessionMeta): Promise<Session | null> {
  return (await hydrateSessionOfflineDetailed(id, meta)).session;
}

export interface OfflineSessionHydration {
  session: Session | null;
  outcome: SessionJournalReconcileOutcome;
  journalSavedAt?: number;
  journalError?: unknown;
  agentError?: unknown;
}

/** Always inspect both sources: a stale app snapshot must not hide Agent's final reply. */
export async function hydrateSessionOfflineDetailed(
  id: string,
  meta: SessionMeta,
): Promise<OfflineSessionHydration> {
  const [journalResult, agentResult] = await Promise.allSettled([
    loadSessionJournal(id),
    invoke<SessionDiskPreview | null>("preview_session_from_disk", { id }),
  ]);
  const snapshot = journalResult.status === "fulfilled" ? journalResult.value : null;
  const preview = agentResult.status === "fulfilled" ? agentResult.value : null;
  const agentSession = preview?.messages?.length ? sessionFromDiskPreview(meta, preview) : null;
  const reconciled = reconcileSessionJournal(snapshot, agentSession);
  return {
    ...reconciled,
    session: reconciled.session
      ? reconciled.outcome === "interrupted"
        ? reconciled.session
        : { ...reconciled.session, ...sanitizeSessionForOpen(reconciled.session) }
      : null,
    journalSavedAt: snapshot?.savedAt,
    journalError: journalResult.status === "rejected" ? journalResult.reason : undefined,
    agentError: agentResult.status === "rejected" ? agentResult.reason : undefined,
  };
}

/** Prefer the payload with more transcript body. */
export function preferRicherSession(current: Session | undefined, incoming: Session): Session {
  if (!current) return incoming;
  if (current.blocks.length > incoming.blocks.length && !incoming.preview) return current;
  if (current.blocks.length > incoming.blocks.length && incoming.preview) return current;
  if (!current.preview && incoming.preview && current.blocks.length > 0) return current;
  return incoming;
}
