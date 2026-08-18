import { describe, expect, it } from "vitest";
import { AcpRpcError, decodeAcpResponse } from "./acpRpc";

describe("decodeAcpResponse", () => {
  it("只返回与 Host 请求一致的响应", () => {
    expect(decodeAcpResponse('{"jsonrpc":"2.0","id":4,"result":{"ok":true}}', 4, "session/list"))
      .toEqual({ ok: true });
    expect(() => decodeAcpResponse('{"jsonrpc":"2.0","id":5,"result":{}}', 4, "session/list"))
      .toThrow("无法归属");
  });

  it("保留标准 JSON-RPC 错误代码", () => {
    try {
      decodeAcpResponse('{"jsonrpc":"2.0","id":1,"error":{"code":-32602,"message":"invalid params"}}', 1, "session/load");
      throw new Error("expected decode to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(AcpRpcError);
      expect((error as AcpRpcError).code).toBe(-32602);
    }
  });

  it("解开 x.ai 扩展响应信封", () => {
    expect(decodeAcpResponse(
      '{"jsonrpc":"2.0","id":8,"result":{"result":{"sessions":[1]}}}',
      8,
      "x.ai/session/list",
    )).toEqual({ sessions: [1] });
  });
});
