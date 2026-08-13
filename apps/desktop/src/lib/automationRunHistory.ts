export type AutomationRunOutcome = "starting" | "started" | "skipped" | "error" | "unknown";
export type AutomationRunSource = "scheduled" | "run_now";

export interface AutomationRunRecord {
  id: string;
  automationId: string;
  title: string;
  at: number;
  outcome: AutomationRunOutcome;
  source: AutomationRunSource;
  sessionId?: string;
  detail?: string;
}

const STORAGE_KEY = "grox.automationRunHistory.v1";
const MAX_RECORDS = 50;
const INTERRUPTED_AFTER_MS = 2 * 60_000;

function cleanText(value: unknown, max: number): string {
  if (typeof value !== "string") return "";
  return value.replace(/[\u0000-\u001f]/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
}

export function redactAutomationDetail(value: unknown): string {
  const text = value instanceof Error ? value.message : String(value ?? "");
  return cleanText(text, 560)
    .replace(/\b(Bearer\s+)[^\s]+/gi, "$1********")
    .replace(/\b(?:sk|g2a|xai|tvly|fc)[-_][A-Za-z0-9_-]{12,}\b/gi, "********")
    .slice(0, 280);
}

function parseRecord(value: unknown): AutomationRunRecord | null {
  if (!value || typeof value !== "object") return null;
  const row = value as Partial<AutomationRunRecord>;
  if (
    typeof row.id !== "string"
    || typeof row.automationId !== "string"
    || typeof row.title !== "string"
    || typeof row.at !== "number"
    || !["starting", "started", "skipped", "error", "unknown"].includes(String(row.outcome))
    || !["scheduled", "run_now"].includes(String(row.source))
  ) return null;
  return {
    id: cleanText(row.id, 120),
    automationId: cleanText(row.automationId, 120),
    title: cleanText(row.title, 160),
    at: row.at,
    outcome: row.outcome as AutomationRunOutcome,
    source: row.source as AutomationRunSource,
    ...(row.sessionId ? { sessionId: cleanText(row.sessionId, 128) } : {}),
    ...(row.detail ? { detail: redactAutomationDetail(row.detail) } : {}),
  };
}

export function parseAutomationRunHistory(value: unknown): AutomationRunRecord[] {
  let rows = value;
  if (typeof value === "string") {
    try {
      rows = JSON.parse(value) as unknown;
    } catch {
      return [];
    }
  }
  if (!Array.isArray(rows)) return [];
  return rows.map(parseRecord).filter((row): row is AutomationRunRecord => Boolean(row)).slice(0, MAX_RECORDS);
}

export function recoverInterruptedAutomationRuns(
  history: readonly AutomationRunRecord[],
  now = Date.now(),
): AutomationRunRecord[] {
  return history.map((row) => row.outcome === "starting" && now - row.at >= INTERRUPTED_AFTER_MS
    ? {
        ...row,
        outcome: "unknown",
        detail: "应用在任务启动确认前退出；为避免重复执行，本次不会自动重放。",
      }
    : row);
}

export function prependAutomationRun(
  history: readonly AutomationRunRecord[],
  record: AutomationRunRecord,
): AutomationRunRecord[] {
  return [record, ...history.filter((row) => row.id !== record.id)].slice(0, MAX_RECORDS);
}

export function patchAutomationRun(
  history: readonly AutomationRunRecord[],
  id: string,
  patch: Partial<Pick<AutomationRunRecord, "outcome" | "sessionId" | "detail">>,
): AutomationRunRecord[] {
  return history.map((row) => row.id === id
    ? {
        ...row,
        ...patch,
        ...(patch.detail !== undefined ? { detail: redactAutomationDetail(patch.detail) } : {}),
      }
    : row);
}

export function failLatestAutomationSessionRun(
  history: readonly AutomationRunRecord[],
  sessionId: string,
  detail: string,
): AutomationRunRecord[] {
  let patched = false;
  return history.map((row) => {
    if (patched || row.sessionId !== sessionId || !["starting", "started"].includes(row.outcome)) return row;
    patched = true;
    return { ...row, outcome: "error", detail: redactAutomationDetail(detail) };
  });
}

export function loadAutomationRunHistory(): AutomationRunRecord[] {
  try {
    return recoverInterruptedAutomationRuns(parseAutomationRunHistory(localStorage.getItem(STORAGE_KEY)));
  } catch {
    return [];
  }
}

export function persistAutomationRunHistory(history: readonly AutomationRunRecord[]): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(history.slice(0, MAX_RECORDS)));
}

export function newAutomationRunId(now = Date.now()): string {
  return `automation-run-${now}-${crypto.randomUUID?.() ?? Math.random().toString(36).slice(2)}`;
}
