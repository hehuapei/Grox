import { describe, expect, it } from "vitest";
import {
  reconcileIncomingStatus,
  statusAfterGateResolve,
  topPendingPermissionId,
  topPendingQuestionId,
} from "./sessionGate";
import type { Session, SessionBlock } from "../bridge/types";

const perm = (id: string, resolved?: "allow_once"): SessionBlock => ({
  type: "permission",
  id,
  req: {
    id: "r",
    toolCallId: id,
    title: "t",
    description: "d",
    options: ["allow_once", "deny"],
  },
  ts: 1,
  ...(resolved ? { resolved } : {}),
});

const question = (id: string, answered = false): SessionBlock => ({
  type: "question",
  id,
  req: { id: "q", toolCallId: id, questions: [], mode: "default" },
  ts: 1,
  ...(answered ? { response: { outcome: "cancelled" as const } } : {}),
});

describe("statusAfterGateResolve", () => {
  it("stays awaiting_permission when another card is open", () => {
    const blocks = [perm("p1", "allow_once"), perm("p2")];
    expect(statusAfterGateResolve(blocks, "awaiting_permission")).toBe("awaiting_permission");
  });

  it("returns running when last gate closes", () => {
    const blocks = [perm("p1", "allow_once")];
    expect(statusAfterGateResolve(blocks, "awaiting_permission")).toBe("running");
  });

  it("prefers awaiting_input when a question remains", () => {
    const blocks = [perm("p1", "allow_once"), question("q1")];
    expect(statusAfterGateResolve(blocks, "awaiting_permission")).toBe("awaiting_input");
  });
});

describe("reconcileIncomingStatus", () => {
  it("does not demote awaiting_permission to running while a card is open", () => {
    const blocks = [perm("p1")];
    expect(reconcileIncomingStatus(blocks, "awaiting_permission", "running")).toBe(
      "awaiting_permission",
    );
  });

  it("does not demote awaiting_input to running while a question is open", () => {
    const blocks = [question("q1")];
    expect(reconcileIncomingStatus(blocks, "awaiting_input", "running")).toBe("awaiting_input");
  });

  it("promotes running → awaiting when unresolved gates exist", () => {
    const blocks = [perm("p1")];
    expect(reconcileIncomingStatus(blocks, "running", "running")).toBe("awaiting_permission");
  });

  it("lets idle settle even with unresolved gates (Stop / turn end)", () => {
    const blocks = [perm("p1")];
    expect(reconcileIncomingStatus(blocks, "awaiting_permission", "idle")).toBe("idle");
  });

  it("passes through running when no gates are open", () => {
    const blocks = [perm("p1", "allow_once")];
    expect(reconcileIncomingStatus(blocks, "awaiting_permission", "running")).toBe("running");
  });
});

describe("topPendingPermissionId", () => {
  it("returns the latest unresolved permission", () => {
    const session = {
      blocks: [perm("p1", "allow_once"), perm("p2"), perm("p3")],
    } as Session;
    expect(topPendingPermissionId(session)).toBe("p3");
  });
});

describe("topPendingQuestionId", () => {
  it("returns the latest unresolved question", () => {
    const session = {
      blocks: [question("q1", true), question("q2"), question("q3")],
    } as Session;
    expect(topPendingQuestionId(session)).toBe("q3");
  });
});
