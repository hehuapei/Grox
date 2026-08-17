import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ConfigDocument } from "./types";

const invoke = vi.hoisted(() => vi.fn());

vi.mock("@tauri-apps/api/core", () => ({ invoke }));

import { AcpBridge } from "./AcpBridge";

describe("AcpBridge config documents", () => {
  beforeEach(() => invoke.mockReset());

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
});
