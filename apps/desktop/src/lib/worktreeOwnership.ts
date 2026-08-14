import { samePath } from "./projectCatalog";

export type WorktreeRemovalBlocker =
  | { kind: "current_workspace" }
  | { kind: "references"; sessions: number; automations: number };

/** 已被工作区、会话或自动化引用的目录不能被删除，否则会留下无法恢复的悬空记录。 */
export function worktreeRemovalBlocker(
  target: string,
  currentWorkspace: string,
  sessionCwds: readonly string[],
  automationCwds: readonly string[],
): WorktreeRemovalBlocker | null {
  if (samePath(target, currentWorkspace)) return { kind: "current_workspace" };
  const sessions = sessionCwds.filter((cwd) => samePath(target, cwd)).length;
  const automations = automationCwds.filter((cwd) => samePath(target, cwd)).length;
  return sessions > 0 || automations > 0 ? { kind: "references", sessions, automations } : null;
}
