import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { appendEscalation, approvePlan, recordAnswer, runPaths } from "../scripts/lib/run.mjs";
import { approvableProject, decidedPlan } from "./helpers.mjs";

const CLI = fileURLToPath(new URL("../scripts/ledger.mjs", import.meta.url));
const RECORD_REVIEW = fileURLToPath(new URL("../scripts/record-review.mjs", import.meta.url));

/**
 * 承認済みのランと、一時ディレクトリの台帳。
 * git のグローバル・システム設定は空にして、台帳のリポジトリに名前とメールの設定がない状態にする。
 * ledgerDir は存在しないパス（CLI が作る）。
 */
async function setup() {
  const repo = await approvableProject();
  const plan = decidedPlan();
  approvePlan(repo.dir, plan);
  const tmp = mkdtempSync(join(tmpdir(), "tasque-ledger-test-"));
  const gitGlobal = join(tmp, "gitconfig");
  writeFileSync(gitGlobal, "");
  const ledgerDir = join(tmp, "ledger");
  const { CLAUDE_PROJECT_DIR, TASQUE_LEDGER_DIR, ...rest } = process.env;
  const env = { ...rest, TASQUE_LEDGER_DIR: ledgerDir, GIT_CONFIG_GLOBAL: gitGlobal, GIT_CONFIG_NOSYSTEM: "1" };
  const spawn = (script, args, e = env) =>
    spawnSync(process.execPath, [script, ...args], { cwd: repo.dir, env: e, encoding: "utf8" });
  const ledger = (args = ["--run", plan.run], e = env) => spawn(CLI, args, e);
  const lgit = (...args) => execFileSync("git", args, { cwd: ledgerDir, env, encoding: "utf8" });
  const project = basename(repo.root);
  const recordPath = (dir = ledgerDir) => join(dir, project, `${plan.run}.json`);
  return { ...repo, plan, tmp, env, spawn, ledger, lgit, ledgerDir, project, recordPath, paths: runPaths(repo.dir, plan.run) };
}

/**
 * 指摘を1件作る。rejected なら reject_reason も付ける。
 */
const f = (severity, disposition, found_by, extra = {}) => ({
  perspective: "正確性",
  severity,
  location: "src/config/index.ts:1",
  problem: "p",
  fix: "f",
  disposition,
  found_by,
  ...(disposition === "rejected" ? { reject_reason: "r" } : {}),
  ...extra,
});

/**
 * record-review CLI でレビュー結果を記録する。記録できなければテストを落とす。
 */
function review(s, task, round, findings) {
  writeFileSync(join(s.dir, "findings.json"), JSON.stringify(findings));
  const r = s.spawn(RECORD_REVIEW, ["--run", s.plan.run, "--task", task, "--round", String(round), "--findings-file", "findings.json"]);
  assert.equal(r.status, 0, r.stderr);
}

/**
 * ランの記録をひととおり用意する（post の履歴、レビュー、pr.json、人間のレビュー、エスカレーション）。
 */
