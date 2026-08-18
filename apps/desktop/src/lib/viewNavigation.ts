export interface ViewNavigationIntent {
  generation: number;
  sessionId: string | null;
  cwd?: string;
}

export function nextViewNavigation(
  current: ViewNavigationIntent,
  sessionId: string | null,
  cwd?: string,
): ViewNavigationIntent {
  return { generation: current.generation + 1, sessionId, ...(cwd ? { cwd } : {}) };
}

/** 异步打开链只有同时匹配代次和目标会话时才能写回视图。 */
export function shouldCommitViewNavigation(
  issued: ViewNavigationIntent,
  current: ViewNavigationIntent,
): boolean {
  return issued.generation === current.generation && issued.sessionId === current.sessionId;
}
