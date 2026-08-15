import { describe, expect, it } from "vitest";
import { AcpBridge } from "./AcpBridge";
import type { AutomationSessionStarted, BridgeEvent } from "./types";

interface HostInteraction {
  blockId: string;
  sessionId: string;
  kind: "permission" | "plan" | "question";
  params: unknown;
}

interface HostSessionEvent {
  streamId: string;
  sequence: number;
  generation: number;
  receivedAt: number;
  sessionId?: string;
  method?: string;
  updateType?: string;
  projection:
    | { kind: "session_update"; channel: "session" | "notification"; sessionId: string; updateType?: string; update: unknown; blockOps: HostBlockOperation[] }
    | { kind: "block_lifecycle"; sessionId: string; phase: "turn_started" | "turn_finished" | "session_reset" | "session_removed"; blockOps: HostBlockOperation[] }
    | { kind: "notification"; method: string; params: unknown }
    | { kind: "unsupported_request"; method: string }
    | { kind: "orphan_response" }
    | { kind: "protocol_error"; code: string; message: string };
}

interface HostBlockOperation {
  action: "open" | "update" | "close";
  blockType: "user" | "assistant" | "thinking" | "tool" | "plan";
  blockId: string;
  sourceId?: string;
  startedAt?: number;
}

interface HostActiveBlockSnapshot {
  generation: number;
  sessionId: string;
  blockType: "user" | "assistant" | "thinking";
  blockId: string;
  startedAt: number;
  text: string;
  textComplete: boolean;
}

interface InteractionInternals {
  projectHostInteraction(interaction: HostInteraction): void;
  reconcileHostInteractions(interactions: HostInteraction[]): void;
  projectAutomationSessionStarted(started: AutomationSessionStarted): void;
  projectHostSessionEvent(event: HostSessionEvent): void;
  projectHostActiveBlockSnapshots(snapshots: HostActiveBlockSnapshot[]): void;
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
    internal.projectHostSessionEvent({
      streamId: "host-stream-callback",
      sequence: 1,
      generation: 7,
      receivedAt: 42,
      sessionId: "session-a",
      method: "x.ai/fs/read_file",
      projection: { kind: "unsupported_request", method: "x.ai/fs/read_file" },
    });

    const notice = events.find(
      (event): event is Extract<BridgeEvent, { type: "runtime_notice" }> =>
        event.type === "runtime_notice",
    );
    expect(notice?.notice.id).toBe("error-protocol-CLIENT_CALLBACK_HOST_BYPASSED");
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

  it("deduplicates replayed Host events by stream cursor", () => {
    localStorage.removeItem("grox.hostSessionEventCursor.v1");
    const { events, internal } = bridgeHarness();
    const event: HostSessionEvent = {
      streamId: "host-stream-a",
      sequence: 1,
      generation: 7,
      receivedAt: 42,
      sessionId: "session-a",
      method: "session/update",
      updateType: "agent_message_chunk",
      projection: {
        kind: "session_update",
        channel: "session",
        sessionId: "session-a",
        updateType: "agent_message_chunk",
        update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "hello" } },
        blockOps: [{
          action: "open",
          blockType: "assistant",
          blockId: "host-block-replay-1",
          startedAt: 42,
        }],
      },
    };

    internal.projectHostSessionEvent(event);
    internal.projectHostSessionEvent(event);

