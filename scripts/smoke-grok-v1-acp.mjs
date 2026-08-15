import { createInterface } from "node:readline";
import { spawn, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const command = process.env.GROK_COMMAND || "grok";
const integrationState = JSON.parse(readFileSync(
  new URL("../.grox/official-cli.json", import.meta.url),
  "utf8",
));
const expectedVersion = process.env.GROK_EXPECTED_VERSION
  || integrationState.integrationTarget?.publicVersion;
if (typeof expectedVersion !== "string" || !expectedVersion) {
  throw new Error(".grox/official-cli.json 缺少 integrationTarget.publicVersion");
}
const versionRun = spawnSync(command, ["--version"], { encoding: "utf8", shell: process.platform === "win32" });
const versionText = `${versionRun.stdout ?? ""}${versionRun.stderr ?? ""}`.trim();
if (!new RegExp(`\\bgrok ${expectedVersion.replaceAll(".", "\\.")}\\b`).test(versionText)) {
  throw new Error(`需要官方 grok ${expectedVersion}，实际为：${versionText || "无法执行"}`);
}

const workspace = process.cwd();
const child = spawn(command, ["agent", "stdio"], {
  cwd: workspace,
  stdio: ["pipe", "pipe", "pipe"],
  shell: false,
  env: { ...process.env, NO_COLOR: "1" },
});
const lines = createInterface({ input: child.stdout });
let requestId = 0;
const pending = new Map();
const notifications = [];
let permissionRequests = 0;
let stderr = "";
child.stderr.on("data", (chunk) => { stderr = `${stderr}${chunk}`.slice(-16_000); });

lines.on("line", (line) => {
  let message;
  try { message = JSON.parse(line); } catch { return; }
  if (message.id !== undefined && !message.method) {
    const waiter = pending.get(message.id);
    if (!waiter) return;
    pending.delete(message.id);
    message.error ? waiter.reject(new Error(JSON.stringify(message.error))) : waiter.resolve(message.result);
    return;
  }
  if (message.method && message.id !== undefined) {
    if (message.method === "session/request_permission") {
      permissionRequests += 1;
      const options = Array.isArray(message.params?.options) ? message.params.options : [];
      const allowed = options.find((option) => option?.kind === "allow_once")
        ?? options.find((option) => /allow|approve/i.test(`${option?.optionId ?? ""} ${option?.name ?? ""}`));
      if (!allowed?.optionId) {
        child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: message.id, error: { code: -32602, message: "No allow-once permission option" } })}\n`);
      } else {
        child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { outcome: { outcome: "selected", optionId: allowed.optionId } } })}\n`);
      }
      return;
    }
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: `Smoke client does not implement ${message.method}` } })}\n`);
    return;
  }
  if (message.method) notifications.push(message);
});

function request(method, params, timeoutMs = 20_000) {
  const id = ++requestId;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`${method} timeout; stderr=${stderr}`));
    }, timeoutMs);
    pending.set(id, {
      resolve: (value) => { clearTimeout(timer); resolve(value); },
      reject: (error) => { clearTimeout(timer); reject(new Error(`${method}: ${error instanceof Error ? error.message : String(error)}`)); },
    });
    const wireMethod = method.startsWith("x.ai/") ? `_${method}` : method;
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method: wireMethod, params })}\n`);
  });
}

function unwrapExtension(value) {
  return value && typeof value === "object" && "result" in value ? value.result : value;
}

