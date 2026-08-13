import { useMemo, useState } from "react";
import { useDesktop } from "../../state/store";
import { nextAutomationRun, type AutomationFrequency } from "../../lib/automations";
import { ConfirmDialog } from "../common/ConfirmDialog";
import { Icon } from "../fx/Icon";
import { useI18n } from "../../lib/i18n";

function id() {
  return crypto.randomUUID?.() ?? `automation-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export function AutomationsStudio() {
  const { language } = useI18n();
  const zh = language === "zh-CN";
  const automations = useDesktop((state) => state.automations);
  const runningId = useDesktop((state) => state.automationRunningId);
  const workspace = useDesktop((state) => state.workspace);
  const model = useDesktop((state) => state.model);
  const effort = useDesktop((state) => state.effort);
  const mode = useDesktop((state) => state.mode);
  const permissionMode = useDesktop((state) => state.permissionMode);
  const save = useDesktop((state) => state.saveAutomation);
  const remove = useDesktop((state) => state.deleteAutomation);
  const setEnabled = useDesktop((state) => state.setAutomationEnabled);
  const run = useDesktop((state) => state.runAutomation);
  const [title, setTitle] = useState("");
  const [prompt, setPrompt] = useState("");
  const [frequency, setFrequency] = useState<AutomationFrequency>("daily");
  const [time, setTime] = useState("09:00");
  const [weekday, setWeekday] = useState(new Date().getDay());
  const [deleteId, setDeleteId] = useState<string | null>(null);

  const sorted = useMemo(() => [...automations].sort((a, b) => a.nextRunAt - b.nextRunAt), [automations]);
  const create = () => {
    const cleanTitle = title.trim();
    const cleanPrompt = prompt.trim();
    if (!cleanTitle || !cleanPrompt) return;
    save({
      id: id(),
      title: cleanTitle,
      prompt: cleanPrompt,
      cwd: workspace,
      model,
      effort,
      mode,
      permissionMode,
      frequency,
      time,
      ...(frequency === "weekly" ? { weekday } : {}),
      enabled: true,
      nextRunAt: nextAutomationRun(frequency, time, Date.now(), weekday),
    });
    setTitle("");
    setPrompt("");
  };

  return (
    <div className="relative z-[1] mx-auto flex min-h-0 w-full max-w-[980px] flex-1 flex-col overflow-y-auto px-6 pb-10 pt-20 sm:px-10">
      <header className="mb-6">
        <p className="font-mono text-[10px] tracking-[0.16em] text-acc">SCHEDULED WORK</p>
        <h1 className="mt-2 text-[26px] font-semibold text-fg">{zh ? "已安排" : "Automations"}</h1>
        <p className="mt-2 max-w-2xl text-[12px] leading-relaxed text-mute">
          {zh
            ? "任务在 Grox 进程存活时每 30 秒检查一次；流式会话、权限门禁、恢复和停止期间不会抢跑。完全退出应用后不会假装继续执行。"
            : "Due tasks are checked every 30 seconds while Grox is running. Busy turns and human gates are never pre-empted; fully quitting pauses schedules."}
        </p>
      </header>

      <section className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_330px]">
        <div className="space-y-2">
          {sorted.length === 0 ? (
            <div className="rounded-[14px] border border-dashed border-line2 bg-raise/40 p-8 text-center text-[12px] text-dim">
              {zh ? "还没有已安排任务。右侧创建的任务会在独立后台会话中运行。" : "No scheduled work yet. New tasks run in independent background sessions."}
            </div>
          ) : sorted.map((automation) => (
            <article key={automation.id} className="rounded-[12px] border border-line2 bg-raise/65 p-4">
              <div className="flex items-start gap-3">
                <button
                  onClick={() => setEnabled(automation.id, !automation.enabled)}
                  className={`mt-1 h-2.5 w-2.5 shrink-0 rounded-full ${automation.enabled ? "bg-green" : "bg-faint"}`}
                  title={automation.enabled ? (zh ? "暂停" : "Pause") : (zh ? "启用" : "Enable")}
                />
                <div className="min-w-0 flex-1">
                  <h2 className="truncate text-[13px] font-medium text-fg2">{automation.title}</h2>
                  <p className="mt-1 line-clamp-2 text-[11px] leading-relaxed text-mute">{automation.prompt}</p>
                  <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 font-mono text-[9.5px] text-faint">
                    <span>{scheduleLabel(automation.frequency, automation.time, automation.weekday, zh)}</span>
                    <span>{automation.enabled ? `${zh ? "下次" : "Next"} ${new Date(automation.nextRunAt).toLocaleString()}` : (zh ? "已暂停" : "Paused")}</span>
                    {automation.lastSessionId && <span>{zh ? "会话" : "Session"} {automation.lastSessionId.slice(0, 8)}</span>}
                  </div>
                  {automation.lastError && <p className="mt-2 text-[10px] text-red">{automation.lastError}</p>}
                </div>
                <button
                  onClick={() => void run(automation.id)}
                  disabled={!automation.enabled || Boolean(runningId)}
                  className="flex h-7 items-center gap-1 rounded-full border border-line2 px-2.5 text-[9.5px] text-fg2 hover:border-line3 disabled:opacity-40"
                >
                  <Icon name="play" size={9} />
                  {runningId === automation.id ? (zh ? "启动中" : "Starting") : (zh ? "立即运行" : "Run now")}
                </button>
                <button onClick={() => setDeleteId(automation.id)} className="flex h-7 w-7 items-center justify-center text-faint hover:text-red" title={zh ? "删除" : "Delete"}>
                  <Icon name="trash" size={10} />
                </button>
              </div>
            </article>
          ))}
        </div>

        <aside className="h-fit rounded-[14px] border border-line2 bg-panel/80 p-4">
          <h2 className="text-[13px] font-medium text-fg2">{zh ? "创建自动化" : "Create automation"}</h2>
          <label className="mt-4 block text-[10px] text-dim">{zh ? "标题" : "Title"}</label>
          <input value={title} onChange={(event) => setTitle(event.target.value)} className="mt-1 h-9 w-full rounded-[6px] border border-line2 bg-base px-3 text-[12px] text-fg outline-none focus:border-acc/50" />
          <label className="mt-3 block text-[10px] text-dim">{zh ? "指令" : "Prompt"}</label>
          <textarea value={prompt} onChange={(event) => setPrompt(event.target.value)} rows={5} className="mt-1 w-full resize-y rounded-[6px] border border-line2 bg-base px-3 py-2 text-[12px] leading-relaxed text-fg outline-none focus:border-acc/50" />
          <div className="mt-3 grid grid-cols-2 gap-2">
            <select value={frequency} onChange={(event) => setFrequency(event.target.value as AutomationFrequency)} className="h-9 rounded-[6px] border border-line2 bg-base px-2 text-[11px] text-fg2">
              <option value="once">{zh ? "仅一次" : "Once"}</option>
              <option value="daily">{zh ? "每天" : "Daily"}</option>
              <option value="weekdays">{zh ? "工作日" : "Weekdays"}</option>
              <option value="weekly">{zh ? "每周" : "Weekly"}</option>
            </select>
            <input type="time" value={time} onChange={(event) => setTime(event.target.value)} className="h-9 rounded-[6px] border border-line2 bg-base px-2 text-[11px] text-fg2" />
          </div>
          {frequency === "weekly" && (
            <select value={weekday} onChange={(event) => setWeekday(Number(event.target.value))} className="mt-2 h-9 w-full rounded-[6px] border border-line2 bg-base px-2 text-[11px] text-fg2">
              {(zh ? ["周日", "周一", "周二", "周三", "周四", "周五", "周六"] : ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"]).map((label, index) => <option key={label} value={index}>{label}</option>)}
            </select>
          )}
          <p className="mt-3 truncate font-mono text-[9.5px] text-faint" title={workspace}>{workspace}</p>
          <button onClick={create} disabled={!title.trim() || !prompt.trim()} className="mt-4 h-9 w-full rounded-full bg-acc text-[11px] font-medium text-base hover:bg-acc-deep disabled:opacity-40">
            {zh ? "创建并启用" : "Create and enable"}
          </button>
        </aside>
      </section>

      {deleteId && (
        <ConfirmDialog
          title={zh ? "删除自动化？" : "Delete automation?"}
          description={zh ? "任务及其排程会被删除，已经生成的会话仍会保留。" : "The schedule will be removed; previously created sessions remain."}
          confirmLabel={zh ? "删除" : "Delete"}
          cancelLabel={zh ? "取消" : "Cancel"}
          workingLabel={zh ? "删除中" : "Deleting"}
          onCancel={() => setDeleteId(null)}
          onConfirm={async () => { remove(deleteId); setDeleteId(null); }}
        />
      )}
    </div>
  );
}

function scheduleLabel(frequency: AutomationFrequency, time: string, weekday: number | undefined, zh: boolean) {
  if (frequency === "once") return `${zh ? "仅一次" : "Once"} · ${time}`;
  if (frequency === "daily") return `${zh ? "每天" : "Daily"} · ${time}`;
  if (frequency === "weekdays") return `${zh ? "工作日" : "Weekdays"} · ${time}`;
  const labels = zh ? ["周日", "周一", "周二", "周三", "周四", "周五", "周六"] : ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  return `${zh ? "每周" : "Weekly"} ${labels[weekday ?? 0]} · ${time}`;
}
