/** Pure helpers for prompt-queue merge / drain (unit-testable). */

export type QueueEntryLike = {
  id: string;
  text?: string;
  state: "queued" | "interjected" | "sending";
  source?: "local" | "cli";
  /** Visible placeholder after concurrent enqueue was accepted by CLI. */
  heldByCli?: boolean;
};

/** Normalize operator text for ghost / duplicate matching. */
export function normalizeQueueText(text: string | undefined | null): string {
  return (text ?? "").trim().replace(/\s+/g, " ");
}

/**
 * Merge CLI-authoritative queue with local-only entries the CLI has not yet
 * acknowledged. Prevents x.ai/queue/changed from wiping in-flight local
 * enqueues (race: FE adds local → CLI snapshot arrives before our promptId).
 *
 * Same-id CLI echoes must not clobber `heldByCli` wait rows (operator sticky receipt).
 */
export function mergeCliQueueWithLocal<T extends QueueEntryLike>(
  cliEntries: T[],
  previous: T[],
): T[] {
  const heldById = new Map(
    previous.filter((item) => item.heldByCli).map((item) => [item.id, item] as const),
  );
  const mergedCli = cliEntries.map((cli) => {
    const held = heldById.get(cli.id);
    if (!held) return cli;
    return {
      ...cli,
      text: cli.text || held.text,
      // Keep local ownership + held flag so busy UI still shows "waiting for turn".
      source: "local" as const,
      state: held.state === "sending" ? ("sending" as const) : cli.state,
      heldByCli: true as const,
    };
  });
  const cliIds = new Set(cliEntries.map((item) => item.id));
  const localOnly = previous.filter(
    (item) => item.source !== "cli" && !cliIds.has(item.id),
  );
  const interjectedLocal = localOnly.filter((item) => item.state === "interjected");
  const otherLocal = localOnly.filter((item) => item.state !== "interjected");
  // Interjected locals first (drain priority), then CLI order, then other locals.
  return [...interjectedLocal, ...mergedCli, ...otherLocal];
}

/**
 * Index of the next *local* entry to drain when the session is idle.
 * Array order is authoritative (matches drag-reorder). Interject actions pin
 * to the head when created; later drag can demote them.
 */
export function nextLocalDrainIndex(queue: readonly QueueEntryLike[]): number {
  return queue.findIndex(
    (item) => item.source !== "cli" && item.state !== "sending" && !item.heldByCli,
  );
}

/** Drop rows whose text matches the live turn's primary user bubble. */
export function filterQueueGhostsByLiveText<T extends { text?: string }>(
  queue: readonly T[],
  liveUserText: string | null | undefined,
): T[] {
  const live = normalizeQueueText(liveUserText);
  if (!live || queue.length === 0) return [...queue];
  return queue.filter((item) => normalizeQueueText(item.text) !== live);
}

/**
 * Drop rows whose text matches any user bubble in the live turn
 * (primary + mid-turn interjections).
 */
export function filterQueueGhostsByLiveTexts<T extends { text?: string }>(
  queue: readonly T[],
  liveUserTexts: readonly string[],
): T[] {
  if (queue.length === 0 || liveUserTexts.length === 0) return [...queue];
  const live = new Set(liveUserTexts.map((t) => normalizeQueueText(t)).filter(Boolean));
  if (live.size === 0) return [...queue];
  return queue.filter((item) => !live.has(normalizeQueueText(item.text)));
}

/**
 * Drop rows already written via concurrent session/prompt (CLI may still echo
 * them in x.ai/queue/changed — that is a ghost 已入队, not a waiting follow-up).
 */
export function filterConsumedQueueEntries<T extends { id: string; text?: string }>(
  queue: readonly T[],
  consumedIds: ReadonlySet<string> | undefined | null,
  consumedTexts?: ReadonlySet<string> | undefined | null,
): T[] {
  if (queue.length === 0) return [...queue];
  const hasIds = Boolean(consumedIds && consumedIds.size > 0);
  const hasTexts = Boolean(consumedTexts && consumedTexts.size > 0);
  if (!hasIds && !hasTexts) return [...queue];
  return queue.filter((item) => {
    if (hasIds && consumedIds!.has(item.id)) return false;
    if (hasTexts) {
      const t = normalizeQueueText(item.text);
      if (t && consumedTexts!.has(t)) return false;
    }
    return true;
  });
}

