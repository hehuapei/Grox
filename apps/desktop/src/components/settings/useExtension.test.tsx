import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { useExtension } from "./SettingsModal";

afterEach(() => document.body.replaceChildren());

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function Probe({ context, loader }: { context: string; loader(): Promise<string> }) {
  const state = useExtension(loader, [context]);
  return <div>{state.loading ? "loading" : state.data ?? state.error ?? "empty"}</div>;
}

describe("useExtension", () => {
  it("上下文切换后立即移除上一会话的数据，避免旧按钮作用于新会话", async () => {
    const first = deferred<string>();
    const second = deferred<string>();
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);

    await act(async () => root.render(<Probe context="session-a" loader={() => first.promise} />));
    await act(async () => first.resolve("session-a data"));
    expect(container.textContent).toBe("session-a data");

    await act(async () => root.render(<Probe context="session-b" loader={() => second.promise} />));
    expect(container.textContent).toBe("loading");
    expect(container.textContent).not.toContain("session-a data");

    await act(async () => second.resolve("session-b data"));
    expect(container.textContent).toBe("session-b data");
    await act(async () => root.unmount());
  });
});
