/* ─────────────────────────────────────────────────────────────────────────
   Home — mission control. Deep field, the orbital mark, one input, and
   the last few missions. Everything else is silence.
   ───────────────────────────────────────────────────────────────────────── */

import { useRef, useState } from "react";
import { useDesktop } from "../../state/store";
import type { PromptAttachment } from "../../bridge/types";
import { fmtRelTime, fmtTokens } from "../../lib/format";
import { MAX_ATTACHMENTS, prepareAttachment, validateAttachmentSet } from "../../lib/attachments";
import { attachExplicitPromptImages } from "../../lib/pathAttachments";
import { BlackHole } from "../fx/BlackHole";
import { Starfield } from "../fx/Starfield";
import { Icon } from "../fx/Icon";
import { ChipSelect } from "../common/ChipSelect";
import { PromptOptionsMenu, ProviderSwitcher } from "../common/PromptControls";
import { useI18n } from "../../lib/i18n";
import { MediaStudio } from "./MediaStudio";

export function Home() {
  const { language, t } = useI18n();
  const [workspaceMode, setWorkspaceMode] = useState<"conversation" | "image" | "video">("conversation");
  const [q, setQ] = useState("");
  const [attachments, setAttachments] = useState<PromptAttachment[]>([]);
  const [attachmentError, setAttachmentError] = useState("");
  const [readingFiles, setReadingFiles] = useState(false);
  const [slashIndex, setSlashIndex] = useState(0);
  const fileRef = useRef<HTMLInputElement>(null);
  const promptRef = useRef<HTMLTextAreaElement>(null);
  // Enter confirms an in-progress IME candidate. Keep a local flag because
  // WebKit can report composition state after the keyboard event has fired.
  const composingRef = useRef(false);
  const sessionIndex = useDesktop((s) => s.sessionIndex);
  const sessions = useDesktop((s) => s.sessions);
  const newSession = useDesktop((s) => s.newSession);
  const openSession = useDesktop((s) => s.openSession);
  const workspace = useDesktop((s) => s.workspace);
  const startupError = useDesktop((s) => s.startupError);
  const auth = useDesktop((s) => s.auth);
  const setAccountSetupOpen = useDesktop((s) => s.setAccountSetupOpen);
  const model = useDesktop((s) => s.model);
  const models = useDesktop((s) => s.models);
  const effort = useDesktop((s) => s.effort);
  const permissionMode = useDesktop((s) => s.permissionMode);
  const mode = useDesktop((s) => s.mode);
  const setModel = useDesktop((s) => s.setModel);
  const setEffort = useDesktop((s) => s.setEffort);
  const setPermissionMode = useDesktop((s) => s.setPermissionMode);
  const setMode = useDesktop((s) => s.setMode);
  const setSettingsOpen = useDesktop((s) => s.setSettingsOpen);

  const recent = [...sessionIndex].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 4);

  const slashCommands = [
    { id: "/plan", hint: language === "zh-CN" ? "计划模式 — 操作前先规划" : "Plan mode — think before acting" },
    { id: "/agent", hint: language === "zh-CN" ? "Agent 模式 — 完整工具访问" : "Agent mode — full tool access" },
    { id: "/ask", hint: language === "zh-CN" ? "问答模式 — 不编辑文件" : "Ask mode — answers, no edits" },
    { id: "/deep-research", hint: language === "zh-CN" ? "深度研究 — 后台检索、核验并生成带引用报告" : "Deep research — background research with cited report" },
    { id: "/settings", hint: language === "zh-CN" ? "打开设置" : "Open settings" },
  ];
  const slashOpen = q.startsWith("/") && !q.includes(" ");
  const slashMatches = slashOpen
    ? slashCommands.filter((command) => command.id.slice(1).startsWith(q.slice(1).toLowerCase()))
    : [];

  const chooseSlash = (id: string) => {
    if (id === "/settings") {
      setSettingsOpen(true);
      setQ("");
      return;
    }
    setQ(`${id} `);
    requestAnimationFrame(() => promptRef.current?.focus());
  };

  const launch = async () => {
    const rawPrompt = q.trim();
    const modeCommand = rawPrompt.match(/^\/(plan|agent|ask)(?:\s+([\s\S]+))?$/i);
    if (modeCommand && !modeCommand[2]?.trim()) {
      setMode(modeCommand[1].toLowerCase() as "plan" | "agent" | "ask");
      setQ("");
      return;
    }
    if (rawPrompt === "/settings") {
      setSettingsOpen(true);
      setQ("");
      return;
    }
    const prompt = modeCommand?.[2]?.trim() ?? rawPrompt;
    if ((!prompt && attachments.length === 0) || readingFiles) return;
    setReadingFiles(true);
    setAttachmentError("");
    try {
      const turnAttachments = await attachExplicitPromptImages(workspace, prompt, attachments);
      if (modeCommand) setMode(modeCommand[1].toLowerCase() as "plan" | "agent" | "ask");
      await newSession({ text: prompt, attachments: turnAttachments });
      setQ("");
      setAttachments([]);
    } catch (cause) {
      setAttachmentError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setReadingFiles(false);
    }
  };

  const appendFiles = async (files: File[]) => {
    if (files.length === 0) return;
    setReadingFiles(true);
    setAttachmentError("");
    try {
      const prepared: PromptAttachment[] = [];
      for (const file of files) prepared.push(await prepareAttachment(file));
      const next = [...attachments, ...prepared];
      validateAttachmentSet(next);
      setAttachments(next);
    } catch (cause) {
      const code = cause instanceof Error ? cause.message : String(cause);
      setAttachmentError(code === "attachment_count"
        ? (language === "zh-CN" ? "每次最多上传 8 个附件" : "Up to 8 attachments per prompt")
        : code === "attachment_size"
          ? (language === "zh-CN" ? "附件总大小不能超过 32 MB" : "Attachments cannot exceed 32 MB in total")
          : language === "zh-CN" ? code.replace(" exceeds 16 MB", " 超过 16 MB") : code);
    } finally {
      setReadingFiles(false);
    }
  };

  const currentModel = models.find((item) => item.id === model);

  if (workspaceMode !== "conversation") {
    return (
      <div className="relative flex min-h-0 flex-1 flex-col bg-base">
        <WorkspaceTabs mode={workspaceMode} onChange={setWorkspaceMode} />
        <MediaStudio mode={workspaceMode} />
      </div>
    );
  }

  return (
    <div className="relative flex-1 overflow-hidden bg-base">
      <Starfield />
      <WorkspaceTabs mode={workspaceMode} onChange={setWorkspaceMode} />

      {/* engineering crosshairs */}
      <Crosshair className="left-3 top-3" />
      <Crosshair className="right-3 top-3" />
      <Crosshair className="bottom-3 left-3" />
      <Crosshair className="bottom-3 right-3" />

      <div className="relative flex h-full flex-col items-center justify-center px-8 pb-16">
        <BlackHole size={136} spin="slow" />

        <h1
          className="mt-7 font-sans font-semibold text-fg"
          style={{ fontSize: 42, letterSpacing: "0.52em", marginRight: "-0.52em" }}
        >
          GROX
        </h1>
        <p className="lbl mt-3" style={{ letterSpacing: "0.3em" }}>
          {language === "zh-CN" ? "任务控制台 · GROK-BUILD 已连接" : "MISSION CONTROL · GROK-BUILD LINK"}
        </p>

        {startupError && (
          <div className="mt-6 w-[560px] rounded-[6px] border border-red/40 bg-red/5 px-4 py-3">
            <div className="flex items-start gap-3">
              <Icon name="alert" size={14} className="mt-0.5 shrink-0 text-red" />
              <div className="min-w-0">
                <p className="lbl !text-[9.5px] !text-red">{language === "zh-CN" ? "连接失败" : "LINK FAILURE"}</p>
                <p className="mt-1 break-words font-mono text-[10.5px] leading-relaxed text-fg2">
                  {startupError}
                </p>
                <p className="mt-1.5 text-[10px] text-dim">
                  {language === "zh-CN" ? "请安装 Grok CLI，或设置 GROK_DESKTOP_CLI 后重启 Grox。" : "Install Grok CLI or set GROK_DESKTOP_CLI, then restart Grox."}
                </p>
              </div>
            </div>
          </div>
        )}

        {auth.required && (
          <div className="mt-6 flex w-[560px] items-center gap-4 rounded-[6px] border border-gold/40 bg-gold/5 px-4 py-3">
            <BlackHole size={24} spin={auth.inProgress} />
            <div className="min-w-0 flex-1">
              <p className="lbl !text-[9.5px] !text-gold">{language === "zh-CN" ? "需要账户设置" : "AUTHENTICATION REQUIRED"}</p>
              <p className="mt-1 text-[10.5px] text-fg2">
                {auth.error ?? (language === "zh-CN" ? "请先选择 OAuth、官方 API 或 OpenAI 兼容服务。" : "Connect your xAI account before launching a mission.")}
              </p>
            </div>
            <button
              onClick={() => setAccountSetupOpen(true)}
              disabled={auth.inProgress}
              className="h-8 rounded-[4px] border border-gold/50 px-3 font-mono text-[9.5px] tracking-[0.12em] text-gold transition-colors hover:bg-gold/10 disabled:opacity-50"
            >
              {auth.inProgress ? (language === "zh-CN" ? "连接中" : "CONNECTING") : t("account")}
            </button>
          </div>
        )}

        {/* pre-project uplink */}
        <div className="relative mt-8 w-[680px] overflow-visible rounded-[8px] border border-line2 bg-raise transition-colors focus-within:border-acc-dim">
          <input ref={fileRef} type="file" multiple className="hidden" onChange={(event) => { void appendFiles(Array.from(event.target.files ?? [])); event.target.value = ""; }} />
          {attachments.length > 0 && <div className="flex flex-wrap gap-1.5 border-b border-line px-3 py-2">{attachments.map((attachment) => <div key={attachment.id} className="flex h-8 max-w-[190px] items-center gap-2 rounded-[4px] border border-line2 bg-high/70 px-2">{attachment.kind === "image" && attachment.data ? <img src={`data:${attachment.mime};base64,${attachment.data}`} alt="" className="h-5 w-5 rounded-[2px] object-cover" /> : <Icon name="file" size={10} className="text-dim" />}<span className="min-w-0 flex-1 truncate font-mono text-[9px] text-fg2">{attachment.name}</span><button onClick={() => setAttachments((items) => items.filter((item) => item.id !== attachment.id))} className="text-faint hover:text-fg" title={language === "zh-CN" ? "移除" : "Remove"}><Icon name="x" size={8} /></button></div>)}</div>}
          <textarea
            ref={promptRef}
            value={q}
            onChange={(event) => { setQ(event.target.value); setSlashIndex(0); }}
            onPaste={(event) => {
              const images = Array.from(event.clipboardData.items).filter((item) => item.kind === "file" && item.type.startsWith("image/")).map((item) => item.getAsFile()).filter((file): file is File => Boolean(file));
              if (images.length > 0) { event.preventDefault(); void appendFiles(images); }
            }}
            onKeyDown={(event) => {
              if (composingRef.current || event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
              if (slashMatches.length > 0 && event.key === "ArrowDown") { event.preventDefault(); setSlashIndex((index) => (index + 1) % slashMatches.length); return; }
              if (slashMatches.length > 0 && event.key === "ArrowUp") { event.preventDefault(); setSlashIndex((index) => (index - 1 + slashMatches.length) % slashMatches.length); return; }
              if (slashMatches.length > 0 && event.key === "Enter" && !event.shiftKey) { event.preventDefault(); chooseSlash(slashMatches[slashIndex]?.id ?? slashMatches[0]?.id ?? ""); return; }
              if (event.key === "Escape" && slashMatches.length > 0) { event.preventDefault(); setQ(""); return; }
              if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); void launch(); }
            }}
            onCompositionStart={() => { composingRef.current = true; }}
            onCompositionEnd={() => { composingRef.current = false; }}
            rows={2}
            placeholder={language === "zh-CN" ? "描述任务；可直接粘贴截图或上传文件…" : "Describe the mission; paste screenshots or attach files…"}
            disabled={auth.required}
            className="block min-h-[58px] w-full resize-none bg-transparent px-4 pb-1 pt-3 text-[14px] leading-relaxed text-fg placeholder:text-faint focus:outline-none disabled:opacity-50"
          />
          {slashMatches.length > 0 && <div className="absolute z-30 mt-1 w-[min(520px,calc(100%-32px))] rounded-[6px] border border-line2 bg-raise p-1.5 shadow-[0_10px_30px_rgba(0,0,0,0.45)]">{slashMatches.map((command, index) => <button key={command.id} onMouseDown={(event) => event.preventDefault()} onClick={() => chooseSlash(command.id)} className={`flex w-full items-center gap-3 rounded-[4px] px-3 py-2 text-left ${index === slashIndex ? "bg-high text-fg" : "text-dim hover:bg-high hover:text-fg2"}`}><span className="font-mono text-[10px] text-acc">{command.id}</span><span className="min-w-0 flex-1 truncate text-[10px]">{command.hint}</span></button>)}</div>}
          <div className="flex flex-wrap items-center gap-1.5 px-2.5 pb-2.5 pt-1">
            <ProviderSwitcher />
            <ChipSelect label={<span className="text-fg2">{currentModel?.label ?? model.toUpperCase()}</span>} items={models.map((item) => ({ id: item.id, label: item.label, hint: item.tagline }))} activeId={model} onSelect={setModel} width={240} />
            <PromptOptionsMenu mode={mode} effort={effort} permissionMode={permissionMode} onMode={setMode} onEffort={setEffort} onPermission={setPermissionMode} />
            <button onClick={() => fileRef.current?.click()} disabled={auth.required || readingFiles || attachments.length >= MAX_ATTACHMENTS} className="flex h-7 items-center gap-1.5 rounded-[5px] border border-line2 px-2 font-mono text-[9.5px] text-dim hover:border-line3 hover:text-fg2 disabled:opacity-40" title={language === "zh-CN" ? "上传文件；也支持粘贴剪贴板图片" : "Attach files; clipboard images are also supported"}><Icon name="clip" size={11} />{readingFiles ? (language === "zh-CN" ? "读取中" : "READING") : (language === "zh-CN" ? "附件" : "ATTACH")}</button>
            <div className="flex-1" />
            <button onClick={() => void launch()} disabled={(!q.trim() && attachments.length === 0) || auth.required || readingFiles} className={`flex h-7 w-7 items-center justify-center rounded-[5px] transition-colors ${(q.trim() || attachments.length > 0) && !auth.required ? "bg-acc text-base hover:bg-acc-deep" : "bg-high text-faint"}`} title={language === "zh-CN" ? "开始任务" : "Launch mission"}><Icon name="arrowUp" size={13} strokeWidth={2} /></button>
          </div>
          {attachmentError && <p className="border-t border-red/20 px-3 py-1.5 text-[9.5px] text-red">{attachmentError}</p>}
        </div>

        {/* recent missions */}
        {recent.length > 0 && (
          <div className="mt-11 w-[560px]">
            <div className="mb-2 flex items-center justify-between px-1">
              <span className="lbl !text-[9.5px]">{language === "zh-CN" ? "最近任务" : "RECENT MISSIONS"}</span>
              <span className="tnum text-[9.5px] text-faint">{recent.length}</span>
            </div>
            <div className="grid grid-cols-2 gap-2">
              {recent.map((m) => {
                const tokens =
                  (sessions[m.id]?.usage.inputTokens ?? 0) + (sessions[m.id]?.usage.outputTokens ?? 0);
                return (
                  <button
                    key={m.id}
                    onClick={() => openSession(m.id)}
                    className="group rounded-[6px] border border-line2 bg-raise/60 px-3.5 py-3 text-left transition-colors hover:border-line3 hover:bg-raise"
                  >
                    <p className="truncate text-[12px] text-fg2 group-hover:text-fg">{m.title}</p>
                    <div className="mt-1.5 flex items-center justify-between">
                      <span className="lbl !text-[9.5px]">{fmtRelTime(m.updatedAt)}</span>
                      {tokens > 0 && (
                        <span className="tnum text-[9.5px] text-faint">{fmtTokens(tokens)} TOK</span>
                      )}
                    </div>
                  </button>
                );
              })}
            </div>
          </div>
        )}
      </div>

      {/* ground strip */}
      <div className="absolute inset-x-0 bottom-0 flex h-8 items-center justify-between px-4">
        <span className="tnum max-w-[60%] truncate text-[9.5px] text-mute">{workspace}</span>
        <span className="lbl !text-[9.5px]">⌘K {language === "zh-CN" ? "命令" : "PALETTE"} · ⌘N {t("newProject")}</span>
      </div>
    </div>
  );
}