    expect(events.filter((entry) => entry.type === "block_add")).toHaveLength(1);
    expect(JSON.parse(localStorage.getItem("grox.hostSessionEventCursor.v1") ?? "null")).toEqual({
      streamId: "host-stream-a",
      sequence: 1,
    });
  });

  it("uses Host block identity and lifecycle closes across stream phases", () => {
    localStorage.removeItem("grox.hostSessionEventCursor.v1");
    const { events, internal } = bridgeHarness();
    internal.projectHostSessionEvent({
      streamId: "host-stream-blocks",
      sequence: 1,
      generation: 7,
      receivedAt: 42,
      sessionId: "session-a",
      projection: {
        kind: "session_update",
        channel: "session",
        sessionId: "session-a",
        updateType: "agent_message_chunk",
        update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "hello" } },
        blockOps: [{
          action: "open",
          blockType: "assistant",
          blockId: "host-block-assistant-1",
          startedAt: 42,
        }],
      },
    });
    internal.projectHostSessionEvent({
      streamId: "host-stream-blocks",
      sequence: 2,
      generation: 7,
      receivedAt: 43,
      sessionId: "session-a",
      projection: {
        kind: "session_update",
        channel: "session",
        sessionId: "session-a",
        updateType: "agent_thought_chunk",
        update: { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "why" } },
        blockOps: [
          { action: "close", blockType: "assistant", blockId: "host-block-assistant-1", startedAt: 42 },
          { action: "open", blockType: "thinking", blockId: "host-block-thinking-2", startedAt: 43 },
        ],
      },
    });
    internal.projectHostSessionEvent({
      streamId: "host-stream-blocks",
      sequence: 3,
      generation: 7,
      receivedAt: 44,
      sessionId: "session-a",
      projection: {
        kind: "block_lifecycle",
        sessionId: "session-a",
        phase: "turn_finished",
        blockOps: [{
          action: "close",
          blockType: "thinking",
          blockId: "host-block-thinking-2",
          startedAt: 43,
        }],
      },
    });

    expect(events.filter((entry) => entry.type === "block_add").map((entry) =>
      entry.type === "block_add" ? entry.block.id : ""
    )).toEqual(["host-block-assistant-1", "host-block-thinking-2"]);
    expect(events.filter((entry) => entry.type === "block_patch").map((entry) =>
      entry.type === "block_patch" ? entry.blockId : ""
    )).toEqual(["host-block-assistant-1", "host-block-thinking-2"]);
  });

  it("restores complete active text before later live deltas", () => {
    const { events, internal } = bridgeHarness();
    internal.projectHostActiveBlockSnapshots([{
      generation: 7,
      sessionId: "session-a",
      blockType: "assistant",
      blockId: "host-block-active-1",
      startedAt: 42,
      text: "complete so far",
      textComplete: true,
    }]);

    expect(events).toEqual([
      {
        type: "block_add",
        sessionId: "session-a",
        block: {
          type: "assistant",
          id: "host-block-active-1",
          text: "complete so far",
          ts: 42,
          streaming: true,
        },
      },
      {
        type: "block_patch",
        sessionId: "session-a",
        blockId: "host-block-active-1",
        patch: { type: "assistant", text: "complete so far", streaming: true },
      },
    ]);
  });

  it("never overwrites a possibly fuller local block with a truncated Host snapshot", () => {
    const { events, internal } = bridgeHarness();
    internal.projectHostActiveBlockSnapshots([{
      generation: 7,
      sessionId: "session-a",
      blockType: "thinking",
      blockId: "host-block-active-2",
      startedAt: 42,
      text: "bounded prefix",
      textComplete: false,
    }]);

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "block_add",
      sessionId: "session-a",
      block: {
        type: "thinking",
        id: "host-block-active-2",
        text: "bounded prefix\n… [Grox 活动流快照已截断]",
        live: true,
      },
    });
  });

  it("surfaces a replay gap instead of silently accepting a sequence jump", () => {
    localStorage.removeItem("grox.hostSessionEventCursor.v1");
    const { events, internal } = bridgeHarness();
    internal.projectHostSessionEvent({
      streamId: "host-stream-a",
      sequence: 3,
      generation: 7,
      receivedAt: 42,
      projection: { kind: "notification", method: "x.ai/models/update", params: {} },
    });

    const notice = events.find(
      (entry): entry is Extract<BridgeEvent, { type: "runtime_notice" }> =>
        entry.type === "runtime_notice",
    );
    expect(notice?.notice.id).toBe("error-protocol-ACP_EVENT_REPLAY_GAP");
  });
});
