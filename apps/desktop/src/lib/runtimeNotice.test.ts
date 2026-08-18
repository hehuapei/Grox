import { describe, expect, it } from "vitest";
import { cleanApiError, toolCanonicalKind, toolReadOnly, versionMismatchNotice } from "./runtimeNotice";

describe("versionMismatchNotice", () => {
  it("builds a desktop-owned restart notice from official fields", () => {
    expect(versionMismatchNotice({ clientVersion: "0.2.121", leaderVersion: "0.2.120" }))
      .toMatchObject({ level: "warning", message: expect.stringContaining("0.2.121") });
  });

  it("rejects missing or control-only versions", () => {
    expect(versionMismatchNotice({ clientVersion: "\n", leaderVersion: "0.2.120" })).toBeUndefined();
  });
});

it("reads the official x.ai/tool read_only metadata", () => {
  expect(toolReadOnly({ _meta: { "x.ai/tool": { version: 1, read_only: true } } })).toBe(true);
  expect(toolReadOnly({ kind: "read" })).toBeUndefined();
});

it("reads the canonical kind when the generic ACP kind is less specific", () => {
  expect(toolCanonicalKind({ kind: "other", _meta: { "x.ai/tool": { kind: "voice" } } })).toBe("voice");
});

it("turns nested API JSON into a clean desktop message", () => {
  expect(cleanApiError('{"error":{"message":"Service temporarily unavailable"}}'))
    .toBe("Service temporarily unavailable");
  expect(cleanApiError({})).toBe("未知错误");
  expect(cleanApiError({ code: "ACP_DOWN" })).toBe("code: ACP_DOWN");
});
