import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Session } from "../../bridge/types";
import { useDesktop } from "../../state/store";
import { DeadSessionNotice } from "./Timeline";

const initialState = useDesktop.getState();
const deadSession: Session = {
  id: "dead-session",
  title: "失效会话",
  cwd: "/workspace",
  createdAt: 1,
  updatedAt: 2,
  model: "grok-build",
  status: "failed",
  blocks: [],
  usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, costUSD: 0, contextUsed: 0, contextMax: 0, turns: 0 },
};

afterEach(() => {
  useDesktop.setState(initialState, true);
  document.body.replaceChildren();
});

describe("DeadSessionNotice", () => {
  it("危险删除先展示不可撤销确认，不会在第一次点击时执行", async () => {
    const removeSessionFromSidebar = vi.fn(async () => {});
    useDesktop.setState({ removeSessionFromSidebar });
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    await act(async () => root.render(<DeadSessionNotice session={deadSession} />));

    const remove = [...container.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent?.includes("删除失效记录"));
    await act(async () => remove?.click());
    expect(removeSessionFromSidebar).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain("永久删除失效会话记录？");

    const confirm = [...document.body.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent === "永久删除");
    await act(async () => confirm?.click());
    expect(removeSessionFromSidebar).toHaveBeenCalledWith("dead-session");
    await act(async () => root.unmount());
  });
});
