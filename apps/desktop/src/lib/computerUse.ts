/** localStorage key for operator opt-in to Computer Use (desktop control). */
export const COMPUTER_USE_STORAGE_KEY = "grox.computerUseEnabled";

/** Process env name (desktop host + advanced operators). Mirrors Rust gate. */
export const COMPUTER_USE_ENV_KEY = "GROX_COMPUTER_USE";

/**
 * Parse GROX_COMPUTER_USE-style values (`1` / `true`, case-insensitive).
 * Pure — used by unit tests and host cache application.
 */
export function isComputerUseEnvFlag(value: string | null | undefined): boolean {
  if (value == null) return false;
  const v = value.trim();
  return v === "1" || v.toLowerCase() === "true";
}

/** Host-process env cache (Tauri invoke); null = not yet refreshed. */
let hostEnvEnabled: boolean | null = null;
/** Host-attested native prefs cache (host_prefs.json via Tauri). */
let hostPrefsComputerUse: boolean | null = null;

/** Apply host env probe result (from `computer_use_env_enabled` command). */
export function setComputerUseHostEnvEnabled(enabled: boolean): void {
  hostEnvEnabled = enabled;
}

/** Apply host-attested prefs from `host_prefs_get` (0.2.19). */
export function setComputerUseHostPrefsEnabled(enabled: boolean): void {
  hostPrefsComputerUse = enabled;
  try {
    if (enabled) localStorage.setItem(COMPUTER_USE_STORAGE_KEY, "1");
    else localStorage.removeItem(COMPUTER_USE_STORAGE_KEY);
  } catch {
    /* ignore */
  }
}

/** Test/reset helper — clears host env cache. */
export function resetComputerUseHostEnvCache(): void {
  hostEnvEnabled = null;
  hostPrefsComputerUse = null;
}

function readProcessEnvComputerUse(): string | undefined {
  try {
    // Avoid Node types dependency in the desktop Vite tsconfig; probe globalThis.
    const proc = (globalThis as { process?: { env?: Record<string, string | undefined> } })
      .process;
    return proc?.env?.[COMPUTER_USE_ENV_KEY];
  } catch {
    /* browser */
  }
  return undefined;
}

/**
 * Computer Use operator-facing opt-in (0.2.26).
 *
 * Host-attested prefs are authority once loaded:
 * - host true → enabled
 * - host false → disabled (localStorage alone cannot re-open)
 * - host null (not yet loaded) → fall back to localStorage / env for cold UI
 *
 * Rust product gate still ignores FE entirely (env|host_prefs only).
 */
export function isComputerUseOperatorEnabled(): boolean {
  if (hostPrefsComputerUse === true) return true;
  if (hostPrefsComputerUse === false) {
    // Explicit host opt-out: do not let stale localStorage claim opt-in
    // (would choose "attach" then soft-fail with no MCP / no refuse copy).
    if (hostEnvEnabled === true) return true;
    if (isComputerUseEnvFlag(readProcessEnvComputerUse())) return true;
    return false;
  }
  try {
    if (typeof localStorage !== "undefined") {
      if (localStorage.getItem(COMPUTER_USE_STORAGE_KEY) === "1") return true;
    }
  } catch {
    /* private mode */
  }
  if (hostEnvEnabled === true) return true;
  if (isComputerUseEnvFlag(readProcessEnvComputerUse())) return true;
  return false;
}

/** Soft copy when opt-in is on but MCP/plugin did not attach (Windows only). */
export function computerUseAttachFailedMessage(): string {
  return "Computer Use 未能附加（MCP/插件不可用）。本回合将不控制桌面，可稍后重试。";
}

/**
 * Local mirror only. Prefer `setComputerUseOperatorEnabledHost` from Settings
 * so the native host_prefs.json is updated with confirm dialog.
 */
export function setComputerUseOperatorEnabled(enabled: boolean): void {
  hostPrefsComputerUse = enabled;
  try {
    if (enabled) localStorage.setItem(COMPUTER_USE_STORAGE_KEY, "1");
    else localStorage.removeItem(COMPUTER_USE_STORAGE_KEY);
  } catch {
    /* ignore */
  }
}

/** Shape returned by tauri `computer_session_extensions` (camelCase). */
export type ComputerSessionExtensionsShape = {
  mcpServers: unknown[];
  pluginDirs: string[];
  leaseId: string;
};