try {
  const initialized = await request("initialize", {
    protocolVersion: 1,
    clientCapabilities: { fs: { readTextFile: true, writeTextFile: true }, terminal: false },
    clientInfo: { name: "grok-shell", title: "Grox v1 smoke", version: "1.0.0" },
    _meta: { clientIdentifier: "grok-shell", clientType: "shell", clientVersion: "1.0.0" },
  }, 45_000);
  if (!initialized || typeof initialized !== "object") throw new Error("initialize 未返回对象");
  const authMethods = Array.isArray(initialized.authMethods) ? initialized.authMethods : [];
  const firstAuthId = authMethods[0]?.id;
  if (firstAuthId === "grok.com" || firstAuthId === "oidc") {
    throw new Error("在线 smoke 需要先在 Grox 中完成显式登录；脚本不会擅自打开 OAuth");
  }
  const defaultAuthId = initialized?._meta?.defaultAuthMethodId;
  const authMethodId = authMethods.some((method) => method?.id === defaultAuthId)
    ? defaultAuthId
    : firstAuthId;
  if (typeof authMethodId === "string" && authMethodId) {
    await request("authenticate", { methodId: authMethodId }, 30_000);
  }

  const listed = unwrapExtension(await request("x.ai/session/list", { cwd: workspace, limit: 5 }));
  if (!listed || typeof listed !== "object" || !Array.isArray(listed.sessions)) throw new Error("x.ai/session/list 返回结构不正确");

  const mcpServers = process.env.GROK_SMOKE_MCP_SCRIPT
    ? [{ name: "grox-large-image", command: process.execPath, args: [resolve(process.env.GROK_SMOKE_MCP_SCRIPT)], env: [] }]
    : [];
  const created = await request("session/new", {
    cwd: workspace,
    mcpServers,
    _meta: { reasoningEffort: "low", modelId: process.env.GROK_SMOKE_MODEL || "grok-build" },
  }, 60_000);
  const sessionId = created?.sessionId;
  if (typeof sessionId !== "string" || !sessionId) throw new Error("session/new 未返回 sessionId");

  const infoBefore = unwrapExtension(await request("x.ai/session/info", { sessionId }, 30_000));
  if (infoBefore?.sessionId !== sessionId) throw new Error("x.ai/session/info 未返回当前会话");
  await request("session/set_model", {
    sessionId,
    modelId: process.env.GROK_SMOKE_MODEL || "grok-build",
    _meta: { reasoningEffort: "low" },
  });
  await request("session/set_mode", { sessionId, modeId: "plan" });
  await request("session/set_mode", { sessionId, modeId: "default" });

  let mcp = unwrapExtension(await request("x.ai/mcp/list", { sessionId, cache: true }, 45_000));
  if (!mcp || !Array.isArray(mcp.servers)) throw new Error("x.ai/mcp/list 返回结构不正确");
  if (mcpServers.length > 0) {
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline && !JSON.stringify(mcp).includes("large_image")) {
      await new Promise((resolveWait) => setTimeout(resolveWait, 250));
      mcp = unwrapExtension(await request("x.ai/mcp/list", { sessionId, cache: true }, 10_000));
    }
    if (!JSON.stringify(mcp).includes("large_image")) throw new Error(`MCP 工具未完成连接：${JSON.stringify(mcp)}`);
  }
  const skills = unwrapExtension(await request("x.ai/skills/list", { cwd: workspace }, 30_000));
  if (!skills || !Array.isArray(skills.skills)) throw new Error("x.ai/skills/list 返回结构不正确");
  const workflows = unwrapExtension(await request("x.ai/workflows/list", { sessionId }, 30_000));
  if (!workflows || !Array.isArray(workflows.workflows)) throw new Error("x.ai/workflows/list 返回结构不正确");

  let prompt = false;
  let largeMcpImage = false;
  if (process.env.GROK_SMOKE_PROMPT === "1") {
    const result = await request("session/prompt", {
      sessionId,
      prompt: [{ type: "text", text: process.env.GROK_SMOKE_PROMPT_TEXT || "只回复 GROX_V1_SMOKE_OK，不要使用工具。" }],
    }, 120_000);
    const transcript = JSON.stringify([result, notifications]);
    if (!transcript.includes("GROX_V1_SMOKE_OK")) throw new Error("在线 prompt 未返回约定文本");
    prompt = true;
    if (process.env.GROK_SMOKE_EXPECT_IMAGE === "1") {
      // 1.0.3 会把 ACP 回放中的图片内容替换为占位符；外层隔离验证仍会
      // 从实际模型请求确认 data:image 与原始文本均已被转发。
      const imageResultVisible = transcript.includes("GROX_LARGE_IMAGE_OK")
        || transcript.includes("[image content will be provided separately]");
      if (!imageResultVisible) throw new Error("大型 MCP 图片工具未成功执行");
      largeMcpImage = true;
    }
  }

  const infoAfter = unwrapExtension(await request("x.ai/session/info", { sessionId }, 30_000));
  if (prompt && !(Number(infoAfter?.turns) >= 1)) throw new Error("在线 prompt 后 session info 未推进 turns");

  const forked = unwrapExtension(await request("x.ai/session/fork", {
    sourceSessionId: sessionId,
    sourceCwd: workspace,
    newCwd: workspace,
  }, 60_000));
  const forkedSessionId = forked?.newSessionId;
  if (typeof forkedSessionId !== "string" || !forkedSessionId) throw new Error("x.ai/session/fork 未返回新会话 ID");
  await request("session/load", { sessionId: forkedSessionId, cwd: workspace, mcpServers: [] }, 60_000);
  await request("session/close", { sessionId: forkedSessionId }, 45_000);
  await request("session/close", { sessionId }, 45_000);
  console.log(JSON.stringify({
    ok: true,
    version: versionText,
    initialize: true,
    authenticate: authMethodId || "not_required",
    sessionList: true,
    sessionNew: true,
    sessionInfo: true,
    modelEffortBound: true,
    modePlanAgent: true,
    mcpList: true,
    skillsList: true,
    workflowsList: true,
    prompt,
    largeMcpImage,
    sessionForkLoadClose: true,
    sessionClose: true,
    sessionId,
    forkedSessionId,
    versionMismatchNotifications: notifications.filter((message) => message.method.includes("version_mismatch")).length,
    permissionRequests,
  }, null, 2));
} finally {
  lines.close();
  child.stdin.end();
  if (child.exitCode === null) {
    await Promise.race([
      new Promise((resolve) => child.once("exit", resolve)),
      new Promise((resolve) => setTimeout(resolve, 2_000)),
    ]);
  }
  if (child.exitCode === null) child.kill();
}
