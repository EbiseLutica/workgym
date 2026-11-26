import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { decidePlannerStop, draftPaths, PLANNER } from "../scripts/lib/plan-check.mjs";
import {
  appendEscalation,
  approveChecked,
  approvePlan,
  baselinePath,
  ContractError,
  loadApproval,
  loadApproved,
  runPaths,
  sha256Of,
  taskFile,
} from "../scripts/lib/run.mjs";
import { verifyBaseline, verifyRed } from "../scripts/lib/verify.mjs";
import { approvableProject, decidedPlan, examplePlan, makeRepo } from "./helpers.mjs";

test("未決定の uncertain が残る契約は承認できない", async () => {
  const { dir } = await approvableProject();
  const plan = decidedPlan();
  plan.tasks[0].uncertain[0].decision = null;
  assert.throws(() => approvePlan(dir, plan), ContractError);
});

test("承認した契約はハッシュ検証つきで読み戻せる", async () => {
  const { dir } = await approvableProject();
  const plan = decidedPlan();
  approvePlan(dir, plan);
  assert.deepEqual(loadApproved(dir, plan.run), plan);
});

test("承認済みの run は再承認できない", async () => {
  const { dir } = await approvableProject();
  approvePlan(dir, decidedPlan());
  assert.throws(() => approvePlan(dir, decidedPlan()), /新しい run/);
});

test("承認後に書き換えられた契約は読み込みで弾く", async () => {
  const { dir } = await approvableProject();
  const plan = decidedPlan();
  approvePlan(dir, plan);
  const { approved } = runPaths(dir, plan.run);
  chmodSync(approved, 0o644);
  writeFileSync(approved, readFileSync(approved, "utf8").replace('"lines": 150', '"lines": 300'));
  assert.throws(() => loadApproved(dir, plan.run), /書き換えられている/);
});

test("エスカレーションは別ファイルに追記され、契約は変わらない", async () => {
  const { dir } = await approvableProject();
  const plan = decidedPlan();
  approvePlan(dir, plan);
  appendEscalation(dir, plan.run, { task: "T1", q: "既定値の一覧はどこにある？" });
  appendEscalation(dir, plan.run, { task: "T2", q: "--config の相対パスの基準は？", context: "cwd か設定ファイル位置か" });

  const list = JSON.parse(readFileSync(runPaths(dir, plan.run).escalations, "utf8"));
  assert.deepEqual(list.map((e) => e.task), ["T1", "T2"]);
  assert.ok(list.every((e) => e.raised_by === "implementer"));
  assert.deepEqual(loadApproved(dir, plan.run), plan);
});

test("存在しないタスクへのエスカレーションは弾く", async () => {
  const { dir } = await approvableProject();
  const plan = decidedPlan();
  approvePlan(dir, plan);
  assert.throws(() => appendEscalation(dir, plan.run, { task: "T9", q: "?" }), /T9/);
});

test("パスとして危険な run id・task id は使えない", async () => {
  const { dir } = await approvableProject();
  assert.throws(() => runPaths(dir, "../x"));
  assert.throws(() => taskFile(dir, "r1", "../x", ".state.json"), /task id/);
  const plan = decidedPlan();
  plan.run = "../x";
  assert.throws(() => approvePlan(dir, plan), ContractError);
});

test("承認には基点の記録が要る", async () => {
  const { dir } = await approvableProject();
  rmSync(baselinePath(dir));
  assert.throws(() => approvePlan(dir, decidedPlan()), /baseline/);
});

test("ベースブランチの上や detached HEAD では承認しない", async () => {
  const { dir, git } = await approvableProject();
  git("switch", "-q", "main");
  assert.throws(() => approvePlan(dir, decidedPlan()), /base（main）と同じ/);
  git("switch", "-q", "--detach", "HEAD");
  assert.throws(() => approvePlan(dir, decidedPlan()), /detached/);
});

test("承認記録に基点コミットとテストのハッシュを残し、基点の記録を写す", async () => {
  const { dir, git } = await approvableProject();
  const plan = decidedPlan();
  approvePlan(dir, plan);
  const { approval } = loadApproval(dir, plan.run);
  assert.equal(approval.base_commit, git("rev-parse", "HEAD").trim());
  assert.equal(approval.branch, "work");
  assert.deepEqual(Object.keys(approval.tests), ["test/cli.test.ts", "test/config.test.ts"]);
  assert.equal(approval.tests["test/cli.test.ts"], sha256Of(readFileSync(join(dir, "test/cli.test.ts"))));
  assert.ok(existsSync(runPaths(dir, plan.run).baseline));
});

test("tests のファイルがなければ承認しない", async () => {
  const { dir } = await approvableProject();
  rmSync(join(dir, "test/cli.test.ts"));
  assert.throws(() => approvePlan(dir, decidedPlan()), /test\/cli\.test\.ts がない/);
});

/**
 * 下書きを書き、SubagentStop の検査と Red 確認まで済ませたプロジェクト。
 */
async function checkedProject() {
  const repo = await approvableProject();
  const plan = examplePlan();
  for (const t of plan.tasks) t.acceptance = [{ cmd: 'node -e "process.exit(1)"', why: "実装前は落ちる" }];
  repo.put(".tasque/plan.draft.json", JSON.stringify(plan, null, 2));
  decidePlannerStop({ agent_type: PLANNER, agent_id: "a1" }, { projectDir: repo.dir });
  await verifyRed(repo.dir);
  const decided = structuredClone(plan);
  decided.tasks[0].uncertain[0].decision = "既定値で動く";
  return { ...repo, decided };
}

test("approveChecked: 検査と Red 確認を通った契約は decision を埋めても承認できる", async () => {
  const { dir, decided } = await checkedProject();
  approveChecked(dir, decided);
  assert.deepEqual(loadApproved(dir, decided.run), decided);
});

test("approveChecked: Red 確認の後にテストか契約が変わったら承認しない", async () => {
  const changedTest = await checkedProject();
  changedTest.put("test/cli.test.ts", "// 書き換えた\n");
  assert.throws(() => approveChecked(changedTest.dir, changedTest.decided), /やり直して/);

  const changedPlan = await checkedProject();
  changedPlan.decided.tasks[0].allow.push("src/more/**");
  assert.throws(() => approveChecked(changedPlan.dir, changedPlan.decided), /やり直して/);
});

test("approveChecked: 検査が ok でない・Red 確認がないなら承認しない", async () => {
  const notOk = await checkedProject();
  const { check } = draftPaths(notOk.dir);
  writeFileSync(check, JSON.stringify({ ...JSON.parse(readFileSync(check, "utf8")), ok: false }));
  assert.throws(() => approveChecked(notOk.dir, notOk.decided), /検査が通っていない/);

  const noRed = await checkedProject();
  rmSync(draftPaths(noRed.dir).red);
  assert.throws(() => approveChecked(noRed.dir, noRed.decided), /Red 確認/);
});

test("基点で全体テストが落ちていたら承認しない", async () => {
  const { dir, put } = makeRepo({ files: { "tasque.config.json": JSON.stringify({ test_cmd: 'node -e "process.exit(1)"' }) } });
  await verifyBaseline(dir);
  for (const t of examplePlan().tasks.flatMap((task) => task.tests)) put(t, "");
  assert.throws(() => approvePlan(dir, decidedPlan()), /全体テストが落ちている/);
});
