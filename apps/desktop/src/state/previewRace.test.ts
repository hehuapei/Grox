import { afterEach, describe, expect, it, vi } from "vitest";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));

import type { PreviewFile } from "../bridge/types";
import { useDesktop } from "./store";

const initialState = useDesktop.getState();

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (cause: unknown) => void;
  const promise = new Promise<T>((ok, fail) => { resolve = ok; reject = fail; });
  return { promise, resolve, reject };
}

const file = (path: string): PreviewFile => ({
  path,
  name: path,
  kind: "text",
  mime: "text/plain",
  content: path,
});

afterEach(() => {
  invoke.mockReset();
  useDesktop.setState(initialState, true);
});

describe("preview request ordering", () => {
  it("较慢的旧文件读取不能覆盖较新的预览", async () => {
    const first = deferred<PreviewFile>();
    const second = deferred<PreviewFile>();
    invoke.mockImplementation((_command: string, args: { path?: string }) => (
      args.path === "a.txt" ? first.promise : second.promise
    ));

    const openA = useDesktop.getState().openPreview("a.txt");
    const openB = useDesktop.getState().openPreview("b.txt");
    second.resolve(file("b.txt"));
    await openB;
    first.resolve(file("a.txt"));
    await openA;

    expect(useDesktop.getState().previewFile?.path).toBe("b.txt");
    expect(useDesktop.getState().previewError).toBeNull();
  });

  it("关闭预览后忽略旧请求的失败结果", async () => {
    const pending = deferred<PreviewFile>();
    invoke.mockReturnValue(pending.promise);

    const opening = useDesktop.getState().openPreview("late.txt");
    useDesktop.getState().closePreview();
    pending.reject(new Error("迟到的读取错误"));
    await opening;

    expect(useDesktop.getState().previewOpen).toBe(false);
    expect(useDesktop.getState().previewLoading).toBe(false);
    expect(useDesktop.getState().previewFile).toBeNull();
    expect(useDesktop.getState().previewError).toBeNull();
  });
});
