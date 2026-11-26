import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { approvePlan, runPaths } from "../scripts/lib/run.mjs";
import { approvableProject, decidedPlan } from "./helpers.mjs";

const CLI = fileURLToPath(new URL("../scripts/escalate.mjs", import.meta.url));

async function approved() {
  const repo = await approvableProject();
  const plan = decidedPlan();
  approvePlan(repo.dir, plan);
  const { CLAUDE_PROJECT_DIR, ...env } = process.env;
  const run = (...args) => spawnSync(process.execPath, [CLI, "--run", plan.run, "--task", "T1", ...args], {
    cwd: repo.dir,
    env,
    encoding: "utf8",
  });
  const list = () => JSON.parse(readFileSync(runPaths(repo.dir, plan.run).escalations, "utf8"));
  return { dir: repo.dir, run, list };
}

test("質問と補足をファイルから読み、中身をそのまま記録する", async () => {
  const { dir, run, list } = await approved();
  const q = "`allow` の外 $(echo pwned) \"x\"\nTASQUE_EOF\n2行目";
  writeFileSync(join(dir, "q.txt"), `${q}\n`);
  writeFileSync(join(dir, "ctx.txt"), "補足 $HOME\r\n");

  const r = run("--q-file", "q.txt", "--context-file", "ctx.txt");
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual([list()[0].q, list()[0].context], [q, "補足 $HOME"]);
});

test("--q と --context もこれまでどおり使える", async () => {
  const { run, list } = await approved();
  assert.equal(run("--q", "質問").status, 0);
  assert.deepEqual([list()[0].q, list()[0].context], ["質問", ""]);
});

test("質問がない、または同じ項目を文字列とファイルの両方で渡したら使い方を出して止まる", async () => {
  const { dir, run } = await approved();
  writeFileSync(join(dir, "q.txt"), "q");
  for (const args of [[], ["--q", "a", "--q-file", "q.txt"], ["--q", "a", "--context", "b", "--context-file", "q.txt"]]) {
    const r = run(...args);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /usage/);
  }
});

test("読めないファイルはエラーにする", async () => {
  const { run } = await approved();
  const r = run("--q-file", "missing.txt");
  assert.equal(r.status, 1);
  assert.match(r.stderr, /missing\.txt/);
});
