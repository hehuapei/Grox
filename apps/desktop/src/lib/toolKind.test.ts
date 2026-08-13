import { describe, expect, it } from "vitest";
import { mapToolKind } from "./toolKind";

describe("mapToolKind", () => {
  it("classifies Grok snake_case names used by live and durable events", () => {
    expect(mapToolKind("read_file", "read_file")).toBe("read");
    expect(mapToolKind("run_terminal_command", "run_terminal_command")).toBe("execute");
    expect(mapToolKind("web_search", "Search the web")).toBe("web_search");
    expect(mapToolKind("computer_screenshot", "Take screenshot")).toBe("computer");
  });

  it("keeps unknown tools inspectable", () => {
    expect(mapToolKind("future_grok_capability", "Future capability")).toBe("other");
  });
});
