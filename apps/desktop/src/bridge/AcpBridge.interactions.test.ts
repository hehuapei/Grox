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
  journalRecoverable?: boolean;
  journalAcknowledged?: boolean;
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
  updatedThrough?: number;
  text: string;
  textComplete: boolean;
}

interface InteractionInternals {
  diagnostics: string[];
  liveAssistantSessions: Set<string>;
  catalogue: Map<string, { id: string; title: string; cwd: string; createdAt: number; updatedAt: number; model: string; turns: number }>;
  projectHostInteraction(interaction: HostInteraction): void;
  reconcileHostInteractions(interactions: HostInteraction[]): void;
  projectAutomationSessionStarted(started: AutomationSessionStarted): void;
  projectHostSessionEvent(event: HostSessionEvent): void;
  projectHostActiveBlockSnapshots(snapshots: HostActiveBlockSnapshot[]): void;
  hostEventWaitsForToolMedia(event: HostSessionEvent): boolean;
  queueStreamAppend(event: Extract<BridgeEvent, { type: "assistant_append" | "thinking_append" }>): void;
  flushStreamAppends(sessionId?: string): void;
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
  it("keeps repeated GFM divider cells that the model-loop guard would drop", () => {
    // 多列表格的分隔行会以完全相同的短分片连续到达。丢掉其中任何一个单元，
    // 列数就对不上，整张表退化成一个段落。
    const { events, internal } = bridgeHarness();
    for (let index = 0; index < 6; index += 1) {
      internal.queueStreamAppend({
        type: "assistant_append",
        sessionId: "session-a",
        blockId: "block-1",
        delta: "---|",
      });
    }
    internal.flushStreamAppends();

    const appended = events
      .filter((event) => event.type === "assistant_append")
      .map((event) => event.delta)
      .join("");
    expect(appended).toBe("---|".repeat(6));
  });

  it("keeps repeated prose chunks lossless", () => {
    const { events, internal } = bridgeHarness();
    for (let index = 0; index < 6; index += 1) {
      internal.queueStreamAppend({
        type: "assistant_append",
        sessionId: "session-b",
        blockId: "block-1",
        delta: "again ",
      });
    }
    internal.flushStreamAppends();

    const appended = events
      .filter((event) => event.type === "assistant_append")
      .map((event) => event.delta)
      .join("");
    expect(appended).toBe("again ".repeat(6));
  });

  it("projects early and resumed session summaries idempotently across payload casing", () => {
    const { events, internal } = bridgeHarness();
    internal.catalogue.set("session-a", {
      id: "session-a",
      title: "Original",
      cwd: "/project",
      createdAt: 1,
      updatedAt: 1,
      model: "grok-build",
      turns: 1,
    });
    const projectSummary = (sequence: number, update: unknown) => internal.projectHostSessionEvent({
      streamId: "host-stream-summary",
      sequence,
      generation: 7,
      receivedAt: 42 + sequence,
      sessionId: "session-a",
      updateType: "session_summary_generated",
      journalRecoverable: true,
      projection: {
        kind: "session_update",
        channel: "notification",
        sessionId: "session-a",
        updateType: "session_summary_generated",
        update,
        blockOps: [],
      },
    });

    projectSummary(1, { sessionUpdate: "session_summary_generated", session_summary: "Early title" });
    projectSummary(2, { sessionUpdate: "session_summary_generated", sessionSummary: "Early title" });
    projectSummary(3, { sessionUpdate: "session_summary_generated", sessionSummary: "Resumed recap title" });

    expect(internal.catalogue.get("session-a")?.title).toBe("Resumed recap title");
    expect(events.filter((event) => event.type === "session_meta")).toEqual([
      { type: "session_meta", sessionId: "session-a", patch: { title: "Early title" } },
      { type: "session_meta", sessionId: "session-a", patch: { title: "Resumed recap title" } },
    ]);
  });

  it("does not suppress disk fallback for an unprojected assistant chunk", () => {
    const { events, internal } = bridgeHarness();
    internal.projectHostSessionEvent({
      streamId: "host-stream-unprojected-assistant",
      sequence: 1,
      generation: 7,
      receivedAt: 42,
      sessionId: "session-a",
      projection: {
        kind: "session_update",
        channel: "session",
        sessionId: "session-a",
        updateType: "agent_message_chunk",
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "persisted on disk" },
        },
        blockOps: [],
      },
    });

