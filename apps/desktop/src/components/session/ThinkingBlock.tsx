/* ─────────────────────────────────────────────────────────────────────────
   Thinking block — Grok's reasoning.
   Streams open so the reasoning is visible as it arrives; folds to one quiet
   preview line once done, expandable on demand.
   ───────────────────────────────────────────────────────────────────────── */

import { useState } from "react";
import type { SessionBlock } from "../../bridge/types";
import { thinkingIsLive } from "../../lib/processFold";
import { fmtDuration } from "../../lib/format";
import { Icon } from "../fx/Icon";
import { BlackHole } from "../fx/BlackHole";
import { useI18n } from "../../lib/i18n";

type ThinkingBlock = Extract<SessionBlock, { type: "thinking" }>;

export function ThinkingBlock({ block, processing }: { block: ThinkingBlock; processing?: boolean }) {
  const { language } = useI18n();
  // null 表示跟随默认策略；用户点击后固定为显式选择。
  const [open, setOpen] = useState<boolean | null>(null);
  const live = thinkingIsLive(block, processing);
  const visibleText = block.text;
  const preview = visibleText.replace(/\s+/g, " ").trim();
  // 流式过程中默认展开：逐字动画和闪烁光标就是为这个状态写的，折叠起来
  // 用户只能看到一行截断预览，会以为模型根本没有思考。结束后收回预览行，
  // 但用户的显式选择始终优先。
  const expanded = open ?? live;

  return (
    <div className="process-thinking mb-3 animate-fade-up">
      <button
        onClick={() => setOpen(!expanded)}
        className="flex min-h-7 w-full items-center gap-2 text-left"
      >
        <span className={`process-node ${live ? "is-live" : "is-done"}`} aria-hidden="true" />
        <BlackHole size={13} spin={live} />
        <span className={`shrink-0 text-[10.5px] font-medium ${live ? "text-fg2" : "text-dim"}`}>
          {live
            ? language === "zh-CN" ? "思考中" : "THINKING"
            : `${language === "zh-CN" ? "思考" : "THOUGHT"}${block.elapsedMs ? ` · ${fmtDuration(block.elapsedMs).toUpperCase()}` : ""}`}
        </span>
        {live && <span className="h-1 w-1 animate-pulse-dot rounded-full bg-acc" />}
        {!expanded && preview && (
          <span className="min-w-0 flex-1 truncate text-[11px] text-faint" title={preview}>
            {preview}
            {live && <span className="ml-1 inline-block h-2.5 w-[5px] animate-blink bg-acc-dim align-[-1px]" />}
          </span>
        )}
        {(expanded || !preview) && <span className="flex-1" />}
        <Icon
          name="chevronRight"
          size={11}
          className={`text-faint transition-transform duration-150 ${expanded ? "rotate-90" : ""}`}
        />
      </button>
      {expanded && visibleText && (
        <div className="ml-[6px] mt-1 max-h-[300px] overflow-y-auto whitespace-pre-wrap break-words border-l border-line2 pb-1 pl-6 text-[12.5px] leading-[1.72] text-mute select-text">
          {visibleText}
          {live && <span className="ml-0.5 inline-block h-3 w-[6px] animate-blink bg-acc-dim align-[-1px]" />}
        </div>
      )}
    </div>
  );
}
