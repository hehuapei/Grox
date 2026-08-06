import { describe, expect, it } from "vitest";
import { mergeProjectSessionsPure } from "./sessionCatalogMerge";

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

describe("mergeProjectSessionsPure", () => {
  it("keeps same-cwd offline sessions when CLI returns only the new mission", () => {
    const cwd = "C:\\Users\\Harry_win10\\Desktop\\spoofer";
    const existing = [
      { id: "old-spoof", cwd, updatedAt: 100, title: "spoof" },
      { id: "old-greet", cwd, updatedAt: 90, title: "Greeting" },
      { id: "other-proj", cwd: "C:\\Users\\Harry_win10\\Desktop\\Grox-build", updatedAt: 80, title: "VSCode" },
    ];
    const incoming = [
      { id: "new-untitled", cwd, updatedAt: 200, title: "Untitled mission" },
    ];
    const out = mergeProjectSessionsPure(existing, same, cwd, incoming, new Set());
    const ids = out.map((m) => m.id);
    expect(ids).toContain("new-untitled");
    expect(ids).toContain("old-spoof");
    expect(ids).toContain("old-greet");
    expect(ids).toContain("other-proj");
    // New mission first by updatedAt
    expect(ids[0]).toBe("new-untitled");
  });

  it("does not resurrect hidden sessions", () => {
    const cwd = "C:\\proj";
    const existing = [{ id: "hidden-one", cwd, updatedAt: 1, title: "gone" }];
    const incoming = [{ id: "visible", cwd, updatedAt: 2, title: "ok" }];
    const out = mergeProjectSessionsPure(
      existing,
      same,
      cwd,
      incoming,
      new Set(["hidden-one"]),
    );
    expect(out.map((m) => m.id)).toEqual(["visible"]);
  });

  it("preserves pin flags from existing when CLI re-lists id", () => {
    const cwd = "C:\\proj";
    const existing = [
      { id: "a", cwd, updatedAt: 1, title: "old", pinned: true },
    ];
    const incoming = [{ id: "a", cwd, updatedAt: 9, title: "fresh" }];
    const out = mergeProjectSessionsPure(existing, same, cwd, incoming, new Set());
    expect(out).toHaveLength(1);
    expect(out[0].title).toBe("fresh");
    expect(out[0].pinned).toBe(true);
  });

  it("empty CLI list still keeps same-cwd offline catalog (0.2.28 +)", () => {
    // Project "+" can briefly list only the new mission; empty/partial list
    // must not wipe disk-only history that "导入 CLI 历史" would show.
    const cwd = "C:\\Users\\Harry_win10\\Desktop\\spoofer";
    const existing = [
      { id: "disk-only", cwd, updatedAt: 50, title: "old mission" },
      { id: "other", cwd: "D:\\other", updatedAt: 40, title: "elsewhere" },
    ];
    const out = mergeProjectSessionsPure(existing, same, cwd, [], new Set());
    expect(out.map((m) => m.id).sort()).toEqual(["disk-only", "other"]);
  });

  it("case-insensitive cwd match keeps Windows offline siblings", () => {
    const existing = [
      {
        id: "old",
        cwd: "c:\\users\\harry_win10\\desktop\\spoofer",
        updatedAt: 1,
        title: "old",
      },
    ];
    const incoming = [
      {
        id: "new",
        cwd: "C:\\Users\\Harry_win10\\Desktop\\spoofer",
        updatedAt: 2,
        title: "new",
      },
    ];
    const out = mergeProjectSessionsPure(
      existing,
      same,
      "C:\\Users\\Harry_win10\\Desktop\\spoofer",
      incoming,
      new Set(),
    );
    expect(out.map((m) => m.id)).toEqual(["new", "old"]);
  });

  it("preserves archived flag from existing when CLI re-lists id", () => {
    const cwd = "C:\\proj";
    const existing = [
      { id: "a", cwd, updatedAt: 1, title: "old", archived: true },
    ];
    const incoming = [{ id: "a", cwd, updatedAt: 9, title: "fresh" }];
    const out = mergeProjectSessionsPure(existing, same, cwd, incoming, new Set());
    expect(out[0].archived).toBe(true);
    expect(out[0].title).toBe("fresh");
  });
});
