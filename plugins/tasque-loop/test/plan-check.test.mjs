import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decidePlannerStop, draftDigest, draftPaths, PLANNER } from "../scripts/lib/plan-check.mjs";

const example = () => readFileSync(new URL("../examples/plan.example.json", import.meta.url), "utf8");

const TESTS = ["test/config.test.ts", "test/cli.test.ts"];

function setup(draft, { tests = TESTS } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "tasque-plan-"));
  const paths = draftPaths(dir);
  mkdirSync(join(dir, "test"));
  for (const t of tests) writeFileSync(join(dir, t), "");
  if (draft !== undefined) {
    mkdirSync(paths.dir, { recursive: true });
    writeFileSync(paths.draft, draft);
  }
  const stop = (agent_id = "a1") => decidePlannerStop({ agent_type: PLANNER, agent_id }, { projectDir: dir });
  const status = () => JSON.parse(readFileSync(paths.check, "utf8"));
  const rewrite = (text) => writeFileSync(paths.draft, text);
  return { dir, stop, status, rewrite };
}

const invalid = () => {
  const plan = JSON.parse(example());
  plan.tasks[0].allow.push("test/**");
  return JSON.stringify(plan);
};

test("planner 以外は判定しない", () => {
  const { dir } = setup();
  assert.equal(decidePlannerStop({ agent_type: "tasque-loop:implementer", agent_id: "x" }, { projectDir: dir }), null);
});

test("妥当な下書きなら止めるのを許し、ok を記録する", () => {
  const { stop, status } = setup(example());
  assert.equal(stop(), null);
  assert.equal(status().ok, true);
});

test("下書きがない・JSON が壊れている・契約が不正なら差し戻す", () => {
  for (const draft of [undefined, "{ broken", invalid()]) {
    const { stop, status } = setup(draft);
    const r = stop();
    assert.equal(r?.decision, "block");
    assert.match(r.reason, /plan\.draft\.json/);
    assert.equal(status().ok, false);
  }
});

test("tests に挙げたテストファイルがなければ差し戻す", () => {
  const { stop, status } = setup(example(), { tests: ["test/config.test.ts"] });
  const r = stop();
  assert.equal(r?.decision, "block");
  assert.match(r.reason, /T2: テスト test\/cli\.test\.ts がない/);
  assert.equal(status().errors.length, 1);
});

test("差し戻し後に直せば止めるのを許す", () => {
  const { stop, status, rewrite } = setup(invalid());
  assert.equal(stop()?.decision, "block");
  rewrite(example());
  assert.equal(stop(), null);
  assert.deepEqual([status().ok, status().attempts], [true, 2]);
});

test("差し戻しは上限までで、超えたら gave_up を残して止めるのを許す", () => {
  const { stop, status } = setup(invalid());
  assert.equal(stop()?.decision, "block");
  assert.equal(stop()?.decision, "block");
  assert.equal(stop(), null);
  assert.deepEqual([status().ok, status().gave_up, status().attempts], [false, true, 3]);
});

test("agent_id がなくても例外にならず、回数は毎回数え直す", () => {
  const { dir, status } = setup(invalid());
  const stop = () => decidePlannerStop({ agent_type: PLANNER }, { projectDir: dir });
  assert.equal(stop()?.decision, "block");
  assert.equal(stop()?.decision, "block");
  assert.deepEqual([status().attempts, status().agent_id], [1, null]);
});

test("検査結果に下書きとテストのハッシュを残す。decision を埋めても変わらず、テストを書き換えると変わる", () => {
  const { dir, stop, status, rewrite } = setup(example());
  stop();
  const digest = status().digest;
  assert.match(digest, /^[0-9a-f]{64}$/);
  assert.equal(draftDigest(dir), digest);

  const plan = JSON.parse(example());
  plan.tasks[0].uncertain[0].decision = "既定値で動く";
  rewrite(JSON.stringify(plan));
  assert.equal(draftDigest(dir), digest);

  writeFileSync(join(dir, "test/cli.test.ts"), "changed");
  assert.notEqual(draftDigest(dir), digest);
});

test("別の planner 呼び出しでは回数を数え直す", () => {
  const { stop, status } = setup(invalid());
  stop("a1");
  stop("a1");
  assert.equal(stop("a2")?.decision, "block");
  assert.equal(status().attempts, 1);
});

test("delete に git の管理下にないファイルがあれば差し戻す", () => {
  const plan = JSON.parse(example());
  plan.tasks[0].delete = ["src/old.ts"];
  const { dir, stop } = setup(JSON.stringify(plan));
  mkdirSync(join(dir, "src"));
  writeFileSync(join(dir, "src", "old.ts"), "");
  const r = stop();
  assert.equal(r?.decision, "block");
  assert.match(r.reason, /delete の src\/old\.ts が git の管理下にない/);
});
