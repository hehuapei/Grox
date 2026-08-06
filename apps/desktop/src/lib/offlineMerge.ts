import type { Session, SessionBlock, SessionStatus } from "../bridge/types";

/** True when the live session must not be forced idle by a disk merge. */
export function isLiveBusyStatus(status: SessionStatus | undefined): boolean {
  return status === "running" || status === "awaiting_permission" || status === "awaiting_input";
}

/**
 * Content fingerprint for offline/live block identity.
 */
export function blockContentKey(block: SessionBlock): string {
  switch (block.type) {
    case "user":
      return `user:${block.interjected ? "i:" : ""}${block.text.trim().slice(0, 240)}`;
    case "assistant":
      return `assistant:${block.text.trim().slice(0, 240)}`;
    case "thinking":
      return `thinking:${block.text.trim().slice(0, 160)}`;
    case "tool":
      return `tool:${block.call.id || block.call.title}:${block.call.kind}`;
    case "plan":
      return `plan:${block.steps.map((s) => s.content).join("|").slice(0, 160)}`;
    case "permission":
      return `perm:${block.id}:${block.req?.title ?? ""}`;
    case "question":
      return `q:${block.id}`;
    case "system":
      return `sys:${block.kind ?? ""}:${block.text.trim().slice(0, 120)}`;
    default:
      return `other:${(block as SessionBlock).type}:${(block as SessionBlock).id}`;
  }
}

/** First primary (non-interject) user block — stable turn boundary for seaming. */
export function firstPrimaryUserBlock(
  blocks: readonly SessionBlock[],
): SessionBlock | undefined {
  return blocks.find((b) => b.type === "user" && !b.interjected);
}

/** Synthetic tool ids from chat_history preview / offline prefixes — not ACP call ids. */
export function isSyntheticToolCallId(id: string | undefined): boolean {
  if (!id) return true;
  return (
    id === "tool" ||
    id.startsWith("disk-tool-") ||
    id.startsWith("off-tool-") ||
    id.startsWith("off-tool-cal")
  );
}

/**
 * Reuse live block objects when content keys match offline (stable React keys).
 * Prefer fuller offline body when live is cache-truncated (same content key).
 */
export function stabilizeOfflineBlocksWithLive(
  offlineBlocks: readonly SessionBlock[],
  liveBlocks: readonly SessionBlock[],
): SessionBlock[] {
  if (liveBlocks.length === 0) return [...offlineBlocks];
  const liveByKey = new Map<string, SessionBlock>();
  for (const b of liveBlocks) {
    const k = blockContentKey(b);
    if (!liveByKey.has(k)) liveByKey.set(k, b);
  }
  return offlineBlocks.map((b) => {
    const live = liveByKey.get(blockContentKey(b));
    if (!live) return b;
    // Cache paint truncates text; offline scan has the fuller body — keep live
    // identity (React key) but restore offline text when longer.
    if (
      (b.type === "assistant" || b.type === "user" || b.type === "thinking") &&
      live.type === b.type &&
      typeof b.text === "string" &&
      typeof live.text === "string" &&
      b.text.length > live.text.length
    ) {
      return { ...live, text: b.text } as SessionBlock;
    }
    return live;
  });
}

/**
 * Insert live-only blocks into an offline spine.
 *
 * For each live-only block, place it immediately before the next live block
 * whose content key exists in offline (shared anchor). If no later shared
 * anchor exists, append.
 *
 * Evidence (019fb6ef…, 0.2.22): "处理好了，你现在尝试" was live-only relative to
 * updates.jsonl and was appended after Push. Correct placement is before the
 * next shared user "你现在尝试".
 */
