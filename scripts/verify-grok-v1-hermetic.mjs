import http from "node:http";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const grokHome = mkdtempSync(join(tmpdir(), "grox-v1-hermetic-"));
const requests = [];
let foregroundTurns = 0;
let imageForwardedToModel = false;
let imageTextForwardedToModel = false;

function json(response, status, value) {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(value));
}

function sse(response, events) {
  response.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
  });
  for (const event of events) response.write(`data: ${JSON.stringify(event)}\n\n`);
  response.end("data: [DONE]\n\n");
}

const server = http.createServer((request, response) => {
  let body = "";
  request.on("data", (chunk) => { body += chunk; });
  request.on("end", () => {
    let parsed = {};
    try { parsed = body ? JSON.parse(body) : {}; } catch { /* covered by response below */ }
    requests.push({ method: request.method, url: request.url, bytes: Buffer.byteLength(body) });
    if (Array.isArray(parsed.messages)) {
      requests.at(-1).messages = parsed.messages.map((message) => ({
        role: message?.role,
        content: JSON.stringify(message?.content).slice(0, 600),
      }));
    }
    if (Array.isArray(parsed.tools)) {
      requests.at(-1).toolNames = parsed.tools.map((entry) => entry?.function?.name ?? entry?.name).filter(Boolean);
    }
    if (request.method === "GET" && request.url === "/v1/models") {
      return json(response, 200, {
        object: "list",
        data: [{
          id: "grok-build",
          object: "model",
          created: 1,
          owned_by: "grox-ci",
          apiBackend: "chat_completions",
          supportsReasoningEffort: true,
          reasoningEfforts: ["low", "high"],
          _meta: { agentType: "grok-build" },
        }],
      });
    }
    if (request.method === "GET" && request.url === "/v1/api-key") {
      return json(response, 200, { api_key_id: "grox-ci", api_key_blocked: false, api_key_disabled: false });
    }
    if (request.method === "GET" && request.url === "/v1/settings") return json(response, 200, { allow_access: true });
    if (request.method === "GET" && request.url?.startsWith("/v1/user")) {
      return json(response, 200, { userId: "grox-ci", email: "ci@test.invalid", subscriptionTier: "supergrok" });
    }
    if (request.method === "POST" && request.url === "/v1/chat/completions") {
      if (body.includes("data:image/")) imageForwardedToModel = true;
      // 1.0.3 may replace the text immediately before an image with its ACP
      // placeholder, but the unique suffix must still survive into the model.
      if (body.includes("_LARGE_IMAGE_OK")) imageTextForwardedToModel = true;
      const id = `chatcmpl-grox-${++foregroundTurns}`;
      const namedTool = (name) => Array.isArray(parsed.tools)
        ? parsed.tools.find((entry) => (entry?.function?.name ?? entry?.name) === name)
        : undefined;
      const toolCall = (tool, argumentsJson) => sse(response, [
        { id, object: "chat.completion.chunk", created: 1, model: "grok-build", choices: [{ index: 0, delta: { role: "assistant", tool_calls: [{ index: 0, id: `call_grox_${foregroundTurns}`, type: "function", function: { name: tool.function?.name ?? tool.name, arguments: JSON.stringify(argumentsJson) } }] }, finish_reason: null }] },
        { id, object: "chat.completion.chunk", created: 1, model: "grok-build", choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
      ]);
      if (foregroundTurns === 1) {
        const searchTool = namedTool("search_tool");
        if (!searchTool) return json(response, 500, { error: "search_tool missing" });
        return toolCall(searchTool, { query: "grox large image", limit: 5 });
      }
      if (foregroundTurns === 2) {
        const useTool = namedTool("use_tool");
        if (!useTool) return json(response, 500, { error: "use_tool missing" });
        const transcript = JSON.stringify(parsed.messages);
        const qualifiedName = transcript.match(/[A-Za-z0-9_.-]+__large_image/)?.[0];
        if (!qualifiedName) return json(response, 500, { error: "qualified large_image tool missing", preview: transcript.slice(-4_000) });
        return toolCall(useTool, { tool_name: qualifiedName, tool_input: {} });
      }
      if (foregroundTurns === 3) {
        if (!imageForwardedToModel || !imageTextForwardedToModel) {
          return json(response, 500, { error: "large image MCP result missing" });
        }
      }
      return sse(response, [
        { id, object: "chat.completion.chunk", created: 1, model: "grok-build", choices: [{ index: 0, delta: { role: "assistant", content: "GROX_V1_SMOKE_OK" }, finish_reason: null }] },
        { id, object: "chat.completion.chunk", created: 1, model: "grok-build", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
      ]);
    }
    return json(response, 404, { error: "not found" });
  });
});

await new Promise((resolveReady) => server.listen(0, "127.0.0.1", resolveReady));
const address = server.address();
if (!address || typeof address === "string") throw new Error("无法启动本地推理验证端点");
const baseUrl = `http://127.0.0.1:${address.port}/v1`;

try {
  const child = spawn(process.execPath, [join(root, "scripts", "smoke-grok-v1-acp.mjs")], {
    cwd: root,
    env: {
      ...process.env,
      GROK_HOME: grokHome,
      GROK_CLI_CHAT_PROXY_BASE_URL: baseUrl,
      GROK_XAI_API_BASE_URL: baseUrl,
      XAI_API_KEY: "grox-hermetic-ci-key",
      GROK_TELEMETRY_ENABLED: "false",
      GROK_TRACE_UPLOAD: "false",
      GROK_FEEDBACK_ENABLED: "false",
      GROK_SMOKE_PROMPT: "1",
      GROK_SMOKE_PROMPT_TEXT: "Use the large_image tool exactly once, then reply GROX_V1_SMOKE_OK.",
      GROK_SMOKE_EXPECT_IMAGE: "1",
      GROK_SMOKE_MCP_SCRIPT: join(root, "scripts", "fixtures", "large-image-mcp.mjs"),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const code = await new Promise((resolveExit) => child.once("exit", resolveExit));
  if (code !== 0) throw new Error(`官方 CLI 隔离验证失败（${code}）：${stderr || stdout}\n请求=${JSON.stringify(requests)}`);
  const result = JSON.parse(stdout);
  if (!result.ok || !result.largeMcpImage || !result.sessionForkLoadClose) throw new Error(`验证结果不完整：${stdout}`);
  if (foregroundTurns < 3) throw new Error("MCP 搜索、调用与最终回答链路未完整执行");
  if (!imageForwardedToModel) throw new Error("大型 MCP 图片未进入后续模型请求");
  if (!imageTextForwardedToModel) throw new Error("大型 MCP 图片的配套文本未进入后续模型请求");
  console.log(JSON.stringify({
    ...result,
    hermetic: true,
    platform: process.platform,
    arch: process.arch,
    imageForwardedToModel,
    imageTextForwardedToModel,
    inferenceRequests: requests.map(({ method, url, bytes, toolNames }) => ({ method, url, bytes, toolNames })),
  }, null, 2));
} finally {
  await new Promise((resolveClose) => server.close(resolveClose));
  rmSync(grokHome, { recursive: true, force: true });
}