/**
 * Operator-visible queue while a turn is live.
 * - Hide pure CLI echoes (source=cli without a held local placeholder).
 * - Keep heldByCli rows (operator-facing "waiting for turn end").
 * - Hide other consumed ghosts by id/text, but never strip heldByCli placeholders.
 */
export function filterBusyTurnQueueEntries<T extends QueueEntryLike & { text?: string }>(
  queue: readonly T[],
  opts: {
    consumedIds?: ReadonlySet<string> | null;
    consumedTexts?: ReadonlySet<string> | null;
  } = {},
): T[] {
  const visible = queue.filter(
    (item) => item.source !== "cli" || item.heldByCli === true,
  );
  return visible.filter((item) => {
    if (item.heldByCli) return true;
    return filterConsumedQueueEntries([item], opts.consumedIds, opts.consumedTexts).length > 0;
  });
}

/** Drop CLI-held placeholders once the session is idle (CLI already ran them). */
export function stripHeldByCliEntries<T extends QueueEntryLike>(queue: readonly T[]): T[] {
  return queue.filter((item) => !item.heldByCli);
}

/**
 * Healthy idle settle (UI: "等待当前回合结束后发送").
 *
 * - Pure CLI ghosts → drop.
 * - heldByCli whose text already appears as a user bubble → drop (concurrent ran).
 * - heldByCli **not** in transcript → rehome to local `queued` so drain can send.
 *   (Wire accept ≠ UI delivery; blind strip lost follow-ups when CLI never painted user.)
 * - Other local rows → keep.
 */
export function settleQueueOnIdle<T extends QueueEntryLike & { text?: string }>(
  queue: readonly T[],
  transcriptUserTexts: readonly string[],
): T[] {
  const seen = new Set(
    transcriptUserTexts.map((t) => normalizeQueueText(t)).filter(Boolean),
  );
  const out: T[] = [];
  for (const item of queue) {
    if (item.source === "cli" && !item.heldByCli) continue;
    if (item.heldByCli) {
      const t = normalizeQueueText(item.text);
      if (t && seen.has(t)) continue;
      out.push({
        ...item,
        source: "local" as const,
        heldByCli: false as const,
        state: "queued" as const,
      });
      continue;
    }
    out.push(item);
  }
  return out;
}

/**
 * Agent fault / hard error recovery: keep operator text, clear heldByCli so drain
 * can re-send. Unlike stripHeldByCliEntries, does **not** delete held rows
 * (dead child may never have run them). Drops pure CLI ghosts only.
 */
export function rehomeHeldQueueForRecovery<T extends QueueEntryLike>(
  queue: readonly T[],
): T[] {
  return queue
    .filter((item) => item.source !== "cli" || item.heldByCli === true)
    .map((entry) => ({
      ...entry,
      source: "local" as const,
      heldByCli: false as const,
      state:
        entry.state === "sending" ||
        entry.state === "interjected" ||
        entry.heldByCli
          ? ("queued" as const)
          : entry.state,
    }));
}

/** When the session is idle, CLI-owned rows are stale ghosts — keep only local. */
export function stripCliOwnedEntries<T extends QueueEntryLike>(queue: readonly T[]): T[] {
  return queue.filter((item) => item.source !== "cli");
}

/**
 * True if the queue already holds the same operator text (prevents double-Enter
 * stacking identical follow-ups while busy).
 */
export function queueHasSameText(
  queue: readonly { text?: string }[],
  text: string,
): boolean {
  const needle = normalizeQueueText(text);
  if (!needle) return false;
  return queue.some((item) => normalizeQueueText(item.text) === needle);
}
