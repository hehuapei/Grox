import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const MARKER_PREFIX = "<!-- grox-upstream-commit:";

export function parsePackageVersion(cargo) {
  const match = cargo.match(/^\[package\][\s\S]*?^version\s*=\s*"([^"]+)"/m);
  if (!match) throw new Error("无法从官方 Cargo.toml 解析 package.version");
  return match[1];
}

export function parseSourceRevision(message) {
  return message.match(/^Source-Revision:\s*([0-9a-f]{40})\s*$/mi)?.[1] ?? null;
}

export function parseSourceRevisionFile(value) {
  const revision = value.trim();
  return /^[0-9a-f]{40}$/i.test(revision) ? revision.toLowerCase() : null;
}

export function parseCommitChanges(message) {
  const section = message.match(/(?:^|\n)Changes:\s*\r?\n((?:\s*-\s+[^\r\n]+\r?\n?)*)/i)?.[1] ?? "";
  return section.split(/\r?\n/).flatMap((line, index) => {
    const description = line.match(/^\s*-\s+(.+?)\s*$/)?.[1];
    return description ? [{
      id: `SRC-${String(index + 1).padStart(3, "0")}`,
      category: "source snapshot",
      description,
      breakingChange: false,
    }] : [];
  });
}

export function shouldLoadChangelog(state, latestCommit, packageVersion) {
  return (state.integrationTarget?.commit === latestCommit && Boolean(state.integrationTarget.publicVersion))
    || (state.latestObserved?.commit === latestCommit && Boolean(state.latestObserved.publicVersion))
    || state.latestObserved?.packageVersion !== packageVersion;
}

export function versionLabel(publicVersion, packageVersion, commit) {
  return publicVersion ? `v${publicVersion}` : `snapshot ${commit.slice(0, 7)} (package ${packageVersion})`;
}

export function normalizeChanges(value) {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item, index) => {
    if (!item || typeof item.description !== "string" || !item.description.trim()) return [];
    return [{
      id: `UP-${String(index + 1).padStart(3, "0")}`,
      category: typeof item.category === "string" ? item.category : "uncategorized",
      description: item.description.trim(),
      breakingChange: item.breaking_change === true,
    }];
  });
}

export function normalizeSourceDiff(value) {
  if (!value || typeof value !== "object") return null;
  const commits = Array.isArray(value.commits)
    ? value.commits.flatMap((commit) => {
        const sha = typeof commit?.sha === "string" ? commit.sha : null;
        const message = typeof commit?.commit?.message === "string"
          ? commit.commit.message.split(/\r?\n/, 1)[0].trim()
          : "";
        return sha && message ? [{ sha, message }] : [];
      })
    : [];
  const files = Array.isArray(value.files)
    ? value.files.flatMap((file) => {
        if (!file || typeof file.filename !== "string") return [];
        return [{
          filename: file.filename,
          status: typeof file.status === "string" ? file.status : "changed",
          additions: Number.isInteger(file.additions) ? file.additions : 0,
          deletions: Number.isInteger(file.deletions) ? file.deletions : 0,
          previousFilename: typeof file.previous_filename === "string" ? file.previous_filename : null,
        }];
      })
    : [];
  return {
    commits,
    files,
    totalCommits: Number.isInteger(value.total_commits) ? value.total_commits : commits.length,
    possiblyTruncated: commits.length < (Number.isInteger(value.total_commits) ? value.total_commits : commits.length)
      || files.length >= 300,
  };
}

