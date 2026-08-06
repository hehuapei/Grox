import { afterEach, describe, expect, it } from "vitest";
import {
  COMPUTER_USE_ENV_KEY,
  COMPUTER_USE_OPT_IN_REFUSE_MESSAGE,
  COMPUTER_USE_STORAGE_KEY,
  computerLeaseIfAttached,
  computerToolNameFromPermissionTool,
  computerUseOptInRefuseMessage,
  decideComputerAttachForPrompt,
  hasActiveComputerLease,
  isComputerUseEnvFlag,
  isComputerUseMcpTool,
  isComputerUseOperatorEnabled,
  resetComputerUseHostEnvCache,
  setComputerUseHostEnvEnabled,
  setComputerUseHostPrefsEnabled,
  setComputerUseOperatorEnabled,
} from "./computerUse";

function envBag(): Record<string, string | undefined> {
  type Proc = { process?: { env?: Record<string, string | undefined> } };
  const g = globalThis as unknown as Proc;
  if (!g.process?.env) {
    g.process = { env: { ...(g.process?.env ?? {}) } };
  }
  return g.process.env as Record<string, string | undefined>;
}

describe("computerUse opt-in", () => {
  afterEach(() => {
    localStorage.removeItem(COMPUTER_USE_STORAGE_KEY);
    resetComputerUseHostEnvCache();
    delete envBag()[COMPUTER_USE_ENV_KEY];
  });

  it("defaults to disabled", () => {
    localStorage.removeItem(COMPUTER_USE_STORAGE_KEY);
    resetComputerUseHostEnvCache();
    delete envBag()[COMPUTER_USE_ENV_KEY];
    expect(isComputerUseOperatorEnabled()).toBe(false);
  });

  it("enables and disables via setter", () => {
    setComputerUseOperatorEnabled(true);
    expect(localStorage.getItem(COMPUTER_USE_STORAGE_KEY)).toBe("1");
    expect(isComputerUseOperatorEnabled()).toBe(true);
    setComputerUseOperatorEnabled(false);
    expect(isComputerUseOperatorEnabled()).toBe(false);
  });

  it("refuses computer attach when opt-in is off (shipped helper)", () => {
    setComputerUseOperatorEnabled(false);
    // attach path gates on this helper — must be false by default.
    expect(isComputerUseOperatorEnabled()).toBe(false);
  });

  it("honors process env GROX_COMPUTER_USE (R4A-CU-03)", () => {
    setComputerUseOperatorEnabled(false);
    envBag()[COMPUTER_USE_ENV_KEY] = "1";
    expect(isComputerUseOperatorEnabled()).toBe(true);
    envBag()[COMPUTER_USE_ENV_KEY] = "true";
    expect(isComputerUseOperatorEnabled()).toBe(true);
    envBag()[COMPUTER_USE_ENV_KEY] = "0";
    expect(isComputerUseOperatorEnabled()).toBe(false);
  });

  it("honors host env cache from Tauri probe", () => {
    setComputerUseOperatorEnabled(false);
    delete envBag()[COMPUTER_USE_ENV_KEY];
    setComputerUseHostEnvEnabled(true);
    expect(isComputerUseOperatorEnabled()).toBe(true);
    setComputerUseHostEnvEnabled(false);
    expect(isComputerUseOperatorEnabled()).toBe(false);
  });

  it("computerLeaseIfAttached accepts mcp server without Authorization headers (0.2.29)", () => {
    // Host injects Bearer on acp_send; FE only needs non-empty mcpServers + lease.
    expect(
      computerLeaseIfAttached({
        mcpServers: [{ type: "http", name: "grok_desktop_computer", url: "http://127.0.0.1:1/mcp" }],
        pluginDirs: ["C:\\plugin"],
        leaseId: "abcd",
      }),
    ).toBe("abcd");
  });

  it("host prefs false blocks stale localStorage opt-in (0.2.26)", () => {
    localStorage.setItem(COMPUTER_USE_STORAGE_KEY, "1");
    setComputerUseHostPrefsEnabled(false);
    delete envBag()[COMPUTER_USE_ENV_KEY];
    setComputerUseHostEnvEnabled(false);
    expect(isComputerUseOperatorEnabled()).toBe(false);
    // Host true wins.
    setComputerUseHostPrefsEnabled(true);
    expect(isComputerUseOperatorEnabled()).toBe(true);
  });

  it("parses env flag shapes", () => {
    expect(isComputerUseEnvFlag("1")).toBe(true);
    expect(isComputerUseEnvFlag("TRUE")).toBe(true);
    expect(isComputerUseEnvFlag(" true ")).toBe(true);
    expect(isComputerUseEnvFlag("0")).toBe(false);
    expect(isComputerUseEnvFlag("")).toBe(false);
    expect(isComputerUseEnvFlag(null)).toBe(false);
  });
});

