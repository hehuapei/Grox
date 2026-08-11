import { useEffect, useRef, useState } from "react";
import { ResizeHandle } from "../common/ResizeHandle";
import { Sidebar } from "./Sidebar";

const EDGE_REVEAL_WIDTH = 14;
const EXIT_GUTTER = 10;
const HIDE_DELAY_MS = 50;

interface SidebarDockProps {
  visible: boolean;
  width: number;
  onResize: (width: number) => void;
}

export function SidebarDock({ visible, width, onResize }: SidebarDockProps) {
  const [peekOpen, setPeekOpen] = useState(false);
  const peekOpenRef = useRef(false);
  const hideTimer = useRef<number | null>(null);

  const cancelHide = () => {
    if (hideTimer.current === null) return;
    window.clearTimeout(hideTimer.current);
    hideTimer.current = null;
  };

  const reveal = () => {
    cancelHide();
    if (peekOpenRef.current) return;
    peekOpenRef.current = true;
    setPeekOpen(true);
  };

  const hideImmediately = () => {
    cancelHide();
    peekOpenRef.current = false;
    setPeekOpen(false);
  };

  const scheduleHide = () => {
    if (!peekOpenRef.current || hideTimer.current !== null) return;
    hideTimer.current = window.setTimeout(() => {
      peekOpenRef.current = false;
      setPeekOpen(false);
      hideTimer.current = null;
    }, HIDE_DELAY_MS);
  };

  useEffect(() => {
    if (visible) {
      hideImmediately();
    }
    return cancelHide;
  }, [visible]);

  useEffect(() => {
    if (visible) return;
    const trackPointer = (event: PointerEvent) => {
      if (event.clientX <= EDGE_REVEAL_WIDTH) {
        reveal();
        return;
      }
      if (!peekOpenRef.current) return;
      if (event.clientX <= width + EXIT_GUTTER) cancelHide();
      else scheduleHide();
    };
    const leaveWindow = () => scheduleHide();
    window.addEventListener("pointermove", trackPointer);
    document.documentElement.addEventListener("pointerleave", leaveWindow);
    window.addEventListener("blur", leaveWindow);
    return () => {
      window.removeEventListener("pointermove", trackPointer);
      document.documentElement.removeEventListener("pointerleave", leaveWindow);
      window.removeEventListener("blur", leaveWindow);
    };
  }, [visible, width]);

  if (visible) {
    return (
      <>
        <Sidebar />
        <ResizeHandle side="right" value={width} onChange={onResize} />
      </>
    );
  }

  return (
    <>
      <div
        data-testid="sidebar-edge-zone"
        aria-hidden="true"
        className="absolute inset-y-0 left-0 z-40"
        style={{ width: EDGE_REVEAL_WIDTH }}
        onPointerEnter={reveal}
      />
      <div
        data-testid="sidebar-peek"
        data-state={peekOpen ? "open" : "closed"}
        aria-hidden={!peekOpen}
        onPointerEnter={cancelHide}
        onPointerLeave={scheduleHide}
        className={`sidebar-peek-panel absolute inset-y-0 left-0 z-30 flex ${peekOpen ? "" : "pointer-events-none"}`}
        style={{ width }}
      >
        <Sidebar onRequestHide={hideImmediately} />
      </div>
    </>
  );
}
