import type { GroxError, GroxErrorDomain, RuntimeNotice } from "../bridge/types";

export interface ErrorFallback {
  domain: GroxErrorDomain;
  code: string;
  message?: string;
  recoverable?: boolean;
  fatal?: boolean;
  holdQueue?: boolean;
  action?: string;
}

/** 在异步边界上携带已分类错误，避免退出/超时再次被误判成普通 RPC 错误。 */
export class GroxFailure extends Error {
  constructor(readonly error: GroxError) {
    super(error.message);
    this.name = "GroxFailure";
  }
}

function errorText(cause: unknown): string {
  if (cause instanceof Error) return cause.message;
  if (typeof cause === "string") return cause;
  try {
    return JSON.stringify(cause);
  } catch {
    return String(cause);
  }
}

function structuredHostError(cause: unknown): GroxError | undefined {
  let value = cause;
  if (typeof value === "string" && value.trim().startsWith("{")) {
    try {
      value = JSON.parse(value);
    } catch {
      return undefined;
    }
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const row = value as Record<string, unknown>;
  const domain = row.domain;
  if (domain !== "protocol" && domain !== "operation" && domain !== "environment") return undefined;
  if (
    typeof row.code !== "string"
    || typeof row.message !== "string"
    || typeof row.recoverable !== "boolean"
    || typeof row.fatal !== "boolean"
    || typeof row.holdQueue !== "boolean"
  ) return undefined;
  return {
    domain,
    code: row.code,
    message: row.message,
    recoverable: row.recoverable,
    fatal: row.fatal,
    holdQueue: row.holdQueue,
    ...(typeof row.action === "string" ? { action: row.action } : {}),
  };
}

function inferredDomain(cause: unknown, fallback: GroxErrorDomain): GroxErrorDomain {
  if (cause instanceof Error && cause.name === "AcpRpcError") return "protocol";
  const message = errorText(cause).toLowerCase();
  if (/agent (?:已)?退出|process exited|child process|acp_send|generation|spawn|enoent|not found.*grok|无法启动|网络|network|econn|认证|登录/.test(message)) {
    return "environment";
  }
  return fallback;
}

export function toGroxError(cause: unknown, fallback: ErrorFallback): GroxError {
  if (cause instanceof GroxFailure) return cause.error;
  const hostError = structuredHostError(cause);
  if (hostError) return hostError;
  const detail = errorText(cause);
  const domain = inferredDomain(cause, fallback.domain);
  return {
    domain,
    code: fallback.code,
    message: fallback.message ?? detail,
    recoverable: fallback.recoverable ?? true,
    fatal: fallback.fatal ?? false,
    holdQueue: fallback.holdQueue ?? fallback.fatal ?? false,
    ...(fallback.action ? { action: fallback.action } : {}),
    ...(detail && detail !== fallback.message ? { detail } : {}),
  };
}

export function groxFailure(error: GroxError): GroxFailure {
  return new GroxFailure(error);
}

export function errorDomainLabel(domain: GroxErrorDomain): string {
  switch (domain) {
    case "protocol":
      return "协议错误";
    case "operation":
      return "操作未完成";
    case "environment":
      return "运行环境错误";
  }
}

export function formatGroxError(error: GroxError): string {
  const action = error.action ? `\n建议：${error.action}` : "";
  return `${errorDomainLabel(error.domain)} · ${error.message}${action}`;
}

export function runtimeNoticeFromError(error: GroxError): RuntimeNotice {
  return {
    id: `error-${error.domain}-${error.code}`,
    level: "error",
    title: errorDomainLabel(error.domain),
    message: error.action ? `${error.message}；${error.action}` : error.message,
  };
}
