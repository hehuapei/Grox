import http from "node:http";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const grokHome = mkdtempSync(join(tmpdir(), "grox-v1-hermetic-home-"));
const smokeWorkspace = mkdtempSync(join(tmpdir(), "grox-v1-hermetic-workspace-"));
const requests = [];
let foregroundTurns = 0;
let imageForwardedToModel = false;
let imageTextForwardedToModel = false;
const expectedTitle = "Grox V1 Hermetic Integration";

function preservedEnvironment() {
  // Use an allowlist instead of cloning process.env. In particular, never
  // inherit GROK_CONFIG/GROK_CONFIG_PATH or model, plugin, provider, and
  // reasoning-effort knobs that could make this fixture non-hermetic.
  const keep = [
    "PATH", "Path", "GROK_COMMAND", "GROK_EXPECTED_VERSION",
    "SYSTEMROOT", "SystemRoot", "COMSPEC", "ComSpec", "PATHEXT", "WINDIR",
    "HOME", "USERPROFILE", "TMPDIR", "TMP", "TEMP",
  ];
  return Object.fromEntries(keep.flatMap((key) => process.env[key] === undefined ? [] : [[key, process.env[key]]]));
}

function resolveExecutable(command) {
  const candidates = isAbsolute(command) || command.includes("/") || command.includes("\\")
    ? [resolve(command)]
    : (process.env.PATH ?? process.env.Path ?? "").split(delimiter).flatMap((directory) => {
        if (!directory) return [];
        const base = join(directory, command);
        return process.platform === "win32" && !command.toLowerCase().endsWith(".exe")
          ? [base, `${base}.exe`]
          : [base];
      });
  for (const candidate of candidates) {
    try { return realpathSync(candidate); } catch { /* try the next PATH entry */ }
  }
  throw new Error(`无法解析 Grok executable：${command}`);
}

function json(response, status, value) {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(value));
}

