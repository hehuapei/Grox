import { describe, expect, it } from "vitest";
import { createSerialMutationQueue } from "./serialMutationQueue";

describe("createSerialMutationQueue", () => {
  it("按用户触发顺序执行异步写入", async () => {
    const enqueue = createSerialMutationQueue();
    const order: string[] = [];
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });

    const first = enqueue(async () => {
      order.push("first:start");
      await firstGate;
      order.push("first:end");
    });
    const second = enqueue(async () => {
      order.push("second:start");
      order.push("second:end");
    });

    await Promise.resolve();
    expect(order).toEqual(["first:start"]);
    releaseFirst();
    await Promise.all([first, second]);
    expect(order).toEqual(["first:start", "first:end", "second:start", "second:end"]);
  });

  it("前一次失败不会阻塞后续用户意图", async () => {
    const enqueue = createSerialMutationQueue();
    const order: string[] = [];
    const failed = enqueue(async () => {
      order.push("failed");
      throw new Error("write failed");
    });
    const recovered = enqueue(async () => {
      order.push("recovered");
      return "latest";
    });

    await expect(failed).rejects.toThrow("write failed");
    await expect(recovered).resolves.toBe("latest");
    expect(order).toEqual(["failed", "recovered"]);
  });
});
