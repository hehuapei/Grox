import { useDesktop } from "../../state/store";
import { Icon } from "../fx/Icon";

export function RuntimeNotice() {
  const notice = useDesktop((state) => state.runtimeNotices[0]);
  const dismiss = useDesktop((state) => state.dismissRuntimeNotice);
  if (!notice) return null;
  const error = notice.level === "error";

  return (
    <div className={`flex min-h-9 items-center gap-2 border-b px-3 ${error ? "border-red/25 bg-red/[0.07] text-red" : "border-gold/25 bg-gold/[0.07] text-gold"}`}>
      <Icon name="bolt" size={12} className="shrink-0" />
      <span className="shrink-0 font-mono text-[10px] font-medium tracking-[0.05em]">{notice.title}</span>
      <span className="min-w-0 flex-1 truncate text-[10.5px] text-fg2" title={notice.message}>{notice.message}</span>
      <button
        onClick={() => dismiss(notice.id)}
        className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-[4px] ${error ? "text-red/70 hover:bg-red/10 hover:text-red" : "text-gold/70 hover:bg-gold/10 hover:text-gold"}`}
        aria-label="关闭运行时提示"
      >
        <Icon name="x" size={9} />
      </button>
    </div>
  );
}
