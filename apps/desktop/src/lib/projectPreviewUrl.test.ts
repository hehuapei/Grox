import { describe, expect, it } from "vitest";
import { projectPreviewUrl } from "./projectPreviewUrl";

describe("projectPreviewUrl", () => {
  it.each([
    ["http://localhost:5173", "http://localhost:5173/"],
    ["http://127.0.0.1:4173/app", "http://127.0.0.1:4173/app"],
  ])("接受本机开发服务器 %s", (value, expected) => {
    expect(projectPreviewUrl(value)).toBe(expected);
  });

  it.each(["https://localhost:5173", "https://example.com", "http://example.com", "http://[::1]:3000", "localhost:5173", "not a url"])(
    "拒绝无法在受限预览 iframe 中工作的地址 %s",
    (value) => expect(() => projectPreviewUrl(value)).toThrow(),
  );
});
