import { ResizeHandle } from "../common/ResizeHandle";
import { Sidebar } from "./Sidebar";

interface SidebarDockProps {
  visible: boolean;
  width: number;
  onResize: (width: number) => void;
}

export function SidebarDock({ visible, width, onResize }: SidebarDockProps) {
  if (!visible) return null;
  return (
    <>
      <Sidebar />
      <ResizeHandle side="right" value={width} onChange={onResize} />
    </>
  );
}
