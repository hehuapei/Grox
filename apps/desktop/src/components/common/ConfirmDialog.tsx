import { useEffect, useId, useState } from "react";
import { createPortal } from "react-dom";

interface ConfirmDialogProps {
  title: string;
  description: string;
  confirmLabel: string;
  cancelLabel: string;
  workingLabel: string;
  tone?: "danger" | "primary";
  onCancel(): void;
  onConfirm(): Promise<void> | void;
}

export function ConfirmDialog({
  title,
  description,
  confirmLabel,
  cancelLabel,
  workingLabel,
  tone = "danger",
  onCancel,
  onConfirm,
}: ConfirmDialogProps) {
  const titleId = useId();
  const descriptionId = useId();
  const [working, setWorking] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    const close = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !working) onCancel();
    };
    document.addEventListener("keydown", close);
    return () => document.removeEventListener("keydown", close);
  }, [onCancel, working]);

  return createPortal(
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-void/80 p-5 backdrop-blur-[3px]"
      onMouseDown={(event) => {
        event.stopPropagation();
        if (event.target === event.currentTarget && !working) onCancel();
      }}
    >
      <section
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
        className="w-[min(430px,94vw)] rounded-[8px] border border-line3 bg-panel p-5 shadow-2xl animate-fade-up"
      >
        <h2 id={titleId} className="text-[13px] font-medium text-fg">{title}</h2>
        <p id={descriptionId} className="mt-2 text-[10.5px] leading-relaxed text-dim">{description}</p>
        {error && <p className="mt-3 rounded-[4px] border border-red/30 bg-red/5 px-3 py-2 text-[10px] text-red">{error}</p>}
        <div className="mt-5 flex justify-end gap-2">
          <button
            type="button"
            autoFocus
            disabled={working}
            onClick={onCancel}
            className="h-8 rounded-[4px] border border-line2 px-3 text-[10px] text-dim hover:border-line3 hover:text-fg disabled:opacity-45"
          >
            {cancelLabel}
          </button>
          <button
            type="button"
            disabled={working}
            onClick={() => {
              setWorking(true);
              setError("");
              void Promise.resolve(onConfirm()).catch((cause) => {
                setError(cause instanceof Error ? cause.message : String(cause));
                setWorking(false);
              });
            }}
            className={tone === "danger"
              ? "h-8 rounded-[4px] border border-red/45 bg-red/10 px-3 text-[10px] text-red hover:bg-red/15 disabled:opacity-45"
              : "h-8 rounded-[4px] border border-acc/55 bg-acc/10 px-3 text-[10px] text-acc hover:bg-acc/15 disabled:opacity-45"}
          >
            {working ? workingLabel : confirmLabel}
          </button>
        </div>
      </section>
    </div>,
    document.body,
  );
}