    expect(internal.liveAssistantSessions.has("session-a")).toBe(false);
    expect(events.some((event) => event.type === "block_add")).toBe(false);
  });

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

  it("keeps an unowned late response in diagnostics without alarming the user", () => {
    const { events, internal } = bridgeHarness();
    internal.projectHostSessionEvent({
      streamId: "host-stream-late-response",
      sequence: 1,
      generation: 7,
      receivedAt: 42,
      projection: { kind: "orphan_response" },
    });

    expect(events.some((event) => event.type === "runtime_notice")).toBe(false);
    expect(internal.diagnostics.at(-1)).toContain("ACP_ORPHAN_RESPONSE");
  });

  it("projects a Host-created automation session without asking WebView to create it", () => {
    const { events, internal } = bridgeHarness();
    const started: AutomationSessionStarted = {
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
    };
    internal.projectAutomationSessionStarted(started);
    internal.projectAutomationSessionStarted(started);

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
    expect(events.filter((event) => event.type === "session_ready")).toHaveLength(1);
  });

  it("skips journal-acknowledged replay without treating the sequence as a gap", () => {
    const { events, internal } = bridgeHarness();
    internal.projectHostSessionEvent({
      streamId: "host-stream-acked",
      sequence: 1,
      generation: 7,
      receivedAt: 41,
      sessionId: "session-a",
      journalRecoverable: true,
      journalAcknowledged: true,
      projection: {
        kind: "session_update",
        channel: "session",
        sessionId: "session-a",
        updateType: "agent_message_chunk",
        update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "already saved" } },
        blockOps: [{
          action: "open",
          blockType: "assistant",
          blockId: "host-block-acked",
          startedAt: 41,
        }],
      },
    });
    internal.projectHostSessionEvent({
      streamId: "host-stream-acked",
      sequence: 2,
      generation: 7,
      receivedAt: 42,
      sessionId: "session-a",
      journalRecoverable: true,
      journalAcknowledged: false,
      projection: {
        kind: "session_update",
        channel: "session",
        sessionId: "session-a",
        updateType: "agent_message_chunk",
        update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "new" } },
        blockOps: [{
          action: "open",
          blockType: "assistant",
          blockId: "host-block-new",
          startedAt: 42,
        }],
      },
    });
    internal.flushStreamAppends("session-a");

    expect(events.filter((event) => event.type === "block_add")).toHaveLength(1);
    expect(events.some((event) => event.type === "runtime_notice")).toBe(false);
    expect(events.filter((event) => event.type === "session_journal_checkpoint")).toHaveLength(1);
  });

  it("deduplicates replayed Host events by stream cursor", () => {
    const { events, internal } = bridgeHarness();
    const event: HostSessionEvent = {
      streamId: "host-stream-a",
      sequence: 1,
      generation: 7,
      receivedAt: 42,
      sessionId: "session-a",
      method: "session/update",
      updateType: "agent_message_chunk",
      journalRecoverable: true,
      journalAcknowledged: false,
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
    internal.flushStreamAppends("session-a");

    expect(events.filter((entry) => entry.type === "block_add")).toHaveLength(1);
    expect(events.findIndex((entry) => entry.type === "assistant_append")).toBeLessThan(
      events.findIndex((entry) => entry.type === "session_journal_checkpoint"),
    );
    expect(events.filter((entry) => entry.type === "session_journal_checkpoint")).toEqual([{
      type: "session_journal_checkpoint",
      sessionId: "session-a",
      streamId: "host-stream-a",
      sequence: 1,
    }]);
  });

  it("detects tool media that requires durable persistence before acknowledgement", () => {
    const { internal } = bridgeHarness();
    const event: HostSessionEvent = {
      streamId: "host-stream-media",
      sequence: 1,
      generation: 7,
      receivedAt: 42,
      sessionId: "session-a",
      journalRecoverable: true,
      journalAcknowledged: false,
      projection: {
        kind: "session_update",
        channel: "session",
        sessionId: "session-a",
        updateType: "tool_call_update",
        update: {
          sessionUpdate: "tool_call_update",
          toolCallId: "tool-1",
          content: [{ type: "image", mimeType: "image/png", data: "aGVsbG8=" }],
        },
        blockOps: [],
      },
    };

    expect(internal.hostEventWaitsForToolMedia(event)).toBe(true);
    event.projection = {
      kind: "session_update",
      channel: "session",
      sessionId: "session-a",
      updateType: "tool_call_update",
      update: {
        sessionUpdate: "tool_call_update",
        toolCallId: "tool-1",
        content: [{ type: "text", text: "done" }],
      },
      blockOps: [],
    };
    expect(internal.hostEventWaitsForToolMedia(event)).toBe(false);
  });

  it("acknowledges a suppressed tool-media tail instead of replaying it forever", () => {
    const { events, internal } = bridgeHarness();
    internal.projectHostSessionEvent({
      streamId: "host-stream-suppressed-media",
      sequence: 1,
      generation: 7,
      receivedAt: 42,
      sessionId: "session-a",
      journalRecoverable: true,
      journalAcknowledged: false,
      projection: {
        kind: "session_update",
        channel: "session",
        sessionId: "session-a",
        updateType: "tool_call_update",
        update: {
          sessionUpdate: "tool_call_update",
          toolCallId: "tool-1",
          content: [{ type: "image", mimeType: "image/png", data: "aGVsbG8=" }],
        },
        // Host 已决定忽略这个工具尾帧，因此没有可持久化的工具 block。
        blockOps: [],
      },
    });

    expect(events.filter((event) => event.type === "session_journal_checkpoint")).toEqual([{
      type: "session_journal_checkpoint",
      sessionId: "session-a",
      streamId: "host-stream-suppressed-media",
      sequence: 1,
    }]);
  });

  it("uses Host block identity and lifecycle closes across stream phases", () => {
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

describe("AcpBridge live streaming projection", () => {
  const hostEvent = (
    sequence: number,
    updateType: string,
    update: unknown,
    blockOps: HostBlockOperation[],
  ): HostSessionEvent => ({
    streamId: "host-stream-live",
    sequence,
    generation: 1,
    receivedAt: 1_000 + sequence,
    sessionId: "session-live",
    updateType,
    journalRecoverable: true,
    projection: {
      kind: "session_update",
      channel: "session",
      sessionId: "session-live",
      updateType,
      update,
      blockOps,
    },
  });

  it("emits a tool block as soon as the host reports the call", () => {
    // 回合进行中工具卡必须立刻出现，不能等到回合结束才一次性冒出来。
    const { events, internal } = bridgeHarness();
    internal.projectHostSessionEvent(hostEvent(
      1,
      "tool_call",
      { sessionUpdate: "tool_call", toolCallId: "call-1", title: "search", status: "pending" },
      [{ action: "open", blockType: "tool", blockId: "tool-block-1", sourceId: "call-1", startedAt: 1_001 }],
    ));

    const added = events.filter((event) => event.type === "block_add");
    expect(added).toHaveLength(1);
    expect(added[0]).toMatchObject({ sessionId: "session-live" });
  });

  it("emits assistant text incrementally rather than only at turn end", () => {
    const { events, internal } = bridgeHarness();
    for (const [sequence, text] of [[1, "第一段"], [2, "第二段"]] as const) {
      internal.projectHostSessionEvent(hostEvent(
        sequence,
        "agent_message_chunk",
        { sessionUpdate: "agent_message_chunk", content: { type: "text", text } },
        [{
          action: sequence === 1 ? "open" : "update",
          blockType: "assistant",
          blockId: "assistant-block-1",
          startedAt: 1_001,
        }],
      ));
    }
    internal.flushStreamAppends();

    expect(events.some((event) => event.type === "block_add")).toBe(true);
    const streamed = events
      .filter((event) => event.type === "assistant_append")
      .map((event) => event.delta)
      .join("");
    expect(streamed).toBe("第一段第二段");
  });

  it("projects thinking, tools and final text through the same live event path", () => {
    const { events, internal } = bridgeHarness();
    internal.projectHostSessionEvent(hostEvent(
      1,
      "agent_thought_chunk",
      { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "先分析" } },
      [{ action: "open", blockType: "thinking", blockId: "thinking-1", startedAt: 1_001 }],
    ));
    internal.projectHostSessionEvent(hostEvent(
      2,
      "tool_call",
      { sessionUpdate: "tool_call", toolCallId: "call-1", title: "web_search", status: "pending" },
      [
        { action: "close", blockType: "thinking", blockId: "thinking-1", startedAt: 1_001 },
        { action: "open", blockType: "tool", blockId: "tool-1", sourceId: "call-1", startedAt: 1_002 },
      ],
    ));
    internal.projectHostSessionEvent(hostEvent(
      3,
      "agent_message_chunk",
      { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "最终答案" } },
      [{ action: "open", blockType: "assistant", blockId: "assistant-1", startedAt: 1_003 }],
    ));
    internal.flushStreamAppends();

    const addedTypes = events
      .filter((event): event is Extract<BridgeEvent, { type: "block_add" }> => event.type === "block_add")
      .map((event) => event.block.type);
    expect(addedTypes).toEqual(["thinking", "tool", "assistant"]);
    expect(events.some((event) => event.type === "thinking_append" && event.delta === "先分析")).toBe(true);
    expect(events.some((event) => event.type === "assistant_append" && event.delta === "最终答案")).toBe(true);
  });
});
