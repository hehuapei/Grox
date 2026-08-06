/**
 * Session catalogue merge for sidebar open / setWorkspace / history import.
 *
 * Evidence (0.2.27): project "+" new session called openProject → setWorkspace →
 * listSessions(cwd). Old merge **dropped** same-cwd catalog entries not returned
 * by the CLI. Offline-only missions (visible after "导入 CLI 历史") disappeared
 * until the next full import without cwd filter.
 */

export type CatalogSession = {
  id: string;
  cwd: string;
  updatedAt: number;
  title?: string;
  createdAt?: number;
  model?: string;
  pinned?: boolean;
  archived?: boolean;
};

export function mergeProjectSessionsPure(
  existing: CatalogSession[],
  cwdSame: (a: string, b: string) => boolean,
  cwd: string,
  incoming: CatalogSession[],
  hidden: ReadonlySet<string>,
): CatalogSession[] {
  const filteredIncoming = incoming.filter((m) => !hidden.has(m.id));
  const incomingIds = new Set(filteredIncoming.map((m) => m.id));
  const existingById = new Map(existing.map((m) => [m.id, m]));

  // CLI rows win for shared ids; keep pin/archive from existing when present.
  const preferredIncoming = filteredIncoming.map((m) => {
    const prev = existingById.get(m.id);
    if (!prev) return m;
    return {
      ...m,
      pinned: prev.pinned,
      archived: prev.archived,
    };
  });

  // Keep same-cwd catalog missions the CLI did not return (offline disk history).
  const sameCwdKept = existing.filter(
    (m) => !hidden.has(m.id) && cwdSame(m.cwd, cwd) && !incomingIds.has(m.id),
  );

  // Keep other projects intact.
  const otherCwd = existing.filter(
    (m) => !hidden.has(m.id) && !cwdSame(m.cwd, cwd) && !incomingIds.has(m.id),
  );

  return [...preferredIncoming, ...sameCwdKept, ...otherCwd].sort(
    (a, b) => b.updatedAt - a.updatedAt,
  );
}
