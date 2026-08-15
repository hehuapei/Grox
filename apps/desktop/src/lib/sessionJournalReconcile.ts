import type { Session, SessionBlock } from "../bridge/types";
import { blockContentKey, mergeOfflineWithLive } from "./offlineMerge";
import type { SessionJournalSnapshot } from "./sessionCache";

export const POST_TURN_RECONCILE_DELAYS_MS = [0, 125, 375, 750] as const;

export type SessionJournalReconcileOutcome =
  | "journal_only"
  | "agent_only"
  | "reconciled"
  | "interrupted"
  | "missing";

export interface SessionJournalReconcileResult {
  session: Session | null;
  outcome: SessionJournalReconcileOutcome;
  changed: boolean;
}

function interruptedBlock(snapshot: SessionJournalSnapshot): SessionBlock {
  return {
    type: "system",
    id: `journal-interrupted-${snapshot.appSessionId}-${snapshot.savedAt}`,
    text: "上次运行在回合完成前中断。已恢复可确认的本地记录；提示队列已暂停，请检查末尾内容后再恢复发送。",
    ts: snapshot.savedAt,
    kind: "error",
  };
}

function withInterruptedGate(session: Session, snapshot: SessionJournalSnapshot): Session {
  const marker = interruptedBlock(snapshot);
  const settled = session.blocks.map((block): SessionBlock => {
    if (block.type === "assistant") return { ...block, streaming: false };
    if (block.type === "thinking") return { ...block, live: false };
    if (block.type === "tool" && ["pending", "running", "awaiting_permission"].includes(block.call.status)) {
      return { ...block, call: { ...block.call, status: "cancelled", endedAt: snapshot.savedAt } };
    }
    return block;
  });
  const blocks = settled.some((block) => block.id === marker.id)
    ? settled
    : [...settled, marker];
  return { ...session, status: "failed", preview: true, blocks };
}

/**
 * An `active` journal means crash only when the Host turn is gone. During a
 * WebView reload the native process and turn may still be alive; in that case
 * remove the provisional interruption gate and continue consuming Host replay.
 */
export function resumeInterruptedSessionIfHostActive(session: Session): {
  session: Session;
  resumed: boolean;
} {
  const markerPrefix = `journal-interrupted-${session.id}-`;
  if (!session.blocks.some((block) => block.type === "system" && block.id.startsWith(markerPrefix))) {
    return { session, resumed: false };
  }
  return {
    resumed: true,
    session: {
      ...session,
      status: "running",
      preview: false,
      blocks: session.blocks.filter((block) => !(
        block.type === "system" && block.id.startsWith(markerPrefix)
      )),
    },
  };
}

/** Stable enough to decide whether a disk reconcile added transcript facts. */
export function sessionTranscriptSignature(session: Session | null | undefined): string {
  if (!session) return "";
  return JSON.stringify(session.blocks.map((block) => {
    if (block.type === "tool") {
      return [blockContentKey(block), block.call.status, block.call.input, block.call.output];
    }
    if ("text" in block) return [blockContentKey(block), block.text];
    return [blockContentKey(block), block];
  }));
}

/**
 * App journal owns UI continuity; Agent history owns model context. Reconcile
 * both without treating an active crash snapshot as a successfully settled turn.
 */
export function reconcileSessionJournal(
  snapshot: SessionJournalSnapshot | null,
  agentSession: Session | null,
): SessionJournalReconcileResult {
  if (!snapshot && !agentSession) return { session: null, outcome: "missing", changed: false };
  if (!snapshot) return { session: agentSession, outcome: "agent_only", changed: false };

  const before = sessionTranscriptSignature(snapshot.session);
  const merged = agentSession
    ? mergeOfflineWithLive(agentSession, snapshot.session)
    : snapshot.session;
  if (snapshot.turnState === "active") {
    return {
      session: withInterruptedGate(merged, snapshot),
      outcome: "interrupted",
      changed: sessionTranscriptSignature(merged) !== before,
    };
  }
  return {
    session: merged,
    outcome: agentSession ? "reconciled" : "journal_only",
    changed: sessionTranscriptSignature(merged) !== before,
  };
}
