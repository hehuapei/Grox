import type { ToolKind } from "../bridge/types";

const TOOL_KINDS = new Set<ToolKind>([
  "read", "edit", "delete", "list_dir", "write", "move", "search", "lsp", "execute",
  "plan", "web_search", "web_fetch", "background_task_action", "wait_tasks_action",
  "kill_task_action", "list", "skill", "memory_search", "memory_get", "task", "enter_plan",
  "exit_plan", "ask_user", "image_gen", "video_gen", "image_to_video", "reference_to_video", "computer",
  "deploy_app", "search_tool", "use_tool", "monitor", "goal_update", "terminal", "web",
  "think", "switch_mode", "voice", "finance", "other",
]);

const stringValue = (value: unknown) => typeof value === "string" ? value : undefined;

/** Keep live ACP events and durable CLI history on the same tool taxonomy. */
export function mapToolKind(kindValue: unknown, titleValue: unknown): ToolKind {
  const exact = (stringValue(kindValue) ?? "").toLowerCase();
  if (TOOL_KINDS.has(exact as ToolKind)) return exact as ToolKind;
  if (exact === "fetch") return "web_fetch";
  const rawSource = `${exact} ${stringValue(titleValue) ?? ""}`.toLowerCase();
  // Grok tool names are usually snake_case. JavaScript treats `_` as a word
  // character, so regex word boundaries alone would miss `read_file`.
  const source = rawSource.replace(/[_./:-]+/g, " ");
  if (/\b(voice|speech|audio|transcri(?:be|ption))\b/.test(source)) return "voice";
  if (/\b(finance|market|stock|quote|ticker)\b/.test(source)) return "finance";
  if (
    /\bcomputer_(screenshot|mouse|click|drag|scroll|key|type|wait)\b/.test(rawSource) ||
    (
      /\bcomputer\b/.test(source) &&
      /\b(list_(apps|windows)|start|pause|resume|stop|get_window_state|activate_window|click|double_click|perform_secondary_action|scroll|press_key|type_text|set_value|drag|wait)\b/.test(source)
    )
  ) return "computer";
  if (/\bgoal\b/.test(source)) return "goal_update";
  if (/\bworkflow\b/.test(source)) return "task";
  if (/\b(read|view|cat)\b/.test(source)) return "read";
  if (/\b(delete|remove|unlink)\b/.test(source)) return "delete";
  if (/\b(move|rename)\b/.test(source)) return "move";
  if (/\b(edit|write|patch|replace)\b/.test(source)) return "edit";
  if (/\b(execute|terminal|shell|bash|command|process)\b/.test(source)) return "execute";
  if (/\b(web|fetch|browser|url)\b/.test(source)) return "web_fetch";
  if (/\b(search|grep|find|glob)\b/.test(source)) return "search";
  if (/\b(task|agent|todo|plan)\b/.test(source)) return "task";
  if (/\b(think|reason)\b/.test(source)) return "think";
  return "other";
}