function populate(s) {
  const { dir, plan, paths } = s;
  const tasks = join(paths.dir, "tasks");
  mkdirSync(tasks, { recursive: true });

  writeFileSync(
    join(tasks, "T1.post-history.json"),
    JSON.stringify([
      { at: "2026-11-26T01:00:00.000Z", ok: false, failed: ["scope", "acceptance: npm test -- config"], scope_outside: ["README.md", "src/x.ts"] },
      { at: "2026-11-26T01:10:00.000Z", ok: false, failed: ["scope"], scope_outside: ["README.md"] },
      { at: "2026-11-26T01:20:00.000Z", ok: true, failed: [], scope_outside: [] },
    ]),
  );

  review(s, "T1", 1, [
    f("blocker", "fix", ["並列:正確性", "1体"]), // 両方
    f("major", "rejected", ["1体", "並列:要件", "並列:整合"]), // 両方・却下
    f("major", "fix", ["並列:要件"]), // 並列だけ
    f("minor", "carryover", ["並列:整合", "並列:正確性"]), // 並列だけ
    f("minor", "rejected", ["並列:整合"]), // 並列だけ・却下
    f("nit", "rejected", ["1体"], { perspective: "整合" }), // 1体だけ・却下
    f("major", "fix", ["1体"]), // 1体だけ
  ]);
  // 2ラウンド目は出どころ別の集計に数えない
  review(s, "T1", 2, [f("major", "fix", ["並列:正確性"]), f("minor", "rejected", ["並列:要件"])]);

  writeFileSync(
    join(tasks, "pr.json"),
    JSON.stringify({ run: plan.run, phase: "pr", ok: true, checks: [], diff: { base: "abc", changed: [], lines: 42, files: 3 } }),
  );

  writeFileSync(
    paths.reviews,
    JSON.stringify([
      { at: "2026-11-26T00:00:00.000Z", verdict: "changes_requested", text: "T2 の範囲が広すぎる\n2行目", draft_digest: "d1" },
      { at: "2026-11-26T00:30:00.000Z", verdict: "approved", text: "OK", draft_digest: "d2" },
    ]),
  );

  appendEscalation(dir, plan.run, { task: "T1", q: "q1", context: "c1" });
  recordAnswer(dir, plan.run, { task: "T1", answer: "a1" });
  appendEscalation(dir, plan.run, { task: "T2", q: "q2" });
}

const isIso = (s) => typeof s === "string" && new Date(s).toISOString() === s;
const emptyReview = {
  rounds: 0,
  by_severity: { blocker: 0, major: 0, minor: 0, nit: 0 },
  by_disposition: { fix: 0, rejected: 0, carryover: 0 },
  late: 0,
  found_by: {
    both: { count: 0, rejected: 0 },
    parallel_only: { count: 0, rejected: 0 },
    single_only: { count: 0, rejected: 0 },
  },
};

/**
 * 台帳 CLI を実行し、書かれた記録からタスクごとの review の found_by を取り出す。
 */
function foundByOf(s) {
  const r = s.ledger();
  assert.equal(r.status, 0, r.stderr);
  const record = JSON.parse(readFileSync(s.recordPath(), "utf8"));
  return Object.fromEntries(record.tasks.map((t) => [t.id, t.review.found_by]));
}

// ---- 正常系: 台帳に記録される ----

test("正常系: ランの記録を1件の JSON にまとめて台帳に書き、台帳のリポジトリにコミットする", async () => {
  const s = await setup();
  populate(s);
  const projectStatus = s.git("status", "--porcelain");

  const r = s.ledger();
  assert.equal(r.status, 0, r.stderr);

  const record = JSON.parse(readFileSync(s.recordPath(), "utf8"));
  assert.ok(isIso(record.recorded_at), record.recorded_at);
  const { recorded_at, ...rest } = record;
  assert.deepEqual(rest, {
    project: s.project,
    run: s.plan.run,
    tasks: [
      {
        id: "T1",
        title: s.plan.tasks[0].title,
        post: { attempts: 3, failed: [["scope", "acceptance: npm test -- config"], ["scope"], []] },
        scope_violations: ["README.md", "src/x.ts"],
        review: {
          rounds: 2,
          by_severity: { blocker: 1, major: 4, minor: 3, nit: 1 },
          by_disposition: { fix: 4, rejected: 4, carryover: 1 },
          late: 2,
          found_by: {
            both: { count: 2, rejected: 1 },
            parallel_only: { count: 3, rejected: 1 },
            single_only: { count: 2, rejected: 1 },
          },
        },
      },
      {
        id: "T2",
        title: s.plan.tasks[1].title,
        post: { attempts: 0, failed: [] },
        scope_violations: [],
        review: emptyReview,
      },
    ],
    pr: { lines: 42, files: 3 },
    human: {
      reviews: [
        { at: "2026-11-26T00:00:00.000Z", verdict: "changes_requested", text: "T2 の範囲が広すぎる\n2行目" },
        { at: "2026-11-26T00:30:00.000Z", verdict: "approved", text: "OK" },
      ],
      decisions: [{ task: "T1", q: s.plan.tasks[0].uncertain[0].q, decision: "既定値で動く" }],
      escalations: [
        { task: "T1", q: "q1", answer: "a1" },
        { task: "T2", q: "q2", answer: null },
      ],
    },
  });

  assert.equal(s.lgit("rev-list", "--count", "HEAD").trim(), "1");
  assert.equal(s.lgit("log", "-1", "--format=%an <%ae>").trim(), "tasque-loop <tasque-loop@localhost>");
  assert.deepEqual(s.lgit("show", "--name-only", "--format=", "HEAD").trim().split("\n"), [`${s.project}/${s.plan.run}.json`]);
  assert.equal(s.lgit("status", "--porcelain").trim(), "");
  assert.equal(s.lgit("remote").trim(), "");

  assert.equal(s.git("status", "--porcelain"), projectStatus);
});