function responsesToolCall(response, title) {
  const callId = "call_grox_session_title";
  const argumentsJson = JSON.stringify({ session_title: title });
  sse(response, [
    {
      type: "response.created",
      sequence_number: 0,
      response: {
        id: "resp_grox_session_title",
        object: "response",
        created_at: 1,
        model: "grok-build",
        status: "in_progress",
        output: [],
      },
    },
    {
      type: "response.function_call_arguments.delta",
      sequence_number: 1,
      item_id: callId,
      output_index: 0,
      delta: argumentsJson,
    },
    {
      type: "response.completed",
      sequence_number: 2,
      response: {
        id: "resp_grox_session_title",
        object: "response",
        created_at: 1,
        model: "grok-build",
        status: "completed",
        output: [{ type: "function_call", call_id: callId, name: "session_title", arguments: argumentsJson }],
        usage: {
          input_tokens: 10,
          output_tokens: 5,
          total_tokens: 15,
          input_tokens_details: { cached_tokens: 0 },
          output_tokens_details: { reasoning_tokens: 0 },
        },
      },
    },
  ]);
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
    requests.at(-1).reasoningEffort = parsed.reasoning_effort ?? parsed.reasoningEffort;
    requests.at(-1).initialPromptMarker = body.includes("GROX_V1_SMOKE_OK") && !body.includes("GROX_V1_RESUME_OK");
    requests.at(-1).resumePromptMarker = body.includes("GROX_V1_RESUME_OK");
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
    if (request.method === "POST" && request.url === "/v1/responses") {
      const titleTool = Array.isArray(parsed.tools)
        && parsed.tools.some((tool) => (tool?.function?.name ?? tool?.name) === "session_title");
      if (!titleTool) return json(response, 400, { error: "unexpected non-title Responses API request" });
      return responsesToolCall(response, expectedTitle);
    }
    if (request.method === "POST" && request.url === "/v1/chat/completions") {
      if (body.includes("data:image/")) imageForwardedToModel = true;
      // Grok Build may replace the text immediately before an image with its ACP
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
      const reply = body.includes("GROX_V1_RESUME_OK") ? "GROX_V1_RESUME_OK" : "GROX_V1_SMOKE_OK";
      return sse(response, [
        { id, object: "chat.completion.chunk", created: 1, model: "grok-build", choices: [{ index: 0, delta: { role: "assistant", content: reply }, finish_reason: null }] },
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
    cwd: smokeWorkspace,
    env: {
      ...preservedEnvironment(),
      HOME: grokHome,
      USERPROFILE: grokHome,
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
      GROK_SMOKE_EXPECT_TITLE: expectedTitle,
      GROK_SMOKE_ASSERT_CLEAN_ENV: "1",
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
  if (!result.ok || !result.largeMcpImage || !result.sessionForkLoadClose || !result.resumeContinuation || !result.sessionSummaryGenerated || !result.environmentIsolated) throw new Error(`验证结果不完整：${stdout}`);
  if (foregroundTurns < 3) throw new Error("MCP 搜索、调用与最终回答链路未完整执行");
  if (!imageForwardedToModel) throw new Error("大型 MCP 图片未进入后续模型请求");
  if (!imageTextForwardedToModel) throw new Error("大型 MCP 图片的配套文本未进入后续模型请求");
  const responsesTitleRequests = requests.filter(({ url }) => url === "/v1/responses").length;
  const initialPromptRequests = requests.filter(({ url, initialPromptMarker, resumePromptMarker }) =>
    url === "/v1/chat/completions" && initialPromptMarker && !resumePromptMarker);
  const resumePromptRequests = requests.filter(({ url, resumePromptMarker }) =>
    url === "/v1/chat/completions" && resumePromptMarker);
  const initialPromptReasoningEffortForwarded = initialPromptRequests.length > 0
    && initialPromptRequests.every(({ reasoningEffort }) => reasoningEffort === "low");
  const resumeReasoningEffortForwarded = resumePromptRequests.length > 0
    && resumePromptRequests.every(({ reasoningEffort }) => reasoningEffort === "high");
  if (!initialPromptReasoningEffortForwarded) {
    throw new Error(`初始 prompt 的唯一标记请求未全部使用 low：${JSON.stringify(initialPromptRequests)}`);
  }
  if (!resumeReasoningEffortForwarded) {
    throw new Error(`恢复 prompt 的唯一 GROX_V1_RESUME_OK 标记请求未全部使用 high：${JSON.stringify(resumePromptRequests)}`);
  }
  if (!result.sessionSummaryTitles.includes(expectedTitle)) {
    throw new Error(`真实 CLI 未发出预期 session_summary_generated：${JSON.stringify(result.sessionSummaryTitles)}`);
  }
  const grokExecutable = resolveExecutable(process.env.GROK_COMMAND?.trim() || "grok");
  const grokSha256 = createHash("sha256").update(readFileSync(grokExecutable)).digest("hex");
  const groxCommit = spawnSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).stdout.trim();
  if (!/^[0-9a-f]{40}$/.test(groxCommit)) throw new Error(`无法记录 Grox SHA：${groxCommit}`);
  const report = {
    ...result,
    hermetic: true,
    platform: process.platform,
    arch: process.arch,
    imageForwardedToModel,
    imageTextForwardedToModel,
    sessionSummaryNotificationIntegrated: true,
    expectedTitle,
    responsesTitleRequests,
    initialPromptReasoningEffortForwarded,
    resumeReasoningEffortForwarded,
    groxCommit,
    grokExecutable,
    grokSha256,
    inferenceRequests: requests.map(({ method, url, bytes, toolNames, reasoningEffort, initialPromptMarker, resumePromptMarker }) => ({
      method, url, bytes, toolNames, reasoningEffort, initialPromptMarker, resumePromptMarker,
    })),
  };
  const outputPath = process.env.GROK_SMOKE_OUTPUT?.trim();
  if (outputPath) writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  console.log(JSON.stringify(report, null, 2));
} finally {
  await new Promise((resolveClose) => server.close(resolveClose));
  rmSync(grokHome, { recursive: true, force: true });
  rmSync(smokeWorkspace, { recursive: true, force: true });
}
