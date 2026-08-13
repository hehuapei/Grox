/**
 * 会话运行时的唯一决策层。
 *
 * Bridge 只提供协议事实，Store 只持久化并展示这里投影出的状态。所有关于
 * “是否忙碌、是否可发送、门禁是否仍打开、队列能否继续”的判断都集中在此，
 * 避免同一条会话在多个组件里被解释成不同状态。
 */

import type { Session, SessionBlock, SessionStatus } from "../bridge/types";
import { isSessionTerminal } from "../bridge/types";
import { isOpenToolStatus } from "./promptTurnTimeout";

export type SessionPhase =
  | "connecting"
  | "idle"
  | "working"
  | "waiting_permission"
  | "waiting_input"
  | "stopping"
  | "disconnected"
  | "failed";

export interface SessionSnapshot {
  status: SessionStatus;
  phase: SessionPhase;
  busy: boolean;
  sendable: boolean;
  pendingPermissionId: string | null;
  pendingQuestionId: string | null;
}

/** Quiet gap after the last live block before post-prompt continuation settles. */
export const POST_PROMPT_SETTLE_MS = 1_600;

/** True when a transcript block still needs operator input. */
export function isUnresolvedGate(block: SessionBlock): boolean {
  if (block.type === "permission") return !block.resolved;
  if (block.type === "question") return !block.response;
  return false;
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

/**
 * After resolving one permission/question, compute the next session status.
 * Must not jump to `running` while another gate card is still open.
 */
export function statusAfterGateResolve(
  blocks: readonly SessionBlock[],
  previous: SessionStatus,
): SessionStatus {
  if (blocks.some((block) => block.type === "question" && !block.response)) {
    return "awaiting_input";
  }
  if (blocks.some((block) => block.type === "permission" && !block.resolved)) {
    return "awaiting_permission";
  }
  if (previous === "awaiting_permission" || previous === "awaiting_input") {
    return "running";
  }
  return previous;
}

/** Apply a bridge status event without demoting open permission/question cards. */
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

/** UI 和操作入口只消费这个快照，不再各自重算 busy / gate。 */
export function deriveSessionSnapshot(args: {
  status: SessionStatus | null | undefined;
  blocks?: readonly SessionBlock[];
}): SessionSnapshot {
  const blocks = args.blocks ?? [];
  const rawStatus = args.status ?? "idle";
  const status = reconcileIncomingStatus(blocks, rawStatus, rawStatus);
  const session = { id: "snapshot", status, blocks } as Session;
  const busy = !isSessionTerminal(status);
  const phase: SessionPhase = status === "connecting"
    ? "connecting"
    : status === "stopping"
      ? "stopping"
      : status === "disconnected"
        ? "disconnected"
        : status === "failed"
    ? "failed"
    : status === "awaiting_permission"
      ? "waiting_permission"
      : status === "awaiting_input"
        ? "waiting_input"
        : busy
          ? "working"
          : "idle";

  return {
    status,
    phase,
    busy,
    sendable: !busy,
    pendingPermissionId: topPendingPermissionId(session),
    pendingQuestionId: topPendingQuestionId(session),
  };
}

/** Compatibility-shaped selector for call sites that only need the busy bit. */
export function sessionLooksBusy(args: {
  status: SessionStatus | null | undefined;
  blocks?: readonly SessionBlock[];
}): boolean {
  return deriveSessionSnapshot(args).busy;
}

/** A new primary prompt is safe once the authoritative session status is terminal. */
export function sessionAcceptsNewPrimaryPrompt(args: {
  status: SessionStatus;
  blocks?: readonly SessionBlock[];
}): boolean {
  return deriveSessionSnapshot(args).sendable;
}

export function shouldPromotePostPrompt(args: {
  status: SessionStatus;
  promptReturned: boolean;
  hasLiveText: boolean;
}): boolean {
  return args.promptReturned && args.hasLiveText && args.status === "idle";
}

/**
 * Arm a quiet timer after prompt return. The timer must fire even while a stale
 * thinking block remains live, otherwise the session can stay busy forever.
 */
export function shouldArmPostPromptSettle(args: {
  status: SessionStatus;
  promptReturned: boolean;
  hasLiveText: boolean;
}): boolean {
  if (!args.promptReturned) return false;
  return args.hasLiveText || args.status === "running";
}

/** Clear stale thinking/streaming labels without touching background tools. */
export function settleLiveTextBlocks(blocks: readonly SessionBlock[]): SessionBlock[] {
  return blocks.map((block) => {
    if (block.type === "thinking" && block.live) return { ...block, live: false };
    if (block.type === "assistant" && block.streaming) return { ...block, streaming: false };
    return block;
  });
}

/** Stop a post-prompt continuation in the UI so Send comes back immediately. */
export function settleLiveProcessBlocks(blocks: readonly SessionBlock[]): SessionBlock[] {
  const now = Date.now();
  return settleLiveTextBlocks(blocks).map((block) => {
    if (block.type === "tool" && isOpenToolStatus(block.call.status)) {
      return {
        ...block,
        call: { ...block.call, status: "cancelled", endedAt: block.call.endedAt ?? now },
      };
    }
    return block;
  });
}

export type TurnKind = "idle" | "running" | "gated";

export function classifyTurnStatus(status: SessionStatus): TurnKind {
  const phase = deriveSessionSnapshot({ status }).phase;
  if (phase === "idle" || phase === "failed") return "idle";
  if (phase === "waiting_permission" || phase === "waiting_input") return "gated";
  return "running";
}

export function shouldDrainLocalQueue(input: {
  status: SessionStatus;
  providerSwitching: boolean;
  restoring: boolean;
  suppressed: boolean;
  queueLength: number;
  /** Late thinking / open tools after prompt return — do not start the next turn. */
  hasLiveProcess?: boolean;
}): boolean {
  return deriveSessionSnapshot({ status: input.status }).sendable
    && !input.hasLiveProcess
    && !input.providerSwitching
    && !input.restoring
    && !input.suppressed
    && input.queueLength > 0;
}

/** Apply park/unpark to the reactive mirror of the runtime queue gate. */
export function nextQueueDrainParked(
  current: Record<string, boolean>,
  sessionId: string,
  parked: boolean,
): Record<string, boolean> {
  if (parked) {
    if (current[sessionId]) return current;
    return { ...current, [sessionId]: true };
  }
  if (!current[sessionId]) return current;
  const next = { ...current };
  delete next[sessionId];
  return next;
}

export function isQueueDrainParked(
  parked: Record<string, boolean>,
  sessionId: string,
): boolean {
  return Boolean(parked[sessionId]);
}
