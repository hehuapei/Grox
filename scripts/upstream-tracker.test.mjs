import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  buildIssueBody,
  expandSourceDiffWithTrees,
  findTrackedIssue,
  normalizeChanges,
  normalizeSourceDiff,
  parsePackageVersion,
  parseCommitChanges,
  parsePublicVersion,
  parseSourceRevision,
  parseSourceRevisionFile,
  shouldTrackRelease,
  validateIntegrationState,
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

test("tracks public releases, not source commits or repeated package versions", () => {
  const state = {
    verifiedIntegration: { commit: "release-commit", publicVersion: "1.0.0" },
    latestObserved: { commit: "new-source-commit", packageVersion: "1.0.0" },
  };
  assert.equal(parsePublicVersion("1.0.0\n"), "1.0.0");
  assert.equal(parsePublicVersion("v1.1.0"), "1.1.0");
  assert.throws(() => parsePublicVersion("main"), /无效版本/);
  assert.equal(shouldTrackRelease(state, "1.0.0"), false);
  assert.equal(shouldTrackRelease(state, "1.1.0"), true);
});

test("preserves pending 1.0.4 and 1.0.5 history without advancing the verified baseline", () => {
  const state = validateIntegrationState(JSON.parse(readFileSync(new URL("../.grox/official-cli.json", import.meta.url))));
  assert.equal(state.verifiedIntegration.publicVersion, "1.0.3");
  assert.equal(state.integrationTarget.publicVersion, "1.0.5");
  assert.equal(state.integrationTarget.status, "pending-verification");
  assert.deepEqual(state.integrationTarget.issues, [35, 36]);
  assert.deepEqual(state.pendingIntegrations.map(({ publicVersion, issue }) => ({ publicVersion, issue })), [
    { publicVersion: "1.0.4", issue: 35 },
    { publicVersion: "1.0.5", issue: 36 },
  ]);

  assert.throws(() => validateIntegrationState({
    ...state,
    verifiedIntegration: { ...state.verifiedIntegration, publicVersion: "1.0.5" },
  }), /不能覆盖 verifiedIntegration/);
  assert.throws(() => validateIntegrationState({
    ...state,
    pendingIntegrations: state.pendingIntegrations.map((entry) => ({ ...entry, issue: 35 })),
  }), /issue 重复/);
  assert.throws(() => validateIntegrationState({
    ...state,
    integrationTarget: { ...state.integrationTarget, issues: [36, 35] },
  }), /严格一致/);
});

test("uses the source snapshot change list when no public changelog exists", () => {
  assert.deepEqual(parseCommitChanges("Synced from monorepo\n\nChanges:\n- Fix queue loss\n- Bound startup"), [
    { id: "SRC-001", category: "source snapshot", description: "Fix queue loss", breakingChange: false },
    { id: "SRC-002", category: "source snapshot", description: "Bound startup", breakingChange: false },
  ]);
  assert.deepEqual(parseCommitChanges("No list"), []);
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
  assert.match(body, /不得为此提交根目录 `docs\/`/);
  assert.doesNotMatch(body, /适配矩阵已提交到仓库/);
  assert.equal(findTrackedIssue([{ number: 16, body, state: "CLOSED" }], "1.0.0")?.number, 16);
  assert.equal(findTrackedIssue([{ number: 16, body: "legacy", state: "CLOSED" }], "1.0.0"), null);
  assert.equal(findTrackedIssue([{ number: 36, title: "Grok Build v1.0.5 出了", body: "", state: "OPEN" }], "1.0.5", 36)?.number, 36);
  assert.equal(findTrackedIssue([{ number: 36, title: "Unrelated issue", body: "", state: "CLOSED" }], "1.0.5", 36), null);
  assert.equal(findTrackedIssue([{ number: 36, title: "Grok Build v1.0.4", body: "", state: "CLOSED" }], "1.0.5", 36), null);
  assert.equal(findTrackedIssue([{
    number: 16,
    body: "<!-- grox-upstream-commit:old-verified-commit -->",
    state: "CLOSED",
  }], "1.0.0"), null);
});

test("extracts source revision from an upstream sync message", () => {
  assert.equal(parseSourceRevision(`Synced\n\nSource-Revision: ${"c".repeat(40)}`), "c".repeat(40));
  assert.equal(parseSourceRevision("no source revision"), null);
  assert.equal(parseSourceRevisionFile(` ${"D".repeat(40)}\n`), "d".repeat(40));
  assert.equal(parseSourceRevisionFile("not-a-revision"), null);
});
