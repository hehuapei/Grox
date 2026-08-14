import { describe, expect, it } from "vitest";
import { AcpBridge } from "./AcpBridge";
import type { AutomationSessionStarted, BridgeEvent } from "./types";

interface HostInteraction {
  blockId: string;
  sessionId: string;
  kind: "permission" | "plan" | "question";
  params: unknown;
}

interface InteractionInternals {
  projectHostInteraction(interaction: HostInteraction): void;
  reconcileHostInteractions(interactions: HostInteraction[]): void;
  onLine(line: string): void;
  sendRaw(message: unknown): Promise<void>;
  projectAutomationSessionStarted(started: AutomationSessionStarted): void;
}

function bridgeHarness() {
  const bridge = new AcpBridge();
  const events: BridgeEvent[] = [];
  bridge.subscribe((event) => events.push(event));
  return {
    events,
    internal: bridge as unknown as InteractionInternals,
  };
}

describe("AcpBridge Host interaction projection", () => {
  it("projects an opaque Host block id without retaining the wire rpc id", () => {
    const { events, internal } = bridgeHarness();
    const interaction: HostInteraction = {
      blockId: "interaction-7-1",
      sessionId: "session-a",
      kind: "permission",
      params: {
        sessionId: "session-a",
        toolCall: { toolCallId: "tool-1", title: "Run tests", kind: "execute" },
        options: [
          { kind: "allow_once" },
          { kind: "reject_once" },
        ],
      },
    };

    internal.projectHostInteraction(interaction);
    internal.projectHostInteraction(interaction);

    const projected = events.filter(
      (event): event is Extract<BridgeEvent, { type: "permission_request" }> =>
        event.type === "permission_request",
    );
    expect(projected).toHaveLength(1);
    expect(projected[0].blockId).toBe("interaction-7-1");
    expect(projected[0].req.id).toBe("interaction-7-1");
    expect(projected[0].req.options).toEqual(["allow_once", "deny"]);
  });

  it("invalidates only snapshots that disappeared from Host state", () => {
    const { events, internal } = bridgeHarness();
    const first: HostInteraction = {
      blockId: "interaction-3-1",
      sessionId: "session-a",
      kind: "question",
      params: {
        sessionId: "session-a",
        toolCallId: "ask-1",
        questions: [{ question: "Choose", options: [], multiSelect: false }],
      },
    };
    const second: HostInteraction = {
      blockId: "interaction-3-2",
      sessionId: "session-b",
      kind: "plan",
      params: { sessionId: "session-b", toolCallId: "plan-1", planContent: "Plan" },
    };
    internal.projectHostInteraction(first);
    internal.projectHostInteraction(second);

    events.length = 0;
    internal.reconcileHostInteractions([second]);

    expect(events).toEqual([
      {
        type: "question_resolved",
        sessionId: "session-a",
        blockId: "interaction-3-1",
        response: { outcome: "cancelled" },
      },
    ]);
  });

  it("never answers a file callback after it bypasses Host ownership", () => {
    const { events, internal } = bridgeHarness();
    let replied = false;
    internal.sendRaw = async () => { replied = true; };
    internal.onLine(JSON.stringify({
      jsonrpc: "2.0",
      id: 11,
      method: "_x.ai/fs/read_file",
      params: { sessionId: "session-a", path: "/tmp/a.txt" },
    }));

    const notice = events.find(
      (event): event is Extract<BridgeEvent, { type: "runtime_notice" }> =>
        event.type === "runtime_notice",
    );
    expect(notice?.notice.id).toBe("error-protocol-CLIENT_CALLBACK_HOST_BYPASSED");
    expect(replied).toBe(false);
  });

  it("projects a Host-created automation session without asking WebView to create it", () => {
    const { events, internal } = bridgeHarness();
    internal.projectAutomationSessionStarted({
      automationId: "auto-1",
      source: "scheduled",
      claimedAt: 42,
      sessionId: "session-host-1",
      warnings: [],
      automation: {
        id: "auto-1",
        title: "Nightly review",
        prompt: "Review the repository",
        cwd: "/tmp/repo",
        model: "grok-build",
        effort: "high",
        mode: "agent",
        permissionMode: "auto",
        frequency: "daily",
        time: "09:30",
        enabled: true,
        nextRunAt: 100,
      },
    });

    const ready = events.find(
      (event): event is Extract<BridgeEvent, { type: "session_ready" }> =>
        event.type === "session_ready",
    );
    expect(ready?.background).toBe(true);
    expect(ready?.session).toMatchObject({
      id: "session-host-1",
      title: "Nightly review",
      status: "running",
      blocks: [{ type: "user", text: "Review the repository" }],
    });
  });
});
