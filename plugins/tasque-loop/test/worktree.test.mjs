import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveProjectDir } from "../scripts/lib/git.mjs";
import { decideHook, IMPLEMENTER } from "../scripts/lib/guard.mjs";
import { approvePlan } from "../scripts/lib/run.mjs";
import { verifyBaseline } from "../scripts/lib/verify.mjs";
import { decidedPlan, examplePlan, makeRepo } from "./helpers.mjs";

const real = (p) => realpathSync.native(p).toLowerCase();
const same = (a, b) => assert.equal(real(a), real(b));
const script = (name) => fileURLToPath(new URL(`../scripts/${name}`, import.meta.url));

/**
 * リポジトリと、その中（.claude/worktrees/x）と外に作った worktree。sub を指定するとプロジェクトはそのサブディレクトリ。
 */
function withWorktrees({ sub = "" } = {}) {
  const repo = makeRepo({ sub, files: sub ? { "package.json": "{}\n" } : {} });
  const inner = join(repo.root, ".claude", "worktrees", "x");
  const outer = join(mkdtempSync(join(tmpdir(), "tasque-wt-")), "y");
  execFileSync("git", ["worktree", "add", "-q", "-b", "wt-x", inner], { cwd: repo.root });
  execFileSync("git", ["worktree", "add", "-q", "-b", "wt-y", outer], { cwd: repo.root });
  return { ...repo, inner, outer };
}

test("resolveProjectDir: worktree の中の cwd なら、その worktree をプロジェクトにする", () => {
  const { root, inner, outer } = withWorktrees();
  same(resolveProjectDir({ cwd: inner, envProjectDir: root }), inner);
  same(resolveProjectDir({ cwd: outer, envProjectDir: root }), outer);
  mkdirSync(join(inner, "src"), { recursive: true });
  same(resolveProjectDir({ cwd: join(inner, "src"), envProjectDir: root }), inner);
  same(resolveProjectDir({ cwd: root, envProjectDir: root }), root);
});

test("resolveProjectDir: CLAUDE_PROJECT_DIR のリポジトリ内のオフセットを worktree 側にも適用する", () => {
  const { root, dir, inner } = withWorktrees({ sub: "packages/app" });
  same(resolveProjectDir({ cwd: inner, envProjectDir: dir }), join(inner, "packages", "app"));
  same(resolveProjectDir({ cwd: join(inner, "packages", "app"), envProjectDir: dir }), join(inner, "packages", "app"));
  same(resolveProjectDir({ cwd: root, envProjectDir: dir }), dir);
});

test("resolveProjectDir: リポジトリ外・別リポジトリの cwd なら CLAUDE_PROJECT_DIR、未設定なら cwd", () => {
  const { root } = withWorktrees();
  const other = makeRepo().root;
  const plain = mkdtempSync(join(tmpdir(), "tasque-plain-"));
  same(resolveProjectDir({ cwd: other, envProjectDir: root }), root);
  same(resolveProjectDir({ cwd: plain, envProjectDir: root }), root);
  same(resolveProjectDir({ cwd: root, envProjectDir: plain }), plain);
  same(resolveProjectDir({ cwd: plain, envProjectDir: undefined }), plain);
});

test("フック: CLAUDE_PROJECT_DIR が元のリポジトリでも、worktree の中の書き込みを worktree の契約で判定する", async () => {
  const { root, inner } = withWorktrees();
  await verifyBaseline(inner);
  for (const t of examplePlan().tasks.flatMap((x) => x.tests)) {
    mkdirSync(join(inner, t, ".."), { recursive: true });
    writeFileSync(join(inner, t), "");
  }
  const plan = decidedPlan();
  approvePlan(inner, plan);
  writeFileSync(join(inner, ".tasque", "current"), JSON.stringify({ run: plan.run, task: "T2" }));

  const hook = (file) =>
    execFileSync("node", [script("guard.mjs")], {
      input: JSON.stringify({
        agent_type: IMPLEMENTER,
        tool_name: "Write",
        tool_input: { file_path: file, content: "x" },
        cwd: inner,
      }),
      env: { ...process.env, CLAUDE_PROJECT_DIR: root },
      encoding: "utf8",
    });
  assert.equal(hook(join(inner, "src", "cli.ts")), "");
  assert.match(hook(join(inner, "src", "index.ts")), /許可リスト外/);
  assert.match(hook(join(root, "src", "cli.ts")), /プロジェクトの外/);
});

test("フック: プロジェクトディレクトリを決められなければ tasque-loop のエージェントは拒否する", () => {
  const fail = () => {
    throw new Error("git がない");
  };
  const input = { agent_type: IMPLEMENTER, tool_name: "Read", tool_input: { file_path: "a" }, cwd: tmpdir() };
  const r = decideHook(input, { envProjectDir: tmpdir(), resolveDir: fail });
  assert.equal(r?.hookSpecificOutput?.permissionDecision, "deny");
  assert.equal(decideHook({ ...input, agent_type: undefined }, { envProjectDir: tmpdir(), resolveDir: fail }), null);
});

test("verify CLI: cwd が worktree なら、CLAUDE_PROJECT_DIR が元のリポジトリでも worktree を検査する", () => {
  const { root, inner } = withWorktrees();
  execFileSync("git", ["commit", "-q", "--allow-empty", "-m", "worktree だけのコミット"], { cwd: inner });
  execFileSync("node", [script("verify.mjs"), "--phase", "baseline"], {
    cwd: inner,
    env: { ...process.env, CLAUDE_PROJECT_DIR: root },
    encoding: "utf8",
  });
  const baseline = JSON.parse(readFileSync(join(inner, ".tasque", "baseline.json"), "utf8"));
  assert.equal(baseline.commit, execFileSync("git", ["rev-parse", "HEAD"], { cwd: inner, encoding: "utf8" }).trim());
  assert.equal(baseline.branch, "wt-x");
});
