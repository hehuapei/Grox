import { describe, expect, it } from "vitest";
import { isSafeMarkdownOpenUrl } from "./openUrlSafety";

describe("isSafeMarkdownOpenUrl", () => {
  it("allows remote https and loopback http", () => {
    expect(isSafeMarkdownOpenUrl(new URL("https://github.com/x"))).toBe(true);
    expect(isSafeMarkdownOpenUrl(new URL("http://127.0.0.1:5173/"))).toBe(true);
    expect(isSafeMarkdownOpenUrl(new URL("http://localhost:3000/"))).toBe(true);
    expect(isSafeMarkdownOpenUrl(new URL("http://[::ffff:127.0.0.1]/"))).toBe(true);
  });

  it("rejects credentials, remote http, and metadata hosts", () => {
    expect(isSafeMarkdownOpenUrl(new URL("https://user:pass@evil.com/"))).toBe(false);
    expect(isSafeMarkdownOpenUrl(new URL("http://evil.example/phish"))).toBe(false);
    expect(isSafeMarkdownOpenUrl(new URL("https://169.254.169.254/latest/meta-data/"))).toBe(
      false,
    );
    expect(isSafeMarkdownOpenUrl(new URL("https://metadata.google.internal/"))).toBe(false);
    expect(isSafeMarkdownOpenUrl(new URL("https://100.100.100.200/"))).toBe(false);
    // R22: trailing-dot FQDN denylist bypass class
    expect(isSafeMarkdownOpenUrl(new URL("https://169.254.169.254./"))).toBe(false);
    expect(isSafeMarkdownOpenUrl(new URL("https://metadata.google.internal./"))).toBe(false);
    expect(isSafeMarkdownOpenUrl(new URL("https://kubernetes.default.svc/"))).toBe(false);
    expect(isSafeMarkdownOpenUrl(new URL("https://[::ffff:169.254.169.254]/"))).toBe(false);
  });
});
