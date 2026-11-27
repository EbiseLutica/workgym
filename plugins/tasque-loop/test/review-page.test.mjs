import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { draftDigest } from "../scripts/lib/plan-check.mjs";
import {
  collectReviewData,
  DATA_MARKER,
  MAX_TEST_BYTES,
  renderReviewPage,
  writeReviewPage,
} from "../scripts/lib/review-page.mjs";
import { examplePlan } from "./helpers.mjs";

const TEMPLATE = `<html><body><script type="application/json" id="d">${DATA_MARKER}</script></body></html>`;

/**
 * レンダリングした HTML から、埋め込んだデータをブラウザと同じ手順（script 要素の中身を JSON.parse）で取り出す。
 */
const embedded = (html) => JSON.parse(html.match(/<script type="application\/json" id="d">([\s\S]*?)<\/script>/)[1]);

function project({ plan = examplePlan(), tests = {}, check, red } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "tasque-review-"));
  const put = (file, text) => {
    mkdirSync(join(dir, file, ".."), { recursive: true });
    writeFileSync(join(dir, file), text);
  };
  put(".tasque/plan.draft.json", JSON.stringify(plan));
  for (const [file, text] of Object.entries(tests)) put(file, text);
  const digest = draftDigest(dir);
  if (check) put(".tasque/plan.draft.check.json", JSON.stringify({ digest, ...check }));
  if (red) put(".tasque/plan.draft.red.json", JSON.stringify({ digest, ...red }));
  return { dir, put, digest };
}

test("埋め込んだデータは </script> や <!-- を含んでも script 要素から抜けず、元どおりに読める", () => {
  const data = { request: "</script><script>alert(1)</script><!-- x", tasks: [] };
  const html = renderReviewPage(data, TEMPLATE);
  assert.equal(html.match(/<\/script>/g).length, 1);
  assert.deepEqual(embedded(html), data);
});

test("テンプレートに目印がちょうど1つなければ例外", () => {
  assert.throws(() => renderReviewPage({}, "<html></html>"), /ちょうど1つ/);
  assert.throws(() => renderReviewPage({}, `${DATA_MARKER}${DATA_MARKER}`), /ちょうど1つ/);
});

test("契約・テストの中身・Red 確認の結果を、受け入れコマンドごとにまとめる", () => {
  const { dir, digest } = project({
    tests: { "test/config.test.ts": "test('x', () => {});\n", "test/cli.test.ts": "" },
    check: { ok: true, errors: [] },
    red: {
      warnings: ["T2: 通った"],
      results: [
        { task: "T1", cmd: "npm test -- config", status: "fail", exit: 1, stdout: "not ok", stderr: "", cwd: "." },
        { task: "T2", cmd: "npm test -- cli", status: "pass", exit: 0, stdout: "ok", stderr: "", cwd: "." },
      ],
    },
  });
  const data = collectReviewData(dir, { now: new Date("2026-11-27T00:00:00Z") });

  assert.equal(data.run, examplePlan().run);
  assert.deepEqual(data.integrity, { draft: digest, check: digest, red: digest });
  assert.deepEqual(data.check, { ok: true, errors: [] });
  assert.deepEqual(data.red.warnings, ["T2: 通った"]);
  const [t1, t2] = data.tasks;
  assert.deepEqual(t1.tests, [
    { path: "test/config.test.ts", language: "typescript", content: "test('x', () => {});\n", truncated: false },
  ]);
  assert.equal(t1.acceptance[0].result.status, "fail");
  assert.match(t1.acceptance[0].result.mark, /Red/);
  assert.equal(t1.acceptance[0].result.stdout, "not ok");
  assert.equal(t2.acceptance[0].result.status, "pass");
});

test("Red 確認の後に受け入れコマンドが変わっていれば、古い結果を結び付けない", () => {
  const plan = examplePlan();
  const { dir } = project({
    plan,
    red: { warnings: [], results: [{ task: "T1", cmd: "npm test -- old", status: "fail", stdout: "", stderr: "", cwd: "." }] },
  });
  assert.equal(collectReviewData(dir).tasks[0].acceptance[0].result, null);
});

test("検査結果や Red 確認がなければ null、下書きを読めなければ error を返す", () => {
  const { dir, put } = project();
  const data = collectReviewData(dir);
  assert.equal(data.check, null);
  assert.equal(data.red, null);
  assert.equal(data.integrity.check, null);

  put(".tasque/plan.draft.json", "{");
  const broken = collectReviewData(dir);
  assert.match(broken.error, /plan\.draft\.json/);
  assert.deepEqual(broken.tasks, []);
});

test("テストは正規形のプロジェクト内のパスだけを読み、ないものと長すぎるものはそうと分かるようにする", () => {
  const plan = examplePlan();
  plan.tasks[0].tests = ["test/big.py", "test/none.ts", "../outside.txt"];
  plan.tasks[1].tests = [];
  const { dir } = project({ plan, tests: { "test/big.py": "x".repeat(MAX_TEST_BYTES + 10) } });
  writeFileSync(join(dir, "..", "outside.txt"), "secret");

  const [big, none, outside] = collectReviewData(dir).tasks[0].tests;
  assert.equal(big.language, "python");
  assert.equal(big.truncated, true);
  assert.equal(big.content.length, MAX_TEST_BYTES);
  assert.equal(none.missing, true);
  assert.equal(outside.missing, true);
  assert.equal(outside.content, undefined);
});

test("writeReviewPage は同梱のビューアにデータを埋め込み、.tasque/tmp/review.html に書く", () => {
  const { dir } = project({ tests: { "test/config.test.ts": "", "test/cli.test.ts": "" } });
  const file = writeReviewPage(dir);
  assert.equal(file, join(dir, ".tasque", "tmp", "review.html"));
  const html = readFileSync(file, "utf8");
  assert.ok(!html.includes(DATA_MARKER));
  const json = html.match(/<script type="application\/json" id="tasque-review-data">([\s\S]*?)<\/script>/)[1];
  assert.equal(JSON.parse(json).run, examplePlan().run);
});
