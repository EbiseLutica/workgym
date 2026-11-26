import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cleanWorktree, listTasqueWorktrees, parseWorktreeList } from "../scripts/lib/worktrees.mjs";
import { makeRepo } from "./helpers.mjs";

/**
 * 元のチェックアウト（main）と、run スキルが切るのと同じ形のワークツリーを作る。
 */
function setup({ sub = "" } = {}) {
  const repo = makeRepo({ sub, branch: null });
  const add = (name, { current = null, runs = ["r1"] } = {}) => {
    const path = join(repo.root, ".claude", "worktrees", name);
    repo.git("worktree", "add", "-q", "-b", `worktree-${name}`, path);
    const tasque = join(sub ? join(path, sub) : path, ".tasque");
    for (const run of runs) {
      mkdirSync(join(tasque, "runs", run), { recursive: true });
      writeFileSync(join(tasque, "runs", run, "approved.json"), `{"run":"${run}"}\n`);
    }
    if (current) writeFileSync(join(tasque, "current"), JSON.stringify(current));
    return path;
  };
  repo.putRoot(".gitignore", ".tasque/\n.claude/\n");
  repo.git("add", "-A", ":/");
  repo.git("commit", "-q", "-m", "ignore");
  return { ...repo, add };
}

const pr = (state) => () => (state ? { state, url: "https://example.invalid/pr/1" } : null);

test("tasque のワークツリーだけを、ラン・実行中のタスク・未コミットの有無つきで列挙する", () => {
  const { dir, git, add } = setup();
  add("tasque-done");
  const busy = add("tasque-busy", { current: { run: "r1", task: "T2" } });
  add("other");
  writeFileSync(join(busy, "stray.txt"), "x");

  const list = listTasqueWorktrees(dir);
  assert.deepEqual(
    list.map((w) => [w.name, w.branch, w.runs, w.current?.task ?? null, w.dirty]).sort(),
    [
      ["tasque-busy", "worktree-tasque-busy", ["r1"], "T2", true],
      ["tasque-done", "worktree-tasque-done", ["r1"], null, false],
    ],
  );
  assert.equal(git("branch", "--show-current").trim(), "main");
});

test("PR がマージ済みなら .tasque を退避してからワークツリーとブランチを消す", () => {
  const { dir, git, add } = setup();
  const path = add("tasque-done");

  const r = cleanWorktree(dir, "tasque-done", { prState: pr("MERGED") });
  assert.equal(existsSync(path), false);
  assert.equal(git("branch", "--list", "worktree-tasque-done").trim(), "");
  assert.equal(readFileSync(join(r.archive, "runs", "r1", "approved.json"), "utf8"), '{"run":"r1"}\n');
  assert.equal(r.archive, join(dir, ".tasque", "archive", "tasque-done"));
});

test("モノレポではワークツリー側の同じオフセットから読み、元のプロジェクトに退避する", () => {
  const { dir, add } = setup({ sub: "packages/app" });
  add("tasque-mono", { runs: ["m1"] });

  assert.deepEqual(listTasqueWorktrees(dir).map((w) => w.runs), [["m1"]]);
  const r = cleanWorktree(dir, "tasque-mono", { prState: pr("CLOSED") });
  assert.ok(existsSync(join(dir, ".tasque", "archive", "tasque-mono", "runs", "m1", "approved.json")));
  assert.equal(r.archive, join(dir, ".tasque", "archive", "tasque-mono"));
});

test("PR が開いている・PR がない・状態を確かめられないときは何も消さない", () => {
  for (const prState of [pr("OPEN"), pr(null), () => { throw new Error("gh がない"); }]) {
    const { dir, add } = setup();
    const path = add("tasque-x");
    assert.throws(() => cleanWorktree(dir, "tasque-x", { prState }), /PR/);
    assert.ok(existsSync(path));
    assert.equal(existsSync(join(dir, ".tasque", "archive")), false);
  }
});

test("abandon なら PR がなくても片付けられる", () => {
  const { dir, add } = setup();
  const path = add("tasque-x");
  cleanWorktree(dir, "tasque-x", { prState: pr(null), abandon: true });
  assert.equal(existsSync(path), false);
});

test("未コミットの変更がある・退避先がすでにある・tasque のワークツリーでないなら拒否する", () => {
  const { dir, add } = setup();
  const dirty = add("tasque-dirty");
  writeFileSync(join(dirty, "stray.txt"), "x");
  assert.throws(() => cleanWorktree(dir, "tasque-dirty", { prState: pr("MERGED") }), /コミットされていない/);

  add("tasque-dup");
  mkdirSync(join(dir, ".tasque", "archive", "tasque-dup"), { recursive: true });
  assert.throws(() => cleanWorktree(dir, "tasque-dup", { prState: pr("MERGED") }), /退避先/);

  add("other");
  assert.throws(() => cleanWorktree(dir, "other", { prState: pr("MERGED") }), /見つからない/);
});

test("ロックされたワークツリーは、退避も削除もせずに理由を添えて拒否する", () => {
  const { dir, git, add } = setup();
  const path = add("tasque-locked");
  git("worktree", "lock", "--reason", "claude session tasque-locked (pid 1)", path);

  assert.equal(listTasqueWorktrees(dir)[0].locked, "claude session tasque-locked (pid 1)");
  assert.throws(() => cleanWorktree(dir, "tasque-locked", { prState: pr("MERGED") }), /ロック.*pid 1.*unlock/);
  assert.ok(existsSync(path));
  assert.equal(existsSync(join(dir, ".tasque", "archive", "tasque-locked")), false);
});

test("worktree list の出力を読む（detached HEAD はブランチなし、ロックは理由つき）", () => {
  const out =
    "worktree /a\0HEAD 1\0branch refs/heads/main\0\0worktree /b\0HEAD 2\0detached\0locked\0\0" +
    "worktree /c\0HEAD 3\0branch refs/heads/x\0locked in use\0\0";
  assert.deepEqual(parseWorktreeList(out), [
    { path: "/a", branch: "main", locked: null },
    { path: "/b", branch: null, locked: "" },
    { path: "/c", branch: "x", locked: "in use" },
  ]);
});