export function expandSourceDiffWithTrees(sourceDiff, baseTree, latestTree) {
  const baseEntries = Array.isArray(baseTree?.tree) ? baseTree.tree : [];
  const latestEntries = Array.isArray(latestTree?.tree) ? latestTree.tree : [];
  const baseByPath = new Map(baseEntries.flatMap((entry) =>
    typeof entry?.path === "string" && entry.type !== "tree" ? [[entry.path, entry]] : []));
  const latestByPath = new Map(latestEntries.flatMap((entry) =>
    typeof entry?.path === "string" && entry.type !== "tree" ? [[entry.path, entry]] : []));
  const paths = [...new Set([...baseByPath.keys(), ...latestByPath.keys()])].sort();
  const files = paths.flatMap((filename) => {
    const before = baseByPath.get(filename);
    const after = latestByPath.get(filename);
    if (before && after && before.sha === after.sha && before.mode === after.mode && before.type === after.type) return [];
    return [{
      filename,
      status: before ? (after ? "modified" : "removed") : "added",
      additions: 0,
      deletions: 0,
      previousFilename: null,
    }];
  });
  return {
    ...sourceDiff,
    files,
    possiblyTruncated: sourceDiff.commits.length < sourceDiff.totalCommits
      || baseTree?.truncated === true
      || latestTree?.truncated === true,
  };
}

export function buildIssueBody({ state, latest, packageVersion, publicVersion, sourceRevision, changes, sourceDiff }) {
  const target = state.integrationTarget?.commit === latest.sha ? state.integrationTarget : null;
  const baseCommit = target?.baseCommit ?? state.latestObserved?.commit;
  const publicLabel = publicVersion ? `v${publicVersion}` : "未进入官网 Changelog";
  const verified = state.verifiedIntegration
    ? `${state.verifiedIntegration.commit}（${state.verifiedIntegration.publicVersion ?? state.verifiedIntegration.packageVersion}）`
    : "无；历史完整集成声明已失效，必须补齐证据";
  const compare = baseCommit && baseCommit !== latest.sha
    ? `https://github.com/xai-org/grok-build/compare/${baseCommit}...${latest.sha}`
    : `https://github.com/xai-org/grok-build/commit/${latest.sha}`;
  const checklist = changes.length > 0
    ? changes.map((change) => [
        `- [ ] **${change.id} · ${change.category}${change.breakingChange ? " · BREAKING" : ""}** — ${change.description}`,
        "  - Grox 影响：`待分析`",
        "  - 桌面融合：`待设计`",
        "  - 验证证据：`待补充`",
      ].join("\n")).join("\n")
    : "- [ ] 官方结构化 Changelog 不可用：先从官网与源码差异建立完整人工清单，禁止直接关闭";
  const sourceCommits = sourceDiff?.commits.length
    ? sourceDiff.commits.map((commit) => `- [ ] \`${commit.sha.slice(0, 12)}\` — ${commit.message}`).join("\n")
    : "- [ ] 未取得提交清单：必须人工检查上方源码差异链接";
  const sourceFiles = sourceDiff?.files.length
    ? sourceDiff.files.map((file) => {
        const rename = file.previousFilename ? `（原路径：\`${file.previousFilename}\`）` : "";
        const stats = file.additions || file.deletions ? `, +${file.additions}/-${file.deletions}` : "";
        return `- [ ] \`${file.filename}\` — ${file.status}${stats}${rename}`;
      }).join("\n")
    : "- [ ] 未取得变更文件清单：必须人工检查上方源码差异链接";
  const sourceWarning = sourceDiff?.possiblyTruncated
    ? "> **警告：GitHub Compare API 返回可能被截断。必须继续分页/本地 diff，不能以本清单作为完整性证据。**"
    : "> 此清单是源码审计输入，不代表每个文件都需要修改 Grox；每项仍须记录影响或不适用理由。";

  return `${MARKER_PREFIX}${latest.sha} -->
# Grok Build ${publicLabel} 全面适配

> **状态：未完成。** 本 issue 不是更新提醒的收件箱，而是上游变化逐项融入 Grox 桌面产品的验收清单。仅确认 ACP 不崩溃不能关闭本 issue。

## 版本身份

- 官网产品版本：${publicLabel}
- 源码包版本：${packageVersion}
- 官方提交：${latest.sha}
- Source-Revision：${sourceRevision ?? "上游提交未提供"}
- 当前验证集成基线：${verified}
- 源码差异：${compare}
- 变化项数量：${changes.length}
- 适配记录：直接维护在本 Issue，并链接具体代码和测试；不得为此提交根目录 \`docs/\`

## 上游变化逐项矩阵

每一项都必须填写 Grox 影响、非终端桌面融合方式和验证证据。对于“继承变化”，仍须提供真实 CLI 的 Grox 场景测试；对于“不适用”，必须说明其用户目标为何在 Grox 中已由其他机制覆盖。

${checklist}

## 源码审计输入（不能由 Changelog 替代）

结构化发布说明可能合并或遗漏实现变化。以下提交与文件必须逐项审查，并将用户可见功能、协议、行为和 bug 修复回填到适配矩阵。

${sourceWarning}

### 提交（${sourceDiff?.commits.length ?? 0}/${sourceDiff?.totalCommits ?? 0}）

${sourceCommits}

### 变更文件（${sourceDiff?.files.length ?? 0}）

${sourceFiles}

## 关闭门禁

- [ ] 官网 Changelog、内部 Changelog 和源码差异已交叉核对
- [ ] 每个变化项都有桌面融合决策，且没有笼统的“忽略未知字段”结论
- [ ] 所有需要 Grox 改动的项目均已实现并有自动测试
- [ ] 所有继承变化均使用本次官方 CLI 在 Grox 场景验证
- [ ] Windows 完整回归通过
- [ ] macOS Apple Silicon 与 Intel 的关键路径回归通过
- [ ] ACP 初始化、会话重挂接/关闭、更新流、工具、权限、模式、模型、认证、队列均有证据
- [ ] 本 Issue 已逐项记录结论并链接具体代码/测试
- [ ] 最后才允许推进 verifiedIntegration 并关闭本 issue
`;
}

