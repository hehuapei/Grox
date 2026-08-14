import type { RuntimeOccupancy } from "../bridge/types";

type OccupancyListener = (occupancy: RuntimeOccupancy) => void;

/**
 * 共享 ACP 进程的协议门控。
 *
 * session/load 与 session/new 会改变进程级会话上下文，且部分 CLI 的回放通知
 * 不携带 sessionId，因此它们不能和任何活动回合重叠。已经绑定的不同会话仍可
 * 同时运行 prompt；一旦生命周期操作排队，新回合先让路，避免同步长期饥饿。
 */
export class SharedAcpLifecycleGate {
  private readonly activeTurns = new Set<string>();
  private readonly waiters = new Set<() => void>();
  private lifecycleActive = false;
  private pendingLifecycle = 0;

  constructor(private readonly onOccupancyChange?: OccupancyListener) {}

  snapshot(): RuntimeOccupancy {
    return {
      activeTurnSessionIds: [...this.activeTurns].sort(),
      lifecycleActive: this.lifecycleActive,
      pendingLifecycle: this.pendingLifecycle,
    };
  }

  async enterTurn(sessionId: string): Promise<void> {
    if (!sessionId.trim()) throw new Error("ACP 回合缺少 sessionId");
    if (this.activeTurns.has(sessionId)) throw new Error(`会话已有活动回合：${sessionId}`);
    while (this.lifecycleActive || this.pendingLifecycle > 0) {
      await this.waitForChange();
      if (this.activeTurns.has(sessionId)) throw new Error(`会话已有活动回合：${sessionId}`);
    }
    this.activeTurns.add(sessionId);
    this.publishChange();
  }

  leaveTurn(sessionId: string): void {
    if (!this.activeTurns.delete(sessionId)) return;
    this.publishChange();
  }

  async runLifecycle<T>(operation: () => Promise<T>): Promise<T> {
    this.pendingLifecycle += 1;
    this.publishChange();
    let claimed = false;
    try {
      while (this.lifecycleActive || this.activeTurns.size > 0) {
        await this.waitForChange();
      }
      this.pendingLifecycle -= 1;
      this.lifecycleActive = true;
      claimed = true;
      this.publishChange();
      return await operation();
    } finally {
      if (claimed) this.lifecycleActive = false;
      else this.pendingLifecycle -= 1;
      this.publishChange();
    }
  }

  private waitForChange(): Promise<void> {
    return new Promise((resolve) => this.waiters.add(resolve));
  }

  private publishChange(): void {
    this.onOccupancyChange?.(this.snapshot());
    const waiters = [...this.waiters];
    this.waiters.clear();
    for (const wake of waiters) wake();
  }
}
