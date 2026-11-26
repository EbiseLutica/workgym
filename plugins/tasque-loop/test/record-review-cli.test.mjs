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

/**
 * 正しい形の指摘。extra で項目を差し替える。
 */
const finding = (extra = {}) => ({
  perspective: "正確性",
  severity: "major",
  location: "scripts/a.mjs:10",
  problem: "境界値で落ちる",
  fix: "<= にする",
  disposition: "fix",
  found_by: ["並列:正確性"],
  ...extra,
});

/**
 * 名前つきの不正な入力をひとつずつ T1 の round に記録し、どれも exit 1 で何も書かないことを確かめる。
 * 入力は JSON にする値、または JSON として書く文字列。
 */
function assertAllRejected({ record, put, reviewFile }, round, cases) {
  for (const [name, value] of Object.entries(cases)) {
    put("bad.json", value);
    const r = record("T1", round, "bad.json");
    assert.equal(r.status, 1, `${name}: ${r.stderr}`);
    assert.equal(existsSync(reviewFile("T1", round)), false, name);
  }
}

const isIso = (s) => typeof s === "string" && new Date(s).toISOString() === s;

// ---- 正常系: 記録される ----

test("正常系: 指摘の配列を tasks/<id>.review-<round>.json に run・task・round・recorded_at とともにそのまま書く", async () => {
  const { plan, record, put, reviewFile } = await approved();
  const cases = {
    "found_by が並列の1体だけ": finding(),
    "found_by が並列2体": finding({ perspective: "整合", severity: "minor", disposition: "carryover", found_by: ["並列:整合", "並列:正確性"] }),
    "found_by が並列と1体（ラウンド1では1体を含んでよい）": finding({ perspective: "要件", severity: "blocker", found_by: ["並列:要件", "1体"] }),
    "found_by が1体だけ": finding({ severity: "nit", disposition: "rejected", reject_reason: "コードで確かめたら境界は扱えていた", found_by: ["1体"] }),
    "found_by に4つの値すべて": finding({ found_by: ["並列:要件", "並列:正確性", "並列:整合", "1体"] }),
  };
  const findings = Object.values(cases);
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

test("正常系: 指摘なし（空配列）も記録でき、ラウンド2は別のファイルに書く", async () => {
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

test("正常系: ラウンド2では並列だけが見つけた指摘を記録できる", async () => {
  const { record, put, reviewFile } = await approved();
  put("one.json", [finding({ found_by: ["1体"] })]);
  assert.equal(record("T1", 1, "one.json").status, 0);

  const findings = [finding(), finding({ perspective: "要件", found_by: ["並列:要件", "並列:整合"] })];
  put("two.json", findings);
  const r = record("T1", 2, "two.json");
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(readFileSync(reviewFile("T1", 2), "utf8")).findings, findings);
});

// ---- 異常系: 拒否される ----

test("異常系: JSON・配列・found_by 以外の項目の形が不正なら exit 1 で何も書かない", async () => {
  const s = await approved();
  const { location, ...noLocation } = finding();
  const { problem, ...noProblem } = finding();
  const { fix, ...noFix } = finding();
  const { perspective, ...noPerspective } = finding();
  assertAllRejected(s, 1, {
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
    "正しい指摘に不正な指摘が混ざっている": [finding(), finding({ severity: "high" })],
  });
});

test("異常系: found_by がない、または形・値が不正なら exit 1 で何も書かない", async () => {
  const s = await approved();
  const { found_by, ...noFoundBy } = finding();
  assertAllRejected(s, 1, {
    "found_by がない": [noFoundBy],
    "found_by が空の配列": [finding({ found_by: [] })],
    "found_by が配列でない": [finding({ found_by: "1体" })],
    "found_by が null": [finding({ found_by: null })],
    "found_by に決められていない値がある": [finding({ found_by: ["並列:性能"] })],
    "found_by に観点名だけの値がある": [finding({ found_by: ["正確性"] })],
    "found_by に文字列でない値がある": [finding({ found_by: ["1体", 1] })],
    "found_by に同じ値が重なっている": [finding({ found_by: ["並列:正確性", "並列:正確性"] })],
    "正しい指摘に found_by の不正な指摘が混ざっている": [finding(), finding({ found_by: ["1体", "1体"] })],
  });
});

test("異常系: ラウンド2で found_by に 1体 を含む指摘があれば exit 1 で何も書かない", async () => {
  const s = await approved();
  s.put("one.json", [finding({ found_by: ["1体"] })]);
  assert.equal(s.record("T1", 1, "one.json").status, 0);

  assertAllRejected(s, 2, {
    "1体だけ": [finding({ found_by: ["1体"] })],
    "並列と1体": [finding({ found_by: ["並列:要件", "1体"] })],
    "並列だけの指摘に混ざっている": [finding(), finding({ found_by: ["並列:整合", "1体"] })],
  });
});

test("異常系: 同じラウンドを2回書くのはエラーにし、最初の記録を変えない", async () => {
  const { record, put, reviewFile } = await approved();
  put("a.json", [finding()]);
  put("b.json", []);
  assert.equal(record("T1", 1, "a.json").status, 0);
  const before = readFileSync(reviewFile("T1", 1), "utf8");

  const r = record("T1", 1, "b.json");
  assert.equal(r.status, 1);
  assert.equal(readFileSync(reviewFile("T1", 1), "utf8"), before);
});

test("異常系: 読めない findings-file はエラーにし、何も書かない", async () => {
  const { record, reviewFile } = await approved();
  const r = record("T1", 1, "missing.json");
  assert.equal(r.status, 1);
  assert.match(r.stderr, /missing\.json/);
  assert.equal(existsSync(reviewFile("T1", 1)), false);
});

test("異常系: 引数が足りない、または --round が 1・2 以外なら使い方を出して exit 2 で止まる", async () => {
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
