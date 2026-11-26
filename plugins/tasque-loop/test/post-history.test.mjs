import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { approvePlan } from "../scripts/lib/run.mjs";
import { verifyBaseline, verifyPost, verifyPre } from "../scripts/lib/verify.mjs";
import { makeRepo } from "./helpers.mjs";

const RUN = "r1";

const CHECK =
  'import { readFileSync } from "node:fs";\n' +
  'let ok = false;\ntry { ok = readFileSync("src/impl.txt", "utf8").trim() === "ok"; } catch {}\n' +
  "process.exit(ok ? 0 : 1);\n";

const T1 = {
  id: "T1",
  title: "T1 を作る",
  goal: "src/impl.txt に ok と書く",
  depends_on: [],
  allow: ["src/**"],
  out_of_scope: [],
  tests: ["test/check.mjs"],
  acceptance: [{ cmd: "node test/check.mjs", why: "impl.txt の中身" }],
  max_diff: { lines: 10, files: 5 },
  uncertain: [],
};

/**
 * 基点の記録 → テスト → 承認 → テストのコミット → pre まで進めた練習用リポジトリ。
 */
async function setup() {
  const repo = makeRepo();
  await verifyBaseline(repo.dir);
  repo.put("test/check.mjs", CHECK);
  approvePlan(repo.dir, { version: 1, run: RUN, request: "impl.txt に ok と書く", base: "main", tasks: [T1] });
  repo.git("add", "--", "test/check.mjs");
  repo.git("commit", "-q", "-m", "test: acceptance");
  await verifyPre(repo.dir, RUN, "T1");
  const tasks = join(repo.dir, ".tasque", "runs", RUN, "tasks");
  return {
    ...repo,
    history: () => JSON.parse(readFileSync(join(tasks, "T1.post-history.json"), "utf8")),
    historyExists: () => existsSync(join(tasks, "T1.post-history.json")),
    postJson: () => JSON.parse(readFileSync(join(tasks, "T1.post.json"), "utf8")),
  };
}

const failed = (result) => result.checks.filter((c) => !c.ok).map((c) => c.name);
const isIso = (s) => typeof s === "string" && new Date(s).toISOString() === s;

test("post を実行するたびに、日時・合否・落ちた check・許可外のパスを post-history.json に追記する", async () => {
  const { dir, put, git, history } = await setup();

  put("README.md", "practice\nedited\n");
  const first = await verifyPost(dir, RUN, "T1");
  assert.equal(first.ok, false);

  git("checkout", "--", "README.md");
  put("src/impl.txt", "ok\n");
  const second = await verifyPost(dir, RUN, "T1");
  assert.equal(second.ok, true);

  const h = history();
  assert.equal(h.length, 2);
  for (const e of h) {
    assert.deepEqual(Object.keys(e).sort(), ["at", "failed", "ok", "scope_outside"]);
    assert.ok(isIso(e.at), e.at);
  }
  assert.ok(h[0].at <= h[1].at);

  assert.equal(h[0].ok, false);
  assert.deepEqual(h[0].failed, failed(first));
  assert.ok(h[0].failed.includes("scope"));
  assert.ok(h[0].failed.includes("acceptance: node test/check.mjs"));
  assert.deepEqual(h[0].scope_outside, ["README.md"]);

  assert.equal(h[1].ok, true);
  assert.deepEqual(h[1].failed, []);
  assert.deepEqual(h[1].scope_outside, []);
});

test("許可外のパスが複数あればすべて残し、スコープ以外の失敗だけなら scope_outside は空", async () => {
  const { dir, put, git, history } = await setup();

  put("README.md", "practice\nedited\n");
  put("other/x.txt", "x\n");
  put("src/impl.txt", "ok\n");
  await verifyPost(dir, RUN, "T1");

  git("checkout", "--", "README.md");
  git("clean", "-q", "-f", "--", "other");
  put("src/impl.txt", "ng\n");
  await verifyPost(dir, RUN, "T1");

  const [a, b] = history();
  assert.deepEqual([...a.scope_outside].sort(), ["README.md", "other/x.txt"]);
  assert.deepEqual(a.failed, ["scope"]);
  assert.deepEqual(b.scope_outside, []);
  assert.deepEqual(b.failed, ["acceptance: node test/check.mjs"]);
});

test("post.json の中身と戻り値は今までどおりで、毎回最新の結果で上書きされる", async () => {
  const { dir, put, postJson } = await setup();

  const first = await verifyPost(dir, RUN, "T1");
  assert.deepEqual(Object.keys(first), ["run", "task", "phase", "ok", "checks", "diff"]);
  assert.deepEqual(postJson(), JSON.parse(JSON.stringify(first)));

  put("src/impl.txt", "ok\n");
  const second = await verifyPost(dir, RUN, "T1");
  assert.deepEqual(Object.keys(second), ["run", "task", "phase", "ok", "checks", "diff"]);
  assert.deepEqual(postJson(), JSON.parse(JSON.stringify(second)));
  assert.equal(postJson().ok, true);
});

test("pre だけでは post-history.json を作らない", async () => {
  const { historyExists } = await setup();
  assert.equal(historyExists(), false);
});