function WorkspaceTabs({ mode, onChange }: { mode: "conversation" | "image" | "video"; onChange(mode: "conversation" | "image" | "video"): void }) {
  const { language } = useI18n();
  const zh = language === "zh-CN";
  return (
    <div className="absolute left-1/2 top-4 z-10 flex -translate-x-1/2 items-center gap-1 rounded-[6px] border border-line2 bg-panel/90 p-1 shadow-lg backdrop-blur">
      {([
        ["conversation", zh ? "对话" : "CHAT"],
        ["image", zh ? "图片" : "IMAGE"],
        ["video", zh ? "视频" : "VIDEO"],
      ] as const).map(([id, label]) => (
        <button key={id} onClick={() => onChange(id)} className={`flex h-7 items-center gap-1.5 rounded-[4px] px-3 font-mono text-[9.5px] tracking-[0.08em] transition-colors ${mode === id ? "bg-acc text-base" : "text-dim hover:bg-high hover:text-fg2"}`}>
          {id === "conversation" ? <Icon name="command" size={10} /> : id === "image" ? <Icon name="layers" size={10} /> : <Icon name="play" size={10} />}
          {label}
        </button>
      ))}
    </div>
  );
}

const Crosshair = ({ className = "" }: { className?: string }) => (
  <span className={`pointer-events-none absolute select-none font-mono text-[11px] text-faint ${className}`}>
    +
  </span>
);
