import assert from "node:assert/strict";
import test from "node:test";
import {
  buildIssueBody,
  expandSourceDiffWithTrees,
  findTrackedIssue,
  normalizeChanges,
  normalizeSourceDiff,
  parsePackageVersion,
  parseSourceRevision,
} from "./upstream-tracker.mjs";

test("parses only the package version", () => {
  assert.equal(parsePackageVersion(`[package]\nname = "xai-grok-shell"\nversion = "0.2.121"\n\n[dependencies]\nfoo = "9"`), "0.2.121");
});

test("expands a capped compare response from complete git trees", () => {
  const sourceDiff = {
    commits: [{ sha: "c".repeat(40), message: "Sync" }],
    files: Array.from({ length: 300 }, (_, index) => ({ filename: `old-${index}`, status: "modified" })),
    totalCommits: 1,
    possiblyTruncated: true,
  };
  const expanded = expandSourceDiffWithTrees(sourceDiff, {
    truncated: false,
    tree: [
      { path: "same", sha: "1", mode: "100644", type: "blob" },
      { path: "removed", sha: "2", mode: "100644", type: "blob" },
      { path: "changed", sha: "3", mode: "100644", type: "blob" },
    ],
  }, {
    truncated: false,
    tree: [
      { path: "same", sha: "1", mode: "100644", type: "blob" },
      { path: "added", sha: "4", mode: "100644", type: "blob" },
      { path: "changed", sha: "5", mode: "100644", type: "blob" },
    ],
  });
  assert.deepEqual(expanded.files, [
    { filename: "added", status: "added", additions: 0, deletions: 0, previousFilename: null },
    { filename: "changed", status: "modified", additions: 0, deletions: 0, previousFilename: null },
    { filename: "removed", status: "removed", additions: 0, deletions: 0, previousFilename: null },
  ]);
  assert.equal(expanded.possiblyTruncated, false);
});

test("keeps every compare commit and changed file as audit input", () => {
  assert.deepEqual(normalizeSourceDiff({
    total_commits: 2,
    commits: [
      { sha: "a".repeat(40), commit: { message: "Add desktop metadata\n\nDetails" } },
      { sha: "b".repeat(40), commit: { message: "Fix queue loss" } },
    ],
    files: [
      { filename: "src/a.rs", status: "modified", additions: 3, deletions: 1 },
      { filename: "src/new.rs", previous_filename: "src/old.rs", status: "renamed", additions: 0, deletions: 0 },
    ],
  }), {
    commits: [
      { sha: "a".repeat(40), message: "Add desktop metadata" },
      { sha: "b".repeat(40), message: "Fix queue loss" },
    ],
    files: [
      { filename: "src/a.rs", status: "modified", additions: 3, deletions: 1, previousFilename: null },
      { filename: "src/new.rs", status: "renamed", additions: 0, deletions: 0, previousFilename: "src/old.rs" },
    ],
    totalCommits: 2,
    possiblyTruncated: false,
  });
});

test("normalizes every structured changelog item without dropping categories", () => {
  assert.deepEqual(normalizeChanges([
    { category: "features", description: "Feature A", breaking_change: false },
    { category: "fixes", description: "Fix B", breaking_change: true },
  ]), [
    { id: "UP-001", category: "features", description: "Feature A", breakingChange: false },
    { id: "UP-002", category: "fixes", description: "Fix B", breakingChange: true },
  ]);
});

test("issue body makes observation and verified integration distinct", () => {
  const state = {
    latestObserved: { commit: "old" },
    verifiedIntegration: null,
  };
  const latest = { sha: "a".repeat(40) };
  const body = buildIssueBody({
    state,
    latest,
    packageVersion: "0.2.121",
    publicVersion: "1.0.0",
    sourceRevision: "b".repeat(40),
    changes: [{ id: "UP-001", category: "fixes", description: "Never lose prompts", breakingChange: false }],
    sourceDiff: normalizeSourceDiff({
      total_commits: 1,
      commits: [{ sha: "c".repeat(40), commit: { message: "Source-only fix" } }],
      files: [{ filename: "src/fix.rs", status: "modified", additions: 2, deletions: 1 }],
    }),
  });
  assert.match(body, /状态：未完成/);
  assert.match(body, /变化项数量：1/);
  assert.match(body, /Grox 影响：`待分析`/);
  assert.match(body, /最后才允许推进 verifiedIntegration/);
  assert.match(body, /源码审计输入（不能由 Changelog 替代）/);
  assert.match(body, /Source-only fix/);
  assert.match(body, /src\/fix\.rs/);
  assert.equal(findTrackedIssue([{ number: 16, body, state: "CLOSED" }], latest.sha)?.number, 16);
  assert.equal(findTrackedIssue([{ number: 16, body: "legacy", state: "CLOSED" }], latest.sha, 16)?.number, 16);
});

test("extracts source revision from an upstream sync message", () => {
  assert.equal(parseSourceRevision(`Synced\n\nSource-Revision: ${"c".repeat(40)}`), "c".repeat(40));
  assert.equal(parseSourceRevision("no source revision"), null);
});