test("正常系: 出どころ別の集計は1ラウンド目の指摘だけを、両方・並列だけ・1体だけに分けて数え、それぞれの却下を数える", async () => {
  const s = await setup();
  const round1 = {
    "両方: 並列1体と1体": f("major", "fix", ["並列:要件", "1体"]),
    "両方: 並列3体と1体・却下": f("minor", "rejected", ["並列:要件", "並列:正確性", "並列:整合", "1体"]),
    "両方: 1体を先に書いても同じ": f("nit", "carryover", ["1体", "並列:整合"]),
    "並列だけ: 1体": f("major", "fix", ["並列:正確性"]),
    "並列だけ: 2体・却下": f("major", "rejected", ["並列:正確性", "並列:整合"]),
    "1体だけ・却下": f("nit", "rejected", ["1体"]),
    "1体だけ・もう1件の却下": f("minor", "rejected", ["1体"]),
    "1体だけ": f("blocker", "fix", ["1体"]),
  };
  review(s, "T1", 1, Object.values(round1));
  const round2NotCounted = [f("major", "fix", ["並列:要件"]), f("minor", "rejected", ["並列:整合", "並列:正確性"])];
  review(s, "T1", 2, round2NotCounted);

  const byTask = foundByOf(s);
  assert.deepEqual(byTask.T1, {
    both: { count: 3, rejected: 1 },
    parallel_only: { count: 2, rejected: 1 },
    single_only: { count: 3, rejected: 2 },
  });
  assert.deepEqual(byTask.T2, emptyReview.found_by);
});

test("正常系: found_by のない古い指摘（変更前の review-1.json）は、出どころ別のどの分類にも数えない", async () => {
  const s = await setup();
  const tasks = join(s.paths.dir, "tasks");
  mkdirSync(tasks, { recursive: true });
  const { found_by: _a, ...legacyFix } = f("major", "fix", []);
  const { found_by: _b, ...legacyRejected } = f("minor", "rejected", []);
  const writeRound1 = (task, findings) =>
    writeFileSync(
      join(tasks, `${task}.review-1.json`),
      JSON.stringify({ run: s.plan.run, task, round: 1, recorded_at: "2026-11-25T00:00:00.000Z", findings }),
    );
  // T1 は古い指摘だけ、T2 は古い指摘と found_by のある指摘が混ざっている
  writeRound1("T1", [legacyFix, legacyRejected]);
  writeRound1("T2", [legacyFix, legacyRejected, f("major", "rejected", ["並列:要件", "1体"]), f("major", "fix", ["1体"])]);

  const byTask = foundByOf(s);
  assert.deepEqual(byTask.T1, emptyReview.found_by);
  assert.deepEqual(byTask.T2, {
    both: { count: 1, rejected: 1 },
    parallel_only: { count: 0, rejected: 0 },
    single_only: { count: 1, rejected: 0 },
  });
});

