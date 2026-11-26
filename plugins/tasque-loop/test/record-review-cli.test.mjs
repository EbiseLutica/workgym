import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { approvePlan, runPaths } from "../scripts/lib/run.mjs";
import { approvableProject, decidedPlan } from "./helpers.mjs";

const CLI = fileURLToPath(new URL("../scripts/record-review.mjs", import.meta.url));

/**
 * 承認済みのラン。レビュー結果はまだない。
 */
async function approved() {
  const repo = await approvableProject();
  const plan = decidedPlan();
  approvePlan(repo.dir, plan);
  const { CLAUDE_PROJECT_DIR, ...env } = process.env;
  const run = (...args) => spawnSync(process.execPath, [CLI, ...args], { cwd: repo.dir, env, encoding: "utf8" });
  const record = (task, round, file) =>
    run("--run", plan.run, "--task", task, "--round", String(round), "--findings-file", file);
  const put = (name, value) =>
    writeFileSync(join(repo.dir, name), typeof value === "string" ? value : JSON.stringify(value, null, 2));
  const reviewFile = (task, round) => join(runPaths(repo.dir, plan.run).dir, "tasks", `${task}.review-${round}.json`);
  return { dir: repo.dir, plan, run, record, put, reviewFile };
}

const finding = (extra = {}) => ({
  perspective: "正確性",
  severity: "major",
  location: "scripts/a.mjs:10",
  problem: "境界値で落ちる",
  fix: "<= にする",
  disposition: "fix",
  ...extra,
});

const isIso = (s) => typeof s === "string" && new Date(s).toISOString() === s;

test("指摘の配列を tasks/<id>.review-<round>.json に run・task・round・recorded_at とともに書く", async () => {
  const { plan, record, put, reviewFile } = await approved();
  const findings = [
    finding({ perspective: "要件", severity: "blocker" }),
    finding(),
    finding({ perspective: "整合", severity: "minor", disposition: "carryover" }),
    finding({ severity: "nit", disposition: "rejected", reject_reason: "コードで確かめたら境界は扱えていた" }),
  ];
  put("f.json", findings);

  const r = record("T1", 1, "f.json");
  assert.equal(r.status, 0, r.stderr);

  const saved = JSON.parse(readFileSync(reviewFile("T1", 1), "utf8"));
  assert.equal(saved.run, plan.run);
  assert.equal(saved.task, "T1");
  assert.equal(saved.round, 1);
  assert.ok(isIso(saved.recorded_at), saved.recorded_at);
  assert.deepEqual(saved.findings, findings);
});

test("指摘なし（空配列）も記録でき、ラウンド2は別のファイルに書く", async () => {
  const { record, put, reviewFile } = await approved();
  put("one.json", [finding()]);
  put("none.json", []);

  assert.equal(record("T1", 1, "one.json").status, 0);
  const r = record("T1", 2, "none.json");
  assert.equal(r.status, 0, r.stderr);

  assert.equal(JSON.parse(readFileSync(reviewFile("T1", 1), "utf8")).findings.length, 1);
  const second = JSON.parse(readFileSync(reviewFile("T1", 2), "utf8"));
  assert.equal(second.round, 2);
  assert.deepEqual(second.findings, []);
});

test("形が不正なら exit 1 で何も書かない", async () => {
  const { record, put, reviewFile } = await approved();
  const { location, ...noLocation } = finding();
  const { problem, ...noProblem } = finding();
  const { fix, ...noFix } = finding();
  const { perspective, ...noPerspective } = finding();
  const cases = {
    "JSON でない": "[{",
    "配列でない": finding(),
    "要素がオブジェクトでない": ["指摘"],
    "要素が null": [null],
    "perspective が不正": [finding({ perspective: "性能" })],
    "perspective がない": [noPerspective],
    "severity が不正": [finding({ severity: "critical" })],
    "disposition が不正": [finding({ disposition: "later" })],
    "location がない": [noLocation],
    "problem がない": [noProblem],
    "fix がない": [noFix],
    "rejected なのに reject_reason がない": [finding({ disposition: "rejected" })],
    "不正な要素が混ざっている": [finding(), finding({ severity: "high" })],
  };
  for (const [name, value] of Object.entries(cases)) {
    put("bad.json", value);
    const r = record("T1", 1, "bad.json");
    assert.equal(r.status, 1, `${name}: ${r.stderr}`);
    assert.equal(existsSync(reviewFile("T1", 1)), false, name);
  }
});

test("同じラウンドを2回書くのはエラーにし、最初の記録を変えない", async () => {
  const { record, put, reviewFile } = await approved();
  put("a.json", [finding()]);
  put("b.json", []);
  assert.equal(record("T1", 1, "a.json").status, 0);
  const before = readFileSync(reviewFile("T1", 1), "utf8");

  const r = record("T1", 1, "b.json");
  assert.equal(r.status, 1);
  assert.equal(readFileSync(reviewFile("T1", 1), "utf8"), before);
});

test("読めない findings-file はエラーにし、何も書かない", async () => {
  const { record, reviewFile } = await approved();
  const r = record("T1", 1, "missing.json");
  assert.equal(r.status, 1);
  assert.match(r.stderr, /missing\.json/);
  assert.equal(existsSync(reviewFile("T1", 1)), false);
});

test("引数が足りない、または --round が 1・2 以外なら使い方を出して止まる", async () => {
  const { plan, run, put, reviewFile } = await approved();
  put("f.json", []);
  const full = { "--run": plan.run, "--task": "T1", "--round": "1", "--findings-file": "f.json" };
  const argsWithout = (key) => Object.entries(full).filter(([k]) => k !== key).flat();
  const cases = [
    [],
    ...Object.keys(full).map(argsWithout),
    ...["0", "3", "x", "1.5"].map((round) => Object.entries({ ...full, "--round": round }).flat()),
  ];
  for (const args of cases) {
    const r = run(...args);
    assert.equal(r.status, 2, `${args.join(" ")}: ${r.stderr}`);
    assert.match(r.stderr, /usage/);
  }
  assert.equal(existsSync(reviewFile("T1", 1)), false);
});
