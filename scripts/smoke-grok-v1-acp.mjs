import { createInterface } from "node:readline";
import { spawn, spawnSync } from "node:child_process";

const command = process.env.GROK_COMMAND || "grok";
const versionRun = spawnSync(command, ["--version"], { encoding: "utf8", shell: process.platform === "win32" });
const versionText = `${versionRun.stdout ?? ""}${versionRun.stderr ?? ""}`.trim();
if (!/\bgrok 1\.0\.0\b/.test(versionText)) throw new Error(`需要官方 grok 1.0.0，实际为：${versionText || "无法执行"}`);

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
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: `Smoke client does not implement ${message.method}` } })}\n`);
    return;
  }
  if (message.method) notifications.push(message.method);
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
      reject: (error) => { clearTimeout(timer); reject(error); },
    });
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
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
  });
  if (!initialized || typeof initialized !== "object") throw new Error("initialize 未返回对象");

  const listed = unwrapExtension(await request("_x.ai/session/list", { cwd: workspace, limit: 5 }));
  if (!listed || typeof listed !== "object" || !Array.isArray(listed.sessions)) throw new Error("x.ai/session/list 返回结构不正确");

  const created = await request("session/new", { cwd: workspace, mcpServers: [], _meta: { reasoningEffort: "low" } }, 45_000);
  const sessionId = created?.sessionId;
  if (typeof sessionId !== "string" || !sessionId) throw new Error("session/new 未返回 sessionId");

  await request("session/close", { sessionId }, 45_000);
  console.log(JSON.stringify({
    ok: true,
    version: versionText,
    initialize: true,
    sessionList: true,
    sessionNew: true,
    sessionClose: true,
    sessionId,
    versionMismatchNotifications: notifications.filter((method) => method.includes("version_mismatch")).length,
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