export function findTrackedIssue(issues, commit) {
  const marker = `${MARKER_PREFIX}${commit} -->`;
  return issues.find((issue) => typeof issue.body === "string" && issue.body.includes(marker))
    ?? null;
}

async function githubJson(path, token) {
  const response = await fetch(`https://api.github.com${path}`, {
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "Grox-upstream-tracker",
    },
  });
  if (!response.ok) throw new Error(`GitHub API ${response.status}: ${await response.text()}`);
  return response.json();
}

async function githubRaw(owner, repo, path, ref, token) {
  const response = await fetch(`https://api.github.com/repos/${owner}/${repo}/contents/${path}?ref=${ref}`, {
    headers: {
      Accept: "application/vnd.github.raw+json",
      Authorization: `Bearer ${token}`,
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "Grox-upstream-tracker",
    },
  });
  if (!response.ok) throw new Error(`GitHub raw ${response.status} (${path}): ${await response.text()}`);
  return response.text();
}

function gh(args, options = {}) {
  return execFileSync("gh", args, { encoding: "utf8", ...options }).trim();
}

async function main() {
  const statePath = fileURLToPath(new URL("../.grox/official-cli.json", import.meta.url));
  const state = JSON.parse(readFileSync(statePath, "utf8"));
  const token = process.env.GH_TOKEN;
  const repository = process.env.GITHUB_REPOSITORY;
  if (!token || !repository) throw new Error("GH_TOKEN 与 GITHUB_REPOSITORY 必须存在");
  const [owner, repo] = repository.split("/");
  const upstream = new URL(state.repository);
  const [upstreamOwner, upstreamRepo] = upstream.pathname.replace(/^\//, "").replace(/\.git$/, "").split("/");
  const latest = await githubJson(`/repos/${upstreamOwner}/${upstreamRepo}/commits/${state.branch}`, token);

  if (state.verifiedIntegration?.commit === latest.sha) {
    console.log(`最新官方提交 ${latest.sha} 已达到验证集成状态。`);
    return;
  }

  const cargo = await githubRaw(
    upstreamOwner,
    upstreamRepo,
    "crates/codegen/xai-grok-shell/Cargo.toml",
    latest.sha,
    token,
  );
  const packageVersion = parsePackageVersion(cargo);
  let changes = [];
  if (shouldLoadChangelog(state, latest.sha, packageVersion)) {
    try {
      const changelog = await githubRaw(
        upstreamOwner,
        upstreamRepo,
        `crates/codegen/xai-grok-shell/changelogs/${packageVersion}.json`,
        latest.sha,
        token,
      );
      changes = normalizeChanges(JSON.parse(changelog));
    } catch (error) {
      console.warn(`无法读取结构化 Changelog：${error instanceof Error ? error.message : String(error)}`);
    }
  } else {
    console.log(`提交 ${latest.sha} 没有新的公开版本，跳过复用 package ${packageVersion} 的旧 Changelog。`);
    changes = parseCommitChanges(latest.commit.message);
  }

  const publicVersion = state.integrationTarget?.commit === latest.sha
    ? state.integrationTarget.publicVersion
    : state.latestObserved?.commit === latest.sha
      ? state.latestObserved.publicVersion
      : null;
  let sourceRevision = parseSourceRevision(latest.commit.message);
  if (!sourceRevision) {
    try {
      sourceRevision = parseSourceRevisionFile(await githubRaw(
        upstreamOwner,
        upstreamRepo,
        "SOURCE_REV",
        latest.sha,
        token,
      ));
    } catch (error) {
      console.warn(`无法读取 SOURCE_REV：${error instanceof Error ? error.message : String(error)}`);
    }
  }
  const target = state.integrationTarget?.commit === latest.sha ? state.integrationTarget : null;
  const baseCommit = target?.baseCommit ?? state.latestObserved?.commit;
  let sourceDiff = null;
  if (baseCommit && baseCommit !== latest.sha) {
    try {
      const comparison = await githubJson(
        `/repos/${upstreamOwner}/${upstreamRepo}/compare/${baseCommit}...${latest.sha}`,
        token,
      );
      sourceDiff = normalizeSourceDiff(comparison);
      if (sourceDiff?.files.length >= 300) {
        const [baseTree, latestTree] = await Promise.all([
          githubJson(`/repos/${upstreamOwner}/${upstreamRepo}/git/trees/${baseCommit}?recursive=1`, token),
          githubJson(`/repos/${upstreamOwner}/${upstreamRepo}/git/trees/${latest.sha}?recursive=1`, token),
        ]);
        sourceDiff = expandSourceDiffWithTrees(sourceDiff, baseTree, latestTree);
      }
    } catch (error) {
      console.warn(`无法读取源码 Compare：${error instanceof Error ? error.message : String(error)}`);
    }
  }
  const body = buildIssueBody({ state, latest, packageVersion, publicVersion, sourceRevision, changes, sourceDiff });
  const issues = JSON.parse(gh([
    "issue", "list", "--repo", repository, "--state", "all", "--limit", "200", "--json", "number,title,body,state",
  ]) || "[]");
  const existing = findTrackedIssue(issues, latest.sha);
  if (existing) {
    const title = `[Upstream][待全面适配] Grok Build ${versionLabel(publicVersion, packageVersion, latest.sha)}`;
    if (existing.body !== body || existing.title !== title) {
      gh([
        "issue", "edit", String(existing.number), "--repo", repository,
        "--title", title,
        "--body-file", "-",
      ], { input: body });
    }
    if (existing.state === "CLOSED") {
      gh(["issue", "reopen", String(existing.number), "--repo", repository]);
      console.log(`已重新打开未完成的上游适配 issue #${existing.number}。`);
    } else {
      console.log(`上游提交 ${latest.sha} 的全面适配 issue #${existing.number} 仍处于打开状态。`);
    }
    return;
  }

  const title = `[Upstream][待全面适配] Grok Build ${versionLabel(publicVersion, packageVersion, latest.sha)}`;
  gh(["issue", "create", "--repo", repository, "--title", title, "--body-file", "-"], { input: body });
  console.log(`已为 ${latest.sha} 创建逐项全面适配 issue。`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
