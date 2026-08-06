/**
 * Queue park policy helpers (0.2.20) — pure, testable.
 * Stop / FE timeout park must stay mirrored for UI (queueDrainParked).
 */

/** Apply park/unpark to a reactive Record mirror of suppressNextIdleDrain. */
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
