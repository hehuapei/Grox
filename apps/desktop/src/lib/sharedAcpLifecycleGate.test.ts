import { describe, expect, it } from "vitest";
import { SharedAcpLifecycleGate } from "./sharedAcpLifecycleGate";

const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((next) => { resolve = next; });
  return { promise, resolve };
};

const tick = () => new Promise<void>((resolve) => queueMicrotask(resolve));

describe("SharedAcpLifecycleGate", () => {
  it("允许不同已绑定会话同时运行回合", async () => {
    const gate = new SharedAcpLifecycleGate();
    await Promise.all([gate.enterTurn("session-a"), gate.enterTurn("session-b")]);

    expect(gate.snapshot()).toEqual({
      activeTurnSessionIds: ["session-a", "session-b"],
      lifecycleActive: false,
      pendingLifecycle: 0,
    });
  });

  it("生命周期操作等待活动回合结束", async () => {
    const gate = new SharedAcpLifecycleGate();
    const releaseLifecycle = deferred();
    let started = false;
    await gate.enterTurn("session-a");

    const lifecycle = gate.runLifecycle(async () => {
      started = true;
      await releaseLifecycle.promise;
    });
    await tick();
    expect(started).toBe(false);
    expect(gate.snapshot().pendingLifecycle).toBe(1);

    gate.leaveTurn("session-a");
    await tick();
    expect(started).toBe(true);
    expect(gate.snapshot().lifecycleActive).toBe(true);

    releaseLifecycle.resolve();
    await lifecycle;
    expect(gate.snapshot().lifecycleActive).toBe(false);
  });

  it("已排队的生命周期操作阻止新回合抢占", async () => {
    const gate = new SharedAcpLifecycleGate();
    const releaseLifecycle = deferred();
    const order: string[] = [];
    await gate.enterTurn("session-a");

    const lifecycle = gate.runLifecycle(async () => {
      order.push("load");
      await releaseLifecycle.promise;
    });
    const turn = gate.enterTurn("session-b").then(() => order.push("turn"));
    gate.leaveTurn("session-a");
    await tick();
    expect(order).toEqual(["load"]);

    releaseLifecycle.resolve();
    await lifecycle;
    await turn;
    expect(order).toEqual(["load", "turn"]);
  });

  it("串行执行多个生命周期操作", async () => {
    const gate = new SharedAcpLifecycleGate();
    const firstRelease = deferred();
    const order: string[] = [];

    const first = gate.runLifecycle(async () => {
      order.push("first:start");
      await firstRelease.promise;
      order.push("first:end");
    });
    const second = gate.runLifecycle(async () => {
      order.push("second");
    });
    await tick();
    expect(order).toEqual(["first:start"]);

    firstRelease.resolve();
    await Promise.all([first, second]);
    expect(order).toEqual(["first:start", "first:end", "second"]);
  });

  it("生命周期失败后释放门控", async () => {
    const gate = new SharedAcpLifecycleGate();
    await expect(gate.runLifecycle(async () => {
      throw new Error("load failed");
    })).rejects.toThrow("load failed");

    await gate.enterTurn("session-a");
    expect(gate.snapshot().activeTurnSessionIds).toEqual(["session-a"]);
  });
});
