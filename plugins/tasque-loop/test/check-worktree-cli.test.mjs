import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { makeRepo } from "./helpers.mjs";

const CLI = fileURLToPath(new URL("../scripts/check-worktree.mjs", import.meta.url));

/**
 * リポジトリと、その中（.claude/worktrees/x）と外に作ったリンクされたワークツリー。
 * sub を指定するとプロジェクトはそのサブディレクトリ（innerProject / outerProject はワークツリー側の同じ位置）。
 */
function withWorktrees({ sub = "" } = {}) {
  const repo = makeRepo({ sub, files: sub ? { "package.json": "{}\n" } : {} });
  const inner = join(repo.root, ".claude", "worktrees", "x");
  const outer = join(mkdtempSync(join(tmpdir(), "tasque-wt-")), "y");
  execFileSync("git", ["worktree", "add", "-q", "-b", "wt-x", inner], { cwd: repo.root });
  execFileSync("git", ["worktree", "add", "-q", "-b", "wt-y", outer], { cwd: repo.root });
  return {
    ...repo,
    inner,
    outer,
    innerProject: sub ? join(inner, sub) : inner,
    outerProject: sub ? join(outer, sub) : outer,
  };
}

const { CLAUDE_PROJECT_DIR: _ignored, ...baseEnv } = process.env;

function check(cwd, { args = [], env = baseEnv } = {}) {
  const r = spawnSync(process.execPath, [CLI, ...args], { cwd, env, encoding: "utf8" });
  return { status: r.status, output: `${r.stdout}${r.stderr}` };
}

function writeCurrent(projectDir) {
  mkdirSync(join(projectDir, ".tasque"), { recursive: true });
  writeFileSync(join(projectDir, ".tasque", "current"), JSON.stringify({ run: "2026-11-26-zzzz", task: "T1" }));
}

test("リンクされたワークツリーの中で、.tasque/current も未コミットの変更もなければ exit 0", () => {
  const { inner, outer } = withWorktrees();
  const a = check(inner);
  assert.equal(a.status, 0, a.output);
  const b = check(outer);
  assert.equal(b.status, 0, b.output);
});

test("無視されるファイル（.tasque/ のほかの記録）は未コミットの変更に数えない", () => {
  const { inner } = withWorktrees();
  mkdirSync(join(inner, ".tasque"), { recursive: true });
  writeFileSync(join(inner, ".tasque", "baseline.json"), "{}\n");
  const r = check(inner);
  assert.equal(r.status, 0, r.output);
});

test("元のチェックアウト（リンクされたワークツリーではない）なら exit 1 で理由を出す", () => {
  const { root } = withWorktrees();
  const r = check(root);
  assert.equal(r.status, 1, r.output);
  assert.notEqual(r.output.trim(), "");
});

test("元のチェックアウトのサブディレクトリでも exit 1（git-dir と common-dir を相対パスで比べない）", () => {
  const { root } = withWorktrees();
  const sub = join(root, "src", "deep");
  mkdirSync(sub, { recursive: true });
  const r = check(sub);
  assert.equal(r.status, 1, r.output);
});

test(".tasque/current があれば exit 1 で、理由に .tasque/current を含める", () => {
  const { inner } = withWorktrees();
  writeCurrent(inner);
  const r = check(inner);
  assert.equal(r.status, 1, r.output);
  assert.match(r.output, /\.tasque\/current/);
});

test("追跡中のファイルの変更があれば exit 1", () => {
  const { inner } = withWorktrees();
  writeFileSync(join(inner, "README.md"), "changed\n");
  const r = check(inner);
  assert.equal(r.status, 1, r.output);
  assert.notEqual(r.output.trim(), "");
});

test("ステージ済みの変更があれば exit 1", () => {
  const { inner } = withWorktrees();
  writeFileSync(join(inner, "README.md"), "staged\n");
  execFileSync("git", ["add", "README.md"], { cwd: inner });
  const r = check(inner);
  assert.equal(r.status, 1, r.output);
});

test("追跡されていない新しいファイルがあれば exit 1", () => {
  const { inner } = withWorktrees();
  writeFileSync(join(inner, "new.txt"), "x\n");
  const r = check(inner);
  assert.equal(r.status, 1, r.output);
});

test("モノレポ: ワークツリー内のプロジェクトのサブディレクトリで判定する", () => {
  const { innerProject } = withWorktrees({ sub: "packages/app" });
  const ok = check(innerProject);
  assert.equal(ok.status, 0, ok.output);

  writeCurrent(innerProject);
  const ng = check(innerProject);
  assert.equal(ng.status, 1, ng.output);
  assert.match(ng.output, /\.tasque\/current/);
});

test("モノレポ: プロジェクトの外（ワークツリーの別の場所）の変更でも exit 1（ワークツリー全体で見る）", () => {
  const tracked = withWorktrees({ sub: "packages/app" });
  writeFileSync(join(tracked.inner, "README.md"), "changed outside the project\n");
  const a = check(tracked.innerProject);
  assert.equal(a.status, 1, a.output);

  const untracked = withWorktrees({ sub: "packages/app" });
  mkdirSync(join(untracked.inner, "packages", "other"), { recursive: true });
  writeFileSync(join(untracked.inner, "packages", "other", "new.txt"), "x\n");
  const b = check(untracked.innerProject);
  assert.equal(b.status, 1, b.output);
});

test("CLAUDE_PROJECT_DIR が元のリポジトリでも、カレントディレクトリのワークツリーで判定する", () => {
  const { root, inner } = withWorktrees();
  const env = { ...baseEnv, CLAUDE_PROJECT_DIR: root };
  const ok = check(inner, { env });
  assert.equal(ok.status, 0, ok.output);
  const ng = check(root, { env });
  assert.equal(ng.status, 1, ng.output);
});

test("知らないオプションは使い方の誤りとして exit 2", () => {
  const { inner } = withWorktrees();
  const r = check(inner, { args: ["--bogus"] });
  assert.equal(r.status, 2, r.output);
});

test("git リポジトリの外では git のエラーとして exit 2", () => {
  const plain = mkdtempSync(join(tmpdir(), "tasque-plain-"));
  const r = check(plain);
  assert.equal(r.status, 2, r.output);
});
