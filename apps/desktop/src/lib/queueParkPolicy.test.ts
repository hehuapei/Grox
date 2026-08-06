import { describe, expect, it } from "vitest";
import { isQueueDrainParked, nextQueueDrainParked } from "./queueParkPolicy";

describe("queueParkPolicy", () => {
  it("parks and unparks without clobbering other sessions", () => {
    let m: Record<string, boolean> = {};
    m = nextQueueDrainParked(m, "a", true);
    m = nextQueueDrainParked(m, "b", true);
    expect(isQueueDrainParked(m, "a")).toBe(true);
    expect(isQueueDrainParked(m, "b")).toBe(true);
    m = nextQueueDrainParked(m, "a", false);
    expect(isQueueDrainParked(m, "a")).toBe(false);
    expect(isQueueDrainParked(m, "b")).toBe(true);
  });

  it("is idempotent", () => {
    let m = nextQueueDrainParked({}, "a", true);
    const again = nextQueueDrainParked(m, "a", true);
    expect(again).toBe(m);
    m = nextQueueDrainParked(m, "a", false);
    const againOff = nextQueueDrainParked(m, "a", false);
    expect(againOff).toBe(m);
  });
});