describe("computerLeaseIfAttached (soft-fail CU)", () => {
  it("returns null for soft-fail empty MCP (must not populate computerLeases)", () => {
    // Mirrors Rust computer_session_extensions when gate closed.
    expect(
      computerLeaseIfAttached({
        mcpServers: [],
        pluginDirs: [],
        leaseId: "",
      }),
    ).toBeNull();
  });

  it("returns null when computer is null/undefined", () => {
    expect(computerLeaseIfAttached(null)).toBeNull();
    expect(computerLeaseIfAttached(undefined)).toBeNull();
  });

  it("returns null when lists non-empty but leaseId empty (incomplete attach)", () => {
    expect(
      computerLeaseIfAttached({
        mcpServers: [{ type: "http" }],
        pluginDirs: [],
        leaseId: "",
      }),
    ).toBeNull();
    expect(
      computerLeaseIfAttached({
        mcpServers: [],
        pluginDirs: ["/plugins/cu"],
        leaseId: "   ",
      }),
    ).toBeNull();
  });

  it("returns leaseId only when MCP/plugin attached with real lease", () => {
    expect(
      computerLeaseIfAttached({
        mcpServers: [{ type: "http", name: "grok_desktop_computer" }],
        pluginDirs: [],
        leaseId: "abc123",
      }),
    ).toBe("abc123");
    expect(
      computerLeaseIfAttached({
        mcpServers: [],
        pluginDirs: ["C:\\plugin"],
        leaseId: "def456",
      }),
    ).toBe("def456");
  });

  it("hasActiveComputerLease ignores empty-string map entries", () => {
    const leases = new Map<string, string>([
      ["sess-empty", ""],
      ["sess-real", "lease-ok"],
    ]);
    expect(hasActiveComputerLease(leases, "sess-empty")).toBe(false);
    expect(hasActiveComputerLease(leases, "sess-missing")).toBe(false);
    expect(hasActiveComputerLease(leases, "sess-real")).toBe(true);
  });
});

describe("decideComputerAttachForPrompt (R4A-CU-01)", () => {
  const base = {
    requestsComputer: true,
    knownSession: true,
    optIn: true,
    hasActiveLease: false,
  };

  it("skips when no computer intent or unknown session", () => {
    expect(
      decideComputerAttachForPrompt({ ...base, requestsComputer: false }),
    ).toBe("skip");
    expect(decideComputerAttachForPrompt({ ...base, knownSession: false })).toBe(
      "skip",
    );
  });

  it("refuses opt-in without lease", () => {
    expect(decideComputerAttachForPrompt({ ...base, optIn: false })).toBe(
      "refuse_opt_in",
    );
  });

  it("revokes stale lease when opt-in off (disable-after-attach)", () => {
    // Ship path: Settings OFF after prior attach must not return already_attached.
    expect(
      decideComputerAttachForPrompt({
        ...base,
        optIn: false,
        hasActiveLease: true,
      }),
    ).toBe("revoke_stale_and_refuse");
  });

  it("keeps already_attached only while opt-in still on", () => {
    expect(
      decideComputerAttachForPrompt({
        ...base,
        optIn: true,
        hasActiveLease: true,
      }),
    ).toBe("already_attached");
  });

  it("attaches when opt-in on and no lease yet", () => {
    expect(decideComputerAttachForPrompt(base)).toBe("attach");
  });

  it("exports refuse message for UI parity", () => {
    expect(COMPUTER_USE_OPT_IN_REFUSE_MESSAGE).toMatch(/Computer Use/);
    expect(COMPUTER_USE_OPT_IN_REFUSE_MESSAGE).toMatch(/设置/);
    expect(computerUseOptInRefuseMessage()).toMatch(/Computer Use/);
  });
});

describe("computer MCP tool permission auto-allow helpers", () => {
  it("recognizes grok_desktop_computer tool names from live payload", () => {
    expect(isComputerUseMcpTool("grok_desktop_computer__list_apps")).toBe(true);
    expect(isComputerUseMcpTool("grok_desktop_computer__start")).toBe(true);
    expect(isComputerUseMcpTool("bash")).toBe(false);
    expect(isComputerUseMcpTool("read_file")).toBe(false);
    expect(isComputerUseMcpTool("computer__evil")).toBe(false);
  });

  it("extracts tool_name from UseTool rawInput JSON", () => {
    const name = computerToolNameFromPermissionTool({
      title: "other",
      rawInput: JSON.stringify({
        variant: "UseTool",
        tool_name: "grok_desktop_computer__list_apps",
        tool_input: {},
      }),
    });
    expect(name).toBe("grok_desktop_computer__list_apps");
    expect(isComputerUseMcpTool(name)).toBe(true);
  });
});
