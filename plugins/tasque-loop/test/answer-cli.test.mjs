import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { appendEscalation, approvePlan, runPaths } from "../scripts/lib/run.mjs";
import { approvableProject, decidedPlan } from "./helpers.mjs";

const CLI = fileURLToPath(new URL("../scripts/answer.mjs", import.meta.url));

/**
 * 承認済みのラン。escalations.json はまだない。
 */
async function approved() {
  const repo = await approvableProject();
  const plan = decidedPlan();
  approvePlan(repo.dir, plan);
  const { CLAUDE_PROJECT_DIR, ...env } = process.env;
  const run = (...args) => spawnSync(process.execPath, [CLI, ...args], { cwd: repo.dir, env, encoding: "utf8" });
  const answer = (task, file) => run("--run", plan.run, "--task", task, "--answer-file", file);
  const file = runPaths(repo.dir, plan.run).escalations;
  const list = () => JSON.parse(readFileSync(file, "utf8"));
  return { dir: repo.dir, plan, run, answer, file, list };
}

const isIso = (s) => typeof s === "string" && new Date(s).toISOString() === s;

test("そのタスクの最新の未回答の項目に、回答の原文と回答日時を付ける", async () => {
  const { dir, plan, answer, list } = await approved();
  appendEscalation(dir, plan.run, { task: "T1", q: "q1" });
  appendEscalation(dir, plan.run, { task: "T2", q: "q2" });
  appendEscalation(dir, plan.run, { task: "T1", q: "q3", context: "c3" });
  const text = "既定値で `x` $(echo pwned) \"y\" $HOME\n2行目";
  writeFileSync(join(dir, "a.txt"), `${text}\n`);

  const r = answer("T1", "a.txt");
  assert.equal(r.status, 0, r.stderr);

  const [e1, e2, e3] = list();
  assert.equal(e3.answer, text);
  assert.ok(isIso(e3.answered_at), e3.answered_at);
  assert.deepEqual([e3.task, e3.q, e3.context, e3.raised_by], ["T1", "q3", "c3", "implementer"]);
  assert.equal("answer" in e1, false);
  assert.equal("answered_at" in e1, false);
  assert.equal("answer" in e2, false);
});

test("回答済みの項目は飛ばし、残る未回答の項目に付ける。なくなったらエラーにして何も変えない", async () => {
  const { dir, plan, answer, file, list } = await approved();
  appendEscalation(dir, plan.run, { task: "T1", q: "q1" });
  appendEscalation(dir, plan.run, { task: "T1", q: "q2" });
  writeFileSync(join(dir, "a.txt"), "一つ目\r\n");
  writeFileSync(join(dir, "b.txt"), "二つ目");
  writeFileSync(join(dir, "c.txt"), "三つ目");

  assert.equal(answer("T1", "a.txt").status, 0);
  assert.equal(answer("T1", "b.txt").status, 0);
  assert.deepEqual(list().map((e) => [e.q, e.answer]), [["q1", "二つ目"], ["q2", "一つ目"]]);

  const before = readFileSync(file, "utf8");
  const r = answer("T1", "c.txt");
  assert.equal(r.status, 1);
  assert.equal(readFileSync(file, "utf8"), before);
});

test("そのタスクのエスカレーションがない、または escalations.json がなければエラーにする", async () => {
  const { dir, plan, answer, file } = await approved();
  writeFileSync(join(dir, "a.txt"), "回答");

  assert.equal(answer("T1", "a.txt").status, 1);
  assert.equal(existsSync(file), false);

  appendEscalation(dir, plan.run, { task: "T2", q: "q" });
  assert.equal(answer("T1", "a.txt").status, 1);
  assert.equal(answer("T9", "a.txt").status, 1);
});

test("--run・--task・--answer-file のどれかがなければ使い方を出して止まる", async () => {
  const { dir, plan, run } = await approved();
  writeFileSync(join(dir, "a.txt"), "回答");
  for (const args of [
    [],
    ["--task", "T1", "--answer-file", "a.txt"],
    ["--run", plan.run, "--answer-file", "a.txt"],
    ["--run", plan.run, "--task", "T1"],
  ]) {
    const r = run(...args);
    assert.equal(r.status, 2, `${args.join(" ")}: ${r.stderr}`);
    assert.match(r.stderr, /usage/);
  }
});

test("読めない回答ファイルはエラーにし、何も変えない", async () => {
  const { dir, plan, answer, file } = await approved();
  appendEscalation(dir, plan.run, { task: "T1", q: "q1" });
  const before = readFileSync(file, "utf8");
  const r = answer("T1", "missing.txt");
  assert.equal(r.status, 1);
  assert.match(r.stderr, /missing\.txt/);
  assert.equal(readFileSync(file, "utf8"), before);
});
