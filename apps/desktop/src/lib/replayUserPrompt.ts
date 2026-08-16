/** 把传输层深度研究命令还原为用户实际发出的可见指令。 */
function displayDeepResearchPrompt(text: string): string {
  const match = text.trim().match(/^\/workflow\s+grox-deep-research\s+([\s\S]+)$/i);
  if (!match) {
    const leaked = text.search(/\/workflow\s+(?:grox-deep-research|(?:pause|resume|stop)\s+\S+)\b/i);
    return leaked > 0 ? text.slice(0, leaked).trimEnd() : text;
  }
  try {
    const args = JSON.parse(match[1]) as { query?: unknown };
    return typeof args.query === "string" ? `/deep-research${args.query ? ` ${args.query}` : ""}` : text;
  } catch {
    return text;
  }
}

function interruptedUserQuery(text: string): string | null {
  const match = text.trim().match(
    /^The user interrupted the previous turn:\s*<user_query>\s*([\s\S]*?)\s*<\/user_query>\s*Make sure to complete any unfinished tasks from previous turns\.?$/i,
  );
  return match ? (match[1]?.trim() ?? "") : null;
}

/** Grok Build 回放的模型输入信封不是用户消息，所有历史入口统一在这里过滤。 */
export function displayReplayUserPrompt(text: string): string {
  const trimmed = text.trim();
  // 在线 ACP 回放还会包含这条合成续传输入；真实用户块由桌面 journal 保留。
  if (interruptedUserQuery(trimmed) !== null) return "";
  if (/^<(?:user_info|git_status|rules)>[\s\S]*<\/(?:user_info|git_status|rules)>/i.test(trimmed)) {
    return "";
  }
  if (/^<user_query>[\s\S]*<\/user_query>$/i.test(trimmed)) {
    return "";
  }
  return displayDeepResearchPrompt(text);
}

/**
 * chat_history.jsonl 中的 user_query 信封是持久化的真实用户输入；中断后的
 * 下一条输入还会被 CLI 包在恢复说明里。磁盘恢复必须还原正文，而不是把
 * 协议信封显示给用户或直接丢掉整条消息。
 */
export function displayDiskUserPrompt(text: string): string {
  const trimmed = text.trim();
  const interrupted = interruptedUserQuery(trimmed);
  if (interrupted !== null) return interrupted;
  const query = trimmed.match(/^<user_query>\s*([\s\S]*?)\s*<\/user_query>$/i);
  if (query) return query[1]?.trim() ?? "";
  return displayReplayUserPrompt(text);
}
