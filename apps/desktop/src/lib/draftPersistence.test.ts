import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const invokeMock = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));

import {
  clearDraftBuffer,
  compactDraftBuffer,
  loadDraftBuffer,
  resetDraftPersistenceForTests,
  saveDraftBuffer,
} from "./draftPersistence";

describe("draftPersistence browser fallback", () => {
  beforeEach(() => {
    localStorage.clear();
    resetDraftPersistenceForTests();
    invokeMock.mockReset();
  });

  afterEach(() => {
    delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
  });

  it("persists and reloads unsent draft text per cwd", async () => {
    await saveDraftBuffer("C:\\Work\\Repo", "未发送的提示词");
    const loaded = await loadDraftBuffer("C:/Work/Repo");
    expect(loaded?.text).toBe("未发送的提示词");
  });

  it("persists attachments for first-send crash recovery", async () => {
    await saveDraftBuffer("C:\\Work\\Repo", "with file", [{
      id: "a1",
      kind: "text",
      name: "notes.txt",
      mime: "text/plain",
      size: 4,
      text: "body",
    }]);
    expect((await loadDraftBuffer("C:/Work/Repo"))?.attachments[0]?.text).toBe("body");
  });

  it("strips attachment bodies when they exceed the recovery budget", () => {
    const huge = "x".repeat(900_000);
    const compacted = compactDraftBuffer("C:/Work/Repo", "keep me", [
      { id: "img", kind: "image", name: "big.png", mime: "image/png", size: huge.length, data: huge },
      { id: "img2", kind: "image", name: "big2.png", mime: "image/png", size: huge.length, data: huge },
    ]);
    expect(compacted?.text).toBe("keep me");
    expect(compacted?.attachments.some((item) => item.data || item.text)).toBe(false);
  });

  it("clear removes an existing browser-only draft", async () => {
    await saveDraftBuffer("C:\\A", "hello");
    await clearDraftBuffer("C:\\A");
    expect(await loadDraftBuffer("C:\\A")).toBeNull();
  });

  it("corrupt legacy data is explicit instead of becoming an empty draft", async () => {
    localStorage.setItem("grox.draftBuffer.v1", "not-json");
    await expect(loadDraftBuffer("C:\\A")).rejects.toThrow();
  });
});

describe("draftPersistence Host authority", () => {
  beforeEach(() => {
    localStorage.clear();
    resetDraftPersistenceForTests();
    invokeMock.mockReset();
    (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
  });

  afterEach(() => {
    delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
  });

  it("serializes save and delete with the Host revision returned by the prior commit", async () => {
    invokeMock
      .mockResolvedValueOnce({ revision: 0, draft: null })
      .mockResolvedValueOnce({ revision: 1, draft: { cwd: "/repo", text: "hello", attachments: [], updatedAt: 1 } })
      .mockResolvedValueOnce({ revision: 2, draft: null });
    await saveDraftBuffer("/repo", "hello");
    await clearDraftBuffer("/repo");
    expect(invokeMock.mock.calls.map(([command, args]) => [command, args?.expectedRevision])).toEqual([
      ["read_draft", undefined],
      ["write_draft", 0],
      ["delete_draft", 1],
    ]);
  });

  it("Host tombstone wins over stale legacy localStorage", async () => {
    localStorage.setItem("grox.draftBuffer.v1", JSON.stringify({
      "/repo": { cwd: "/repo", text: "stale", attachments: [], updatedAt: Date.now() },
    }));
    invokeMock.mockResolvedValueOnce({ revision: 4, draft: null });
    expect(await loadDraftBuffer("/repo")).toBeNull();
    expect(invokeMock).toHaveBeenCalledTimes(1);
    expect(localStorage.getItem("grox.draftBuffer.v1")).toBe("{}");
  });

  it("does not retry a stale write after a revision conflict", async () => {
    invokeMock
      .mockResolvedValueOnce({ revision: 2, draft: null })
      .mockRejectedValueOnce({ domain: "operation", code: "DRAFT_WRITE_CONFLICT" });
    await expect(saveDraftBuffer("/repo", "stale")).rejects.toMatchObject({
      code: "DRAFT_WRITE_CONFLICT",
    });
    expect(invokeMock.mock.calls.map(([command]) => command)).toEqual(["read_draft", "write_draft"]);
  });
});