test("正常系: 台帳のリポジトリに名前とメールの設定があればそれを使い、記録のファイルだけをコミットする", async () => {
  const s = await setup();
  mkdirSync(s.ledgerDir, { recursive: true });
  s.lgit("init", "-q");
  s.lgit("config", "user.name", "ledger-owner");
  s.lgit("config", "user.email", "owner@example.invalid");
  writeFileSync(join(s.ledgerDir, "memo.txt"), "手元のメモ\n");

  const r = s.ledger();
  assert.equal(r.status, 0, r.stderr);

  assert.equal(s.lgit("log", "-1", "--format=%an <%ae>").trim(), "ledger-owner <owner@example.invalid>");
  assert.deepEqual(s.lgit("show", "--name-only", "--format=", "HEAD").trim().split("\n"), [`${s.project}/${s.plan.run}.json`]);
  assert.equal(s.lgit("status", "--porcelain").trim(), "?? memo.txt");
});

test("正常系: TASQUE_LEDGER_DIR がなければ ~/.tasque/ledger に書く。記録がないランは空の値で書く", async () => {
  const s = await setup();
  const home = join(s.tmp, "home");
  mkdirSync(home);
  const { TASQUE_LEDGER_DIR, ...rest } = s.env;
  const r = s.ledger(["--run", s.plan.run], { ...rest, HOME: home, USERPROFILE: home });
  assert.equal(r.status, 0, r.stderr);

  const ledgerDir = join(home, ".tasque", "ledger");
  assert.equal(existsSync(s.ledgerDir), false);
  const record = JSON.parse(readFileSync(s.recordPath(ledgerDir), "utf8"));
  assert.equal(record.pr, null);
  assert.deepEqual(record.human, {
    reviews: [],
    decisions: [{ task: "T1", q: s.plan.tasks[0].uncertain[0].q, decision: "既定値で動く" }],
    escalations: [],
  });
  for (const t of record.tasks) {
    assert.deepEqual(t.post, { attempts: 0, failed: [] });
    assert.deepEqual(t.scope_violations, []);
    assert.deepEqual(t.review, emptyReview);
  }
  const log = execFileSync("git", ["log", "--format=%H"], { cwd: ledgerDir, env: s.env, encoding: "utf8" });
  assert.equal(log.trim().split("\n").length, 1);
});

test("正常系: 台帳の場所が空のディレクトリなら git init して使う", async () => {
  const s = await setup();
  mkdirSync(s.ledgerDir, { recursive: true });
  const ok = s.ledger();
  assert.equal(ok.status, 0, ok.stderr);
  assert.equal(s.lgit("rev-list", "--count", "HEAD").trim(), "1");
});

// ---- 異常系: 台帳に何も書かない ----

test("異常系: 同じランがすでに台帳にあればエラーにし、記録もコミットも変えない", async () => {
  const s = await setup();
  populate(s);
  assert.equal(s.ledger().status, 0);
  const before = readFileSync(s.recordPath(), "utf8");

  const r = s.ledger();
  assert.equal(r.status, 1);
  assert.equal(readFileSync(s.recordPath(), "utf8"), before);
  assert.equal(s.lgit("rev-list", "--count", "HEAD").trim(), "1");
});

test("異常系: --run がなければ使い方を出して exit 2 で止まり、承認されていないランはエラーにして台帳に何も書かない", async () => {
  const s = await setup();
  const usage = s.ledger([]);
  assert.equal(usage.status, 2);
  assert.match(usage.stderr, /usage/);

  const r = s.ledger(["--run", "2026-01-01-none"]);
  assert.equal(r.status, 1);
  assert.equal(existsSync(join(s.ledgerDir, s.project, "2026-01-01-none.json")), false);
});

test("異常系: 台帳の場所が中身のある git 管理外のディレクトリなら、何も書かずにエラーにする", async () => {
  const s = await setup();
  const other = join(s.tmp, "notes");
  mkdirSync(other);
  writeFileSync(join(other, "memo.txt"), "手元のメモ\n");
  const r = s.ledger(["--run", s.plan.run], { ...s.env, TASQUE_LEDGER_DIR: other });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /git リポジトリのルートでない/);
  assert.equal(existsSync(join(other, ".git")), false);
  assert.equal(existsSync(join(other, s.project)), false);
});