/**
 * Only store a lease when MCP/plugin was actually attached.
 * Soft-fail (opt-in off) returns empty lists + empty leaseId — must NOT
 * populate computerLeases, or ensureComputerAttachedForPrompt short-circuits
 * and skips the operator-facing opt-in error / later CU-on attach.
 */
export function computerLeaseIfAttached(
  computer: ComputerSessionExtensionsShape | null | undefined,
): string | null {
  if (!computer) return null;
  const hasMcp = computer.mcpServers.length > 0 || computer.pluginDirs.length > 0;
  if (!hasMcp) return null;
  const lease = computer.leaseId?.trim() ?? "";
  if (!lease) return null;
  return lease;
}

/** True when the session map already holds a real (non-empty) CU lease. */
export function hasActiveComputerLease(
  leases: ReadonlyMap<string, string>,
  sessionId: string,
): boolean {
  const lease = leases.get(sessionId);
  return typeof lease === "string" && lease.length > 0;
}

/**
 * Prompt-time Computer Use attach policy (R4A-CU-01).
 * Opt-in is re-checked even when a lease is already mapped so Settings OFF
 * revokes stale control instead of short-circuiting as "already attached".
 */
export type ComputerAttachDecision =
  | "skip"
  | "already_attached"
  | "refuse_opt_in"
  | "revoke_stale_and_refuse"
  | "attach";

export function decideComputerAttachForPrompt(input: {
  requestsComputer: boolean;
  knownSession: boolean;
  optIn: boolean;
  hasActiveLease: boolean;
}): ComputerAttachDecision {
  if (!input.requestsComputer || !input.knownSession) return "skip";
  if (!input.optIn) {
    return input.hasActiveLease ? "revoke_stale_and_refuse" : "refuse_opt_in";
  }
  if (input.hasActiveLease) return "already_attached";
  return "attach";
}

/** Operator-facing copy when Computer Use is refused (Settings General). */
export function computerUseOptInRefuseMessage(): string {
  return "Computer Use 未启用。请在 设置 中打开 Computer Use 后再试。";
}

/**
 * @deprecated Prefer computerUseOptInRefuseMessage() for locale-aware copy.
 * Kept as a stable substring for equality checks against older bridge soft-errors.
 */
export const COMPUTER_USE_OPT_IN_REFUSE_MESSAGE =
  "Computer Use 未启用。请在 设置 中打开「允许 Computer Use」后再试。";

/**
 * True when a permission tool name is the Grox desktop Computer Use MCP surface.
 * Opt-in already means the operator authorized desktop control — these tools
 * should not re-prompt under DEFAULT permission mode (UX: 勾了仍要批准).
 */
export function isComputerUseMcpTool(name: string | null | undefined): boolean {
  if (!name) return false;
  const n = name.toLowerCase().replace(/-/g, "_");
  // Prefer exact Grox harness prefix — avoid auto-approving unrelated "computer__*" tools.
  return n.startsWith("grok_desktop_computer");
}

/**
 * Best-effort tool name from ACP session/request_permission toolCall payload.
 * Live wire often puts `tool_name` inside rawInput JSON (UseTool variant).
 */
export function computerToolNameFromPermissionTool(tool: {
  title?: unknown;
  kind?: unknown;
  name?: unknown;
  toolName?: unknown;
  rawInput?: unknown;
}): string {
  const direct =
    (typeof tool.toolName === "string" && tool.toolName) ||
    (typeof tool.name === "string" && tool.name) ||
    "";
  if (direct) return direct;
  const raw = tool.rawInput;
  if (typeof raw === "string" && raw.trim()) {
    try {
      const parsed = JSON.parse(raw) as { tool_name?: unknown; name?: unknown };
      if (typeof parsed.tool_name === "string") return parsed.tool_name;
      if (typeof parsed.name === "string") return parsed.name;
    } catch {
      /* not JSON */
    }
    if (/grok_desktop_computer|desktop_computer/i.test(raw)) return raw;
  }
  if (raw && typeof raw === "object") {
    const obj = raw as { tool_name?: unknown; name?: unknown };
    if (typeof obj.tool_name === "string") return obj.tool_name;
    if (typeof obj.name === "string") return obj.name;
  }
  if (typeof tool.title === "string" && /computer/i.test(tool.title)) return tool.title;
  if (typeof tool.kind === "string") return tool.kind;
  return "";
}
