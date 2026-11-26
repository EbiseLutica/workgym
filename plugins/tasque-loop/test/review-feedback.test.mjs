import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { planDigest } from "../scripts/lib/plan-check.mjs";
import { approvePlan, baselinePath, runPaths } from "../scripts/lib/run.mjs";
import { approvableProject, decidedPlan, examplePlan } from "./helpers.mjs";

const CLI = fileURLToPath(new URL("../scripts/review-feedback.mjs", import.meta.url));

/**
 * 下書き（.tasque/plan.draft.json）とテストファイルがあるプロジェクト。
 */
async function drafted() {
  const repo = await approvableProject();
  const plan = examplePlan();
  repo.put(".tasque/plan.draft.json", JSON.stringify(plan, null, 2));
  const { CLAUDE_PROJECT_DIR, ...env } = process.env;
  const run = (...args) => spawnSync(process.execPath, [CLI, ...args], { cwd: repo.dir, env, encoding: "utf8" });
  const reviewsFile = join(repo.dir, ".tasque", "plan.draft.reviews.json");
  const reviews = () => JSON.parse(readFileSync(reviewsFile, "utf8"));
  const digest = () => planDigest(repo.dir, JSON.parse(readFileSync(join(repo.dir, ".tasque/plan.draft.json"), "utf8")));
  return { ...repo, plan, run, reviews, reviewsFile, digest };
}

const isIso = (s) => typeof s === "string" && new Date(s).toISOString() === s;

test("レビュー結果を1回分ずつ追記し、人間の言葉はファイルから原文のまま記録する", async () => {
  const { dir, put, run, reviews, digest } = await drafted();
  const first = "T2 の `allow` が狭い $(echo pwned) \"x\" $HOME\n2行目";
  writeFileSync(join(dir, "fb1.txt"), `${first}\n`);
  const digest1 = digest();

  const r1 = run("--verdict", "changes_requested", "--text-file", "fb1.txt");
  assert.equal(r1.status, 0, r1.stderr);

  put("test/cli.test.ts", "// 直した\n");
  writeFileSync(join(dir, "fb2.txt"), "OK\r\n");
  const digest2 = digest();
  const r2 = run("--verdict", "approved", "--text-file", "fb2.txt");
  assert.equal(r2.status, 0, r2.stderr);

  const list = reviews();
  assert.equal(list.length, 2);
  assert.deepEqual(
    list.map((e) => [e.verdict, e.text, e.draft_digest]),
    [
      ["changes_requested", first, digest1],
      ["approved", "OK", digest2],
    ],
  );
  assert.notEqual(digest1, digest2);
  assert.ok(list.every((e) => isIso(e.at)), JSON.stringify(list));
});

test("verdict か --text-file がない、または verdict が不正なら使い方を出して止まり、何も記録しない", async () => {
  const { dir, run, reviewsFile } = await drafted();
  writeFileSync(join(dir, "fb.txt"), "直して");
  for (const args of [
    [],
    ["--verdict", "approved"],
    ["--text-file", "fb.txt"],
    ["--verdict", "rejected", "--text-file", "fb.txt"],
  ]) {
    const r = run(...args);
    assert.equal(r.status, 2, `${args.join(" ")}: ${r.stderr}`);
    assert.match(r.stderr, /usage/);
  }
  assert.equal(existsSync(reviewsFile), false);
});

test("読めない text ファイルはエラーにし、何も記録しない", async () => {
  const { run, reviewsFile } = await drafted();
  const r = run("--verdict", "approved", "--text-file", "missing.txt");
  assert.equal(r.status, 1);
  assert.match(r.stderr, /missing\.txt/);
  assert.equal(existsSync(reviewsFile), false);
});

test("下書きがなければエラーにし、何も記録しない", async () => {
  const { dir, run, reviewsFile } = await drafted();
  rmSync(join(dir, ".tasque/plan.draft.json"));
  writeFileSync(join(dir, "fb.txt"), "直して");
  const r = run("--verdict", "changes_requested", "--text-file", "fb.txt");
  assert.equal(r.status, 1);
  assert.equal(existsSync(reviewsFile), false);
});

test("承認時にレビューの記録をランのディレクトリの reviews.json に移す", async () => {
  const { dir, run, reviews, reviewsFile } = await drafted();
  writeFileSync(join(dir, "fb1.txt"), "直して");
  writeFileSync(join(dir, "fb2.txt"), "OK");
  assert.equal(run("--verdict", "changes_requested", "--text-file", "fb1.txt").status, 0);
  assert.equal(run("--verdict", "approved", "--text-file", "fb2.txt").status, 0);
  const before = reviews();

  const plan = decidedPlan();
  approvePlan(dir, plan);

  const moved = join(runPaths(dir, plan.run).dir, "reviews.json");
  assert.deepEqual(JSON.parse(readFileSync(moved, "utf8")), before);
  assert.equal(existsSync(reviewsFile), false);
});

test("レビューの記録がなくても承認でき、reviews.json は作らない", async () => {
  const { dir } = await drafted();
  const plan = decidedPlan();
  approvePlan(dir, plan);
  assert.equal(existsSync(join(runPaths(dir, plan.run).dir, "reviews.json")), false);
});

test("承認に失敗したらレビューの記録は元の場所に残す", async () => {
  const { dir, run, reviews, reviewsFile } = await drafted();
  writeFileSync(join(dir, "fb.txt"), "OK");
  assert.equal(run("--verdict", "approved", "--text-file", "fb.txt").status, 0);
  const before = reviews();

  rmSync(baselinePath(dir));
  const plan = decidedPlan();
  assert.throws(() => approvePlan(dir, plan), /baseline/);
  assert.deepEqual(JSON.parse(readFileSync(reviewsFile, "utf8")), before);
  assert.equal(existsSync(join(runPaths(dir, plan.run).dir, "reviews.json")), false);
});
