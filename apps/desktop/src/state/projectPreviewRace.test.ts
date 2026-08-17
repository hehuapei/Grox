import { afterEach, describe, expect, it, vi } from "vitest";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("../bridge", () => ({ bridge: { kind: "acp" } }));

import type { ProjectPreview } from "../bridge/types";
import { useDesktop } from "./store";

const initialState = useDesktop.getState();

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (cause: unknown) => void;
  const promise = new Promise<T>((ok, fail) => { resolve = ok; reject = fail; });
  return { promise, resolve, reject };
}

const ready = (url: string): ProjectPreview => ({ status: "ready", url });

afterEach(() => {
  invoke.mockReset();
  useDesktop.setState(initialState, true);
});

describe("project preview request ordering", () => {
  it("较慢的旧启动结果不能覆盖较新的预览", async () => {
    const first = deferred<ProjectPreview>();
    const second = deferred<ProjectPreview>();
    invoke.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);

    useDesktop.setState({ workspace: "/workspace" });
    const startA = useDesktop.getState().refreshProjectPreview(true);
    const startB = useDesktop.getState().refreshProjectPreview(true);
    second.resolve(ready("http://127.0.0.1:4002"));
    await startB;
    first.resolve(ready("http://127.0.0.1:4001"));
    await startA;

    expect(useDesktop.getState().projectPreview.url).toBe("http://127.0.0.1:4002");
  });

  it("切换工作区或手动输入 URL 后忽略旧请求结果", async () => {
    const pending = deferred<ProjectPreview>();
    invoke.mockReturnValue(pending.promise);

    useDesktop.setState({ workspace: "/workspace-a" });
    const starting = useDesktop.getState().refreshProjectPreview(true);
    useDesktop.setState({ workspace: "/workspace-b" });
    useDesktop.getState().setProjectPreviewUrl("http://127.0.0.1:4999");
    pending.reject(new Error("旧工作区启动失败"));
    await starting;

    expect(useDesktop.getState().projectPreview).toMatchObject({
      status: "ready",
      url: "http://127.0.0.1:4999",
    });
  });
});
