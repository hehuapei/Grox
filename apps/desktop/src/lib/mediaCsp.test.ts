import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

describe("媒体回环服务 CSP", () => {
  it("允许图片、媒体和预览页面连接本机随机端口", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const config = JSON.parse(readFileSync(resolve(here, "../../src-tauri/tauri.conf.json"), "utf8")) as {
      app: { security: { csp: string } };
    };
    const csp = config.app.security.csp;

    for (const directive of ["img-src", "media-src", "connect-src"]) {
      expect(csp).toMatch(new RegExp(`${directive}[^;]*http://127\\.0\\.0\\.1:\\*`));
    }
  });
});
