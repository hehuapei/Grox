type RpcId = string | number;
type JsonObject = Record<string, unknown>;

export class AcpRpcError extends Error {
  constructor(
    readonly method: string,
    readonly code: number | undefined,
    message: string,
    readonly data?: unknown,
  ) {
    super(`${message} · ${method}`);
    this.name = "AcpRpcError";
  }
}

const object = (value: unknown): JsonObject | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as JsonObject
    : undefined;

const finiteNumber = (value: unknown) =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;

const detailText = (value: unknown): string => {
  if (value instanceof Error) return value.message;
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
};

/** 解释 Host 已经归属完成的单个响应；主动事件不经过这里。 */
export function decodeAcpResponse(
  line: string,
  expectedId: RpcId,
  method: string,
): unknown {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    throw new AcpRpcError(method, undefined, "Grok Build 返回了无法解析的 ACP 响应", line.slice(0, 500));
  }
  const message = object(value);
  if (!message || message.id !== expectedId || message.method !== undefined) {
    throw new AcpRpcError(method, undefined, "Grok Build 返回了无法归属的 ACP 响应", value);
  }
  if (message.error !== undefined) {
    const error = object(message.error);
    throw new AcpRpcError(
      method,
      finiteNumber(error?.code),
      typeof error?.message === "string" ? error.message : `ACP 请求失败：${method}`,
      error?.data,
    );
  }

  const extension = method.startsWith("x.ai/") ? object(message.result) : undefined;
  if (extension && "error" in extension && extension.error != null) {
    const error = object(extension.error);
    throw new AcpRpcError(
      method,
      finiteNumber(error?.code),
      detailText(extension.error),
      extension.error,
    );
  }
  return extension && "result" in extension ? extension.result : message.result;
}
