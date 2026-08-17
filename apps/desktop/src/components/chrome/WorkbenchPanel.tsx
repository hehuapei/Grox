/* Right workbench: one deterministic home for terminal and parallel tasks. */

import { useState } from "react";
import { useDesktop } from "../../state/store";
import { useI18n } from "../../lib/i18n";
import { Icon } from "../fx/Icon";
import { TerminalPanel } from "../terminal/TerminalPanel";
import { ResizeHandle } from "../common/ResizeHandle";
import { usePreferences } from "../../state/preferences";
import { deriveSessionSnapshot } from "../../lib/sessionRuntime";

type Tab = "terminal" | "side";

export function WorkbenchPanel() {
  const { language } = useI18n();
  const zh = language === "zh-CN";
  const [tab, setTab] = useState<Tab>("terminal");
  const [draft, setDraft] = useState("");
  const [launching, setLaunching] = useState(false);
  const [launchError, setLaunchError] = useState("");
  const toggleTerminal = useDesktop((state) => state.toggleTerminal);
  const activeId = useDesktop((state) => state.activeId);
  const session = useDesktop((state) => (state.activeId ? state.sessions[state.activeId] : null));
  const newSession = useDesktop((state) => state.newSession);
  const running = Object.values(useDesktop((state) => state.sessions)).filter((item) => (
    deriveSessionSnapshot({ status: item.status, blocks: item.blocks }).busy
  )).length;
  const width = usePreferences((state) => state.inspectorWidth);
  const setWidth = usePreferences((state) => state.setInspectorWidth);

  const launchSide = async () => {
    const text = draft.trim();
    if (!text || launching) return;
    const context = session
      ? (zh
          ? `【并行侧任务】主会话 ${session.title} 仍在进行。请独立完成：\n${text}`
          : `[Side agent] Main mission "${session.title}" continues in parallel. Complete independently:\n${text}`)
      : text;
    setLaunching(true);
    setLaunchError("");
    try {
      await newSession({ text: context });
      setDraft("");
    } catch (cause) {
      // 创建失败必须保留用户输入，否则一次运行时故障就会让侧任务草稿消失。
      setLaunchError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setLaunching(false);
    }
  };

  return (
    <>
    <ResizeHandle side="left" value={width} onChange={setWidth} />
    <aside className="flex min-h-0 shrink-0 flex-col overflow-hidden border-l border-line2 bg-void animate-fade-up" style={{ width }}>
      <div className="flex h-11 shrink-0 items-center gap-1 border-b border-line bg-panel px-2">
        <button
          onClick={() => setTab("terminal")}
          role="tab"
          aria-selected={tab === "terminal"}
          className={`flex h-8 items-center gap-1.5 rounded-full px-3 text-[12px] ${tab === "terminal" ? "bg-high text-fg" : "text-dim hover:text-fg2"}`}
        >
          <Icon name="terminal" size={11} />
          {zh ? "终端" : "Terminal"}
        </button>
        <button
          onClick={() => setTab("side")}
          role="tab"
          aria-selected={tab === "side"}
          className={`flex h-8 items-center gap-1.5 rounded-full px-3 text-[12px] ${tab === "side" ? "bg-high text-fg" : "text-dim hover:text-fg2"}`}
        >
          <Icon name="layers" size={11} />
          {zh ? "并行任务" : "Parallel task"}
          {running > 1 && <span className="tnum text-acc">{running}</span>}
        </button>
        <span className="ml-auto" />
        <button
          onClick={toggleTerminal}
          className="flex h-6 w-6 items-center justify-center text-dim hover:bg-high hover:text-fg"
          title={zh ? "关闭工作台" : "Close workbench"}
          aria-label={zh ? "关闭工作台" : "Close workbench"}
        >
          <Icon name="x" size={10} />
        </button>
      </div>

      {tab === "terminal" ? (
        <div className="min-h-0 flex-1 overflow-hidden">
          <TerminalPanel embedded />
        </div>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col gap-3 p-4">
          <p className="text-[12px] leading-relaxed text-dim">
            {zh
              ? "侧任务会新建独立会话并立即发送，主会话可继续运行。适合并行调研、测试或修小问题。"
              : "Side agents open a fresh session and send immediately while the main mission keeps running — useful for research, tests, or small fixes."}
          </p>
          <textarea
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            rows={4}
            placeholder={zh ? "描述侧任务…" : "Describe the side task…"}
            aria-label={zh ? "并行侧任务描述" : "Parallel task description"}
            className="min-h-[160px] flex-1 resize-none rounded-[12px] border border-line2 bg-raise px-3 py-3 text-[13px] leading-relaxed text-fg outline-none placeholder:text-faint focus:border-line3"
          />
          {launchError && <p role="alert" className="text-[10.5px] leading-relaxed text-red">{launchError}</p>}
          <div className="flex items-center justify-between">
            <span className="text-[11px] text-faint">
              {activeId ? (zh ? "基于当前任务" : "From current task") : (zh ? "独立任务" : "Independent task")}
            </span>
            <button
              disabled={!draft.trim() || launching}
              onClick={() => void launchSide()}
              className="flex h-9 items-center gap-1.5 rounded-full bg-acc px-4 text-[12px] font-medium text-base disabled:opacity-35"
            >
              <Icon name="play" size={11} />
              {launching ? (zh ? "正在创建" : "Creating") : (zh ? "开始并行任务" : "Start task")}
            </button>
          </div>
        </div>
      )}
    </aside>
    </>
  );
}
