import { invoke } from "@tauri-apps/api/core";
import type { AgentMode, Effort, PermissionMode } from "../bridge/types";

export type AutomationFrequency = "once" | "daily" | "weekdays" | "weekly";

export interface Automation {
  id: string;
  title: string;
  prompt: string;
  cwd: string;
  model: string;
  effort: Effort;
  mode: AgentMode;
  permissionMode: PermissionMode;
  frequency: AutomationFrequency;
  time: string;
  weekday?: number;
  enabled: boolean;
  nextRunAt: number;
  lastRunAt?: number;
  lastSessionId?: string;
  lastError?: string;
}

let nativeWriteChain = Promise.resolve();

function validTime(value: unknown): value is string {
  return typeof value === "string" && /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value);
}

function nextAtTime(after: number, time: string, allowSameDay: boolean): Date {
  const [hour, minute] = time.split(":").map(Number);
  const result = new Date(after);
  result.setSeconds(0, 0);
  result.setHours(hour, minute, 0, 0);
  if (!allowSameDay || result.getTime() <= after) result.setDate(result.getDate() + 1);
  return result;
}

export function nextAutomationRun(
  frequency: AutomationFrequency,
  time: string,
  after = Date.now(),
  weekday?: number,
): number {
  let next = nextAtTime(after, time, true);
  if (frequency === "once" || frequency === "daily") return next.getTime();
  if (frequency === "weekdays") {
    while (next.getDay() === 0 || next.getDay() === 6) next.setDate(next.getDate() + 1);
    return next.getTime();
  }
  const target = Number.isInteger(weekday) ? Math.max(0, Math.min(6, weekday!)) : new Date(after).getDay();
  while (next.getDay() !== target) next.setDate(next.getDate() + 1);
  return next.getTime();
}

export function advanceAutomation(automation: Automation, now = Date.now()): Automation {
  if (automation.frequency === "once") {
    return { ...automation, enabled: false, lastRunAt: now };
  }
  return {
    ...automation,
    lastRunAt: now,
    nextRunAt: nextAutomationRun(automation.frequency, automation.time, now + 1_000, automation.weekday),
  };
}

export function dueAutomations(automations: readonly Automation[], now = Date.now()): Automation[] {
  return automations
    .filter((automation) => automation.enabled && automation.nextRunAt <= now)
    .sort((a, b) => a.nextRunAt - b.nextRunAt);
}

export function parseAutomations(raw: string | null | undefined): Automation[] {
  if (!raw?.trim()) return [];
  let values: unknown;
  try {
    values = JSON.parse(raw) as unknown;
  } catch (error) {
    throw new Error(`自动化文件不是有效 JSON：${error instanceof Error ? error.message : String(error)}`);
  }
  if (!Array.isArray(values)) throw new Error("自动化文件必须是 JSON 数组");
  return values.filter((value): value is Automation => {
    if (!value || typeof value !== "object") return false;
    const item = value as Partial<Automation>;
    return typeof item.id === "string"
      && typeof item.title === "string"
      && typeof item.prompt === "string"
      && typeof item.cwd === "string"
      && typeof item.model === "string"
      && ["low", "medium", "high", "xhigh", "max"].includes(String(item.effort))
      && ["agent", "plan", "ask"].includes(String(item.mode))
      && ["default", "auto", "bypass"].includes(String(item.permissionMode))
      && ["once", "daily", "weekdays", "weekly"].includes(String(item.frequency))
      && validTime(item.time)
      && typeof item.enabled === "boolean"
      && typeof item.nextRunAt === "number";
  });
}

export async function loadAutomations(): Promise<Automation[]> {
  if (!("__TAURI_INTERNALS__" in window)) {
    try {
      return parseAutomations(localStorage.getItem("grox.automations.v1"));
    } catch {
      return [];
    }
  }
  return parseAutomations(await invoke<string | null>("read_automations"));
}

export async function persistAutomations(automations: readonly Automation[]): Promise<void> {
  const content = JSON.stringify(automations);
  if (!("__TAURI_INTERNALS__" in window)) {
    localStorage.setItem("grox.automations.v1", content);
    return;
  }
  // 快速启停或删除时保持提交顺序，较早的慢写不能覆盖最新排程。
  nativeWriteChain = nativeWriteChain.catch(() => {}).then(() => (
    invoke("write_automations", { content })
  ));
  await nativeWriteChain;
}
