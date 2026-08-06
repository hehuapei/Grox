import type { Session, SessionBlock, SessionStatus } from "../bridge/types";

/** True when a transcript block still needs operator input. */
export function isUnresolvedGate(block: SessionBlock): boolean {
  if (block.type === "permission") return !block.resolved;
  if (block.type === "question") return !block.response;
  return false;
}

/**
 * After resolving one permission/question, compute the next session status.
 * Must not jump to `running` while another gate card is still open (multi-tool
 * approvals often stack).
 */
export function statusAfterGateResolve(
  blocks: readonly SessionBlock[],
  previous: SessionStatus,
): SessionStatus {
  const hasQuestion = blocks.some(
    (block) => block.type === "question" && !block.response,
  );
  if (hasQuestion) return "awaiting_input";
  const hasPermission = blocks.some(
    (block) => block.type === "permission" && !block.resolved,
  );
  if (hasPermission) return "awaiting_permission";
  if (previous === "awaiting_permission" || previous === "awaiting_input") {
    return "running";
  }
  return previous;
}

/**
 * Apply a bridge status event without demoting open permission/question cards.
 *
 * Concurrent `finishTurn` / enqueue often emit `running` while a gate is still
 * open; that would strip PermissionCard/QuestionCard of `isActive` and make
 * Composer think the turn is interjectable. `idle` stays authoritative so Stop
 * / turn-end can still settle the UI (cards become inactive via status).
 */
export function reconcileIncomingStatus(
  blocks: readonly SessionBlock[],
  previous: SessionStatus,
  incoming: SessionStatus,
): SessionStatus {
  if (incoming === "running" && blocks.some(isUnresolvedGate)) {
    return statusAfterGateResolve(blocks, previous);
  }
  return incoming;
}

/** Latest unresolved permission block id (keyboard / focus target). */
export function topPendingPermissionId(session: Session | null | undefined): string | null {
  if (!session) return null;
  for (let i = session.blocks.length - 1; i >= 0; i -= 1) {
    const block = session.blocks[i];
    if (block.type === "permission" && !block.resolved) return block.id;
  }
  return null;
}

/** Latest unresolved question block id (only one interview should be interactive). */
export function topPendingQuestionId(session: Session | null | undefined): string | null {
  if (!session) return null;
  for (let i = session.blocks.length - 1; i >= 0; i -= 1) {
    const block = session.blocks[i];
    if (block.type === "question" && !block.response) return block.id;
  }
  return null;
}
