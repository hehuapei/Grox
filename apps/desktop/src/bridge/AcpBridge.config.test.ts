import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ConfigDocument } from "./types";

const invoke = vi.hoisted(() => vi.fn());

vi.mock("@tauri-apps/api/core", () => ({ invoke }));

import { AcpBridge } from "./AcpBridge";

describe("AcpBridge config documents", () => {
  beforeEach(() => {
    invoke.mockReset();
    localStorage.clear();
  });

  it("保存时使用编辑器捕获的工作区，而不是 bridge 的可变当前工作区", async () => {
    invoke.mockResolvedValue({});
    const bridge = new AcpBridge();
    const document: ConfigDocument = {
      id: "agents",
      label: "AGENTS.md",
      path: "/project-a/AGENTS.md",
      content: "project rules",
      exists: true,
      language: "markdown",
    };

    await bridge.writeConfigDocument(document, "/project-a");

    expect(invoke).toHaveBeenCalledWith("write_config_document", {
      request: { id: "agents", cwd: "/project-a", content: "project rules" },
    });
  });

  it("恢复会话时绑定当前 reasoning effort 但不重选模型", async () => {
    localStorage.setItem("grok.effort", "max");
    invoke.mockRejectedValue(new Error("stop after request capture"));
    const bridge = new AcpBridge();
    const internal = bridge as unknown as {
      catalogue: Map<string, unknown>;
    };
    internal.catalogue.set("session-a", {
      id: "session-a",
      title: "Session A",
      cwd: "/project-a",
      createdAt: Date.now(),
      updatedAt: Date.now(),
      model: "grok-build",
      turns: 1,
    });

    await expect(bridge.loadSession("session-a")).rejects.toThrow("stop after request capture");

    expect(invoke).toHaveBeenCalledWith("open_agent_session", {
      request: expect.objectContaining({
        cwd: "/project-a",
        sessionId: "session-a",
        reasoningEffort: "max",
      }),
    });
    const request = invoke.mock.calls[0][1].request as Record<string, unknown>;
    expect(request).not.toHaveProperty("preferredModel");
  });
});