export function insertLiveOnlyIntoOffline(
  offlineBlocks: readonly SessionBlock[],
  liveBlocks: readonly SessionBlock[],
): SessionBlock[] {
  const offlineKeys = new Set(offlineBlocks.map(blockContentKey));
  const liveOnly = liveBlocks.filter((b) => !offlineKeys.has(blockContentKey(b)));
  if (liveOnly.length === 0) {
    return stabilizeOfflineBlocksWithLive(offlineBlocks, liveBlocks);
  }

  const result = stabilizeOfflineBlocksWithLive(offlineBlocks, liveBlocks);
  const keyIndex = () => {
    const map = new Map<string, number>();
    for (let i = 0; i < result.length; i += 1) {
      const k = blockContentKey(result[i]);
      if (!map.has(k)) map.set(k, i);
    }
    return map;
  };

  // Insert in live order so relative order among live-only clusters is preserved.
  // Process front-to-back; when multiple insert at the same anchor, later ones
  // shift after earlier inserts at that index.
  for (let li = 0; li < liveBlocks.length; li += 1) {
    const block = liveBlocks[li];
    // chat_history preview tools use disk-tool-* ids / kind "other"; updates scan
    // uses real ACP call ids. Treating them as live-only duplicates every tool card.
    if (block.type === "tool" && isSyntheticToolCallId(block.call?.id)) {
      continue;
    }
    const key = blockContentKey(block);
    if (offlineKeys.has(key)) continue;
    // Already inserted (duplicate live-only)?
    if (result.some((b) => blockContentKey(b) === key)) continue;

    let insertAt = result.length;
    for (let j = li + 1; j < liveBlocks.length; j += 1) {
      const nextKey = blockContentKey(liveBlocks[j]);
      if (!offlineKeys.has(nextKey)) continue;
      const idx = keyIndex().get(nextKey);
      if (idx !== undefined) {
        insertAt = idx;
        break;
      }
    }
    result.splice(insertAt, 0, block);
  }
  return result;
}

/**
 * Merge offline disk history with any live-only blocks still on the session.
 *
 * Evidence (spoof 019fb6ef…, installed 0.2.22):
 * 1. get_ui_transcript fingerprint MISS (updates size 339281386 vs 339282532)
 * 2. open painted chat_history preview (correct: 处理好了 → 你现在尝试 → Push)
 * 3. offline scan from updates lacked "处理好了" entirely
 * 4. merge treated it as trailing live-only → appended AFTER Push (~1s flash)
 * 5. corrupt order written to session-cache (i100 你现在尝试, i131 Push, i132 处理好了)
 *
 * Rules (0.2.24):
 * - Idle: offline is chronological spine; stabilize identities from live;
 *   insert live-only before the next shared live→offline anchor (never blind append).
 * - Busy: keep live as-is (scan deferred via pendingOfflineMerge).
 * - Empty live: take offline.
 */
export function mergeOfflineWithLive(pending: Session, cur: Session | undefined): Session {
  const busyStatus = cur && isLiveBusyStatus(cur.status) ? cur.status : null;
  const status = busyStatus ?? ("idle" as const);

  if (!cur || cur.blocks.length === 0) {
    return { ...pending, status };
  }

  // Busy turn: do not rewrite history under the operator.
  if (busyStatus) {
    return {
      ...cur,
      status: busyStatus,
      usage: cur.usage?.outputTokens ? cur.usage : pending.usage,
    };
  }

  // Idle: offline spine + smart live-only insert.
  // If offline is empty/tiny and live is the only paint, keep live.
  if (pending.blocks.length === 0) {
    return { ...cur, status: "idle" };
  }

  // When offline has no overlapping content with live at all and is shorter,
  // live is likely a fresher paint (e.g. brand-new turn) — keep live.
  const pendingKeys = new Set(pending.blocks.map(blockContentKey));
  const overlap = cur.blocks.some((b) => pendingKeys.has(blockContentKey(b)));
  if (!overlap && cur.blocks.length >= pending.blocks.length) {
    return { ...cur, status: "idle" };
  }

  const blocks = insertLiveOnlyIntoOffline(pending.blocks, cur.blocks);
  return {
    ...pending,
    status: "idle",
    blocks,
    usage: cur.usage?.outputTokens ? cur.usage : pending.usage,
  };
}
