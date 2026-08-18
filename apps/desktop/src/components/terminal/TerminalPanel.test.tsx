import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import type { Session } from "../../bridge/types";
import { useDesktop } from "../../state/store";
import { TerminalPanel } from "./TerminalPanel";

const initialState = useDesktop.getState();

const session = (lines: string[]): Session => ({
  id: "session-terminal",
  title: "terminal",
  cwd: "/workspace",
  createdAt: 1,
  updatedAt: 2,
  model: "grok-build",
  status: "running",
  usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, costUSD: 0, contextUsed: 0, contextMax: 0, turns: 1 },
  blocks: [{
    type: "tool",
    id: "tool-1",
    ts: 1,
    call: {
      id: "call-1",
      kind: "execute",
      title: "run",
      status: "running",
      startedAt: 1,
      terminal: { cmd: "pnpm test", lines },
    },
  }],
});

afterEach(() => {
  useDesktop.setState(initialState, true);
  document.body.replaceChildren();
});

describe("TerminalPanel", () => {
  it("用户上滚检查输出后，新行不会强制拉回底部", async () => {
    useDesktop.setState({ activeId: "session-terminal", sessions: { "session-terminal": session(["one"]) } });
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    await act(async () => root.render(<TerminalPanel embedded />));
    const viewport = container.querySelector<HTMLDivElement>(".overflow-y-auto");
    expect(viewport).not.toBeNull();
    Object.defineProperties(viewport!, {
      scrollHeight: { configurable: true, value: 500 },
      clientHeight: { configurable: true, value: 100 },
    });
    viewport!.scrollTop = 120;
    await act(async () => viewport!.dispatchEvent(new Event("scroll", { bubbles: true })));

    await act(async () => {
      useDesktop.setState({ sessions: { "session-terminal": session(["one", "two"]) } });
      await Promise.resolve();
    });

    expect(viewport!.scrollTop).toBe(120);
    await act(async () => root.unmount());
  });
});
