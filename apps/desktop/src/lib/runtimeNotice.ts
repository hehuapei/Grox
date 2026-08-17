import type { RuntimeNotice } from "../bridge/types";

type UnknownRecord = Record<string, unknown>;

function cleanVersion(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const clean = value.replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, 80);
  return clean || undefined;
}

export function versionMismatchNotice(value: unknown): RuntimeNotice | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const params = value as UnknownRecord;
  const client = cleanVersion(params.clientVersion);
  const leader = cleanVersion(params.leaderVersion);
  if (!client || !leader) return undefined;
  return {
    id: `leader-version-mismatch:${client}:${leader}`,
    level: "warning",
    title: "Grok 运行时版本不一致",
    message: `当前客户端 ${client}，后台 Leader ${leader}。请重启 Grox，使会话使用同一版本。`,
  };
}

function toolMetadata(value: unknown): UnknownRecord | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const update = value as UnknownRecord;
  const meta = update._meta;
  if (!meta || typeof meta !== "object" || Array.isArray(meta)) return undefined;
  const tool = (meta as UnknownRecord)["x.ai/tool"];
  if (!tool || typeof tool !== "object" || Array.isArray(tool)) return undefined;
  return tool as UnknownRecord;
}

export function toolCanonicalKind(value: unknown): string | undefined {
  const kind = toolMetadata(value)?.kind;
  return typeof kind === "string" && kind.trim() ? kind.trim() : undefined;
}

export function toolReadOnly(value: unknown): boolean | undefined {
  const readOnly = toolMetadata(value)?.read_only;
  return typeof readOnly === "boolean" ? readOnly : undefined;
}

export function cleanApiError(value: unknown): string {
  if (value instanceof Error) return value.message;
  if (typeof value === "string") {
    const trimmed = value.trim();
    if ((trimmed.startsWith("{") || trimmed.startsWith("[")) && trimmed.length < 100_000) {
      try { return cleanApiError(JSON.parse(trimmed)); } catch { /* ordinary text */ }
    }
    return trimmed;
  }
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const object = value as UnknownRecord;
    for (const candidate of [object.message, object.error, object.detail, object.data]) {
      if (candidate == null) continue;
      const message = cleanApiError(candidate);
      if (message && message !== "[object Object]") return message;
    }
    for (const [label, candidate] of [["code", object.code], ["status", object.status], ["name", object.name]] as const) {
      if (typeof candidate === "string" && candidate.trim()) return `${label}: ${candidate.trim()}`;
      if (typeof candidate === "number" && Number.isFinite(candidate)) return `${label}: ${candidate}`;
    }
    return "未知错误";
  }
  return value == null ? "未知错误" : String(value);
}
