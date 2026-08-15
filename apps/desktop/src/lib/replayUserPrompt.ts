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

/** Grok Build 回放的模型输入信封不是用户消息，所有历史入口统一在这里过滤。 */
export function displayReplayUserPrompt(text: string): string {
  const trimmed = text.trim();
  if (/^<(?:user_info|git_status|rules)>[\s\S]*<\/(?:user_info|git_status|rules)>/i.test(trimmed)) {
    return "";
  }
  if (/^<user_query>[\s\S]*<\/user_query>$/i.test(trimmed)) {
    return "";
  }
  return displayDeepResearchPrompt(text);
}
