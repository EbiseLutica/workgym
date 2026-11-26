import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { isAllowed, isTestPath, samePath, validatePlan } from "../scripts/lib/contract.mjs";

const example = () =>
  JSON.parse(readFileSync(new URL("../examples/plan.example.json", import.meta.url), "utf8"));

const hasError = (errors, fragment) => errors.some((e) => e.includes(fragment));

test("例の契約は draft として妥当", () => {
  assert.deepEqual(validatePlan(example()), []);
});

test("未決定の uncertain があると ready では弾く", () => {
  const errors = validatePlan(example(), { stage: "ready" });
  assert.ok(hasError(errors, "未決定"));
});

test("uncertain をすべて決定すれば ready として妥当", () => {
  const plan = example();
  plan.tasks[0].uncertain[0].decision = "既定値で動く";
  assert.deepEqual(validatePlan(plan, { stage: "ready" }), []);
});

test("tests が allow に含まれていると弾く", () => {
  const plan = example();
  plan.tasks[0].allow.push("test/**");
  assert.ok(hasError(validatePlan(plan), "allow に含まれている"));
});

test("deny で除外されたテストは allow 扱いにならない", () => {
  const plan = example();
  plan.tasks[0].allow.push("test/**");
  plan.tasks[0].deny.push("test/config.test.ts", "test/cli.test.ts");
  assert.deepEqual(validatePlan(plan), []);
});

test("後ろのタスクや存在しないタスクへの depends_on を弾く", () => {
  const plan = example();
  plan.tasks[0].depends_on = ["T2"];
  assert.ok(hasError(validatePlan(plan), "T2 はこのタスクより前に定義されていない"));
});

test("id の重複を弾く", () => {
  const plan = example();
  plan.tasks[1].id = "T1";
  plan.tasks[1].depends_on = [];
  assert.ok(hasError(validatePlan(plan), "重複"));
});

test("絶対パス・バックスラッシュ・.. を含むパスを弾く", () => {
  for (const bad of ["/etc/passwd", "C:/x", "src\\a.ts", "../outside/**"]) {
    const plan = example();
    plan.tasks[0].allow = [bad];
    assert.ok(validatePlan(plan).length > 0, bad);
  }
});

test("raised_by と max_diff の値を検査する", () => {
  const plan = example();
  plan.tasks[0].uncertain[0].raised_by = "human";
  plan.tasks[0].max_diff.lines = 0;
  const errors = validatePlan(plan);
  assert.ok(hasError(errors, "raised_by"));
  assert.ok(hasError(errors, "max_diff.lines"));
});

test("isAllowed は allow に一致し deny に一致しないパスだけを許す", () => {
  const task = example().tasks[0];
  assert.equal(isAllowed("src/config/load.ts", task), true);
  assert.equal(isAllowed("src/index.ts", task), true);
  assert.equal(isAllowed("src/config/generated/x.ts", task), false);
  assert.equal(isAllowed("src/cli.ts", task), false);
});

test("isAllowed は deny を大文字小文字を区別せずに、allow を区別して照合する", () => {
  const task = example().tasks[0];
  assert.equal(isAllowed("src/config/Generated/x.ts", task), false);
  assert.equal(isAllowed("src/config/GENERATED/x.ts", { ...task, deny: ["SRC/config/generated/**"] }), false);
  assert.equal(isAllowed("SRC/config/load.ts", task), false);
});

test("正規形でないパスは allow・deny・tests のどれでも弾く（黙って直さない）", () => {
  const bad = ["./src/**", "src//a.ts", "src/", "src/./a.ts", "a/../b", "/abs", "src\\a.ts", "C:/x"];
  for (const key of ["allow", "deny", "tests"]) {
    for (const p of bad) {
      const plan = example();
      plan.tasks[0][key] = [p];
      assert.ok(validatePlan(plan).some((e) => e.includes(`.${key}`) && e.includes(p)), `${key}: ${p}`);
    }
  }
});

test("tests には glob の特殊文字を書けない", () => {
  for (const p of ["test/*.ts", "test/a?.ts", "test/[ab].ts", "test/{a,b}.ts"]) {
    const plan = example();
    plan.tasks[0].tests = [p];
    assert.ok(hasError(validatePlan(plan), "glob の特殊文字"), p);
  }
});

test("他のタスクの allow に一致するテストを弾く", () => {
  const plan = example();
  plan.tasks[1].allow.push("test/config.test.ts");
  assert.ok(hasError(validatePlan(plan), "T2.allow: test/config.test.ts（T1 のテスト） が allow に含まれている"));
});

test("同じテストファイルを2つのタスクに挙げられない（大文字小文字違いも）", () => {
  const plan = example();
  plan.tasks[1].tests.push("Test/Config.test.ts");
  assert.ok(hasError(validatePlan(plan), "T1 の tests と重複"));
});

test("task id はファイル名に使える形式に限る", () => {
  for (const id of ["../x", "a/b", ".T1", "T 1"]) {
    const plan = example();
    plan.tasks[0].id = id;
    plan.tasks[1].depends_on = [];
    assert.ok(hasError(validatePlan(plan), "id は英数字"), id);
  }
});

test("acceptance の cwd は任意で、正規形のプロジェクト相対パスに限る", () => {
  const plan = example();
  plan.tasks[0].acceptance[0].cwd = "packages/app";
  assert.deepEqual(validatePlan(plan), []);
  for (const cwd of ["./packages", "../x", "packages/", "", "p/*"]) {
    plan.tasks[0].acceptance[0].cwd = cwd;
    assert.ok(validatePlan(plan).length > 0, cwd);
  }
});

test("samePath・isTestPath は大文字小文字と Unicode 正規化の違いを同一視する", () => {
  assert.equal(samePath("Test/A.ts", "test/a.ts"), true);
  assert.equal(samePath("test/が.ts", "test/か\u3099.ts"), true);
  assert.equal(samePath("test/a.ts", "test/b.ts"), false);
  const plan = example();
  assert.equal(isTestPath("TEST/CLI.test.ts", plan), true);
  assert.equal(isTestPath("test/cli.test.ts", plan.tasks.slice(0, 1)), false);
});
