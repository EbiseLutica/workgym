import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
 * 台帳の中のランの置き場所は <台帳>/<プロジェクト>/<run>/ で、集計は record.json、生の記録の写しは raw/。
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
  const snapshot = (e = env) => spawn(CLI, ["--run", plan.run, "--snapshot"], e);
  const lgit = (...args) => execFileSync("git", args, { cwd: ledgerDir, env, encoding: "utf8" });
  const project = basename(repo.root);
  const runRel = `${project}/${plan.run}`;
  const runDir = (dir = ledgerDir) => join(dir, project, plan.run);
  const recordPath = (dir = ledgerDir) => join(runDir(dir), "record.json");
  const rawDir = (dir = ledgerDir) => join(runDir(dir), "raw");
  return {
    ...repo,
    plan,
    tmp,
    env,
    spawn,
    ledger,
    snapshot,
    lgit,
    ledgerDir,
    project,
    runRel,
    runDir,
    recordPath,
    rawDir,
    paths: runPaths(repo.dir, plan.run),
  };
}

/**
 * ディレクトリの中のファイルを、/ 区切りの相対パスから中身への対応にする（空のディレクトリは数えない）。
 */
function tree(root) {
  const out = {};
  const walk = (dir, prefix) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const rel = prefix ? `${prefix}/${e.name}` : e.name;
      if (e.isDirectory()) walk(join(dir, e.name), rel);
      else out[rel] = readFileSync(join(dir, e.name), "utf8");
    }
  };
  walk(root, "");
  return out;
}

/**
 * 台帳のリポジトリで、そのランの置き場所の下に追跡されているファイル（/ 区切り、ソート済み）。
 */
function tracked(s) {
  return s.lgit("ls-files", "--", s.runRel).split("\n").filter(Boolean).sort();
}

/**
 * raw/ の写しが追跡されているときの、追跡されるべきファイルの一覧。withRecord なら record.json も含める。
 */
function expectedTracked(s, { withRecord }) {
  const raw = Object.keys(tree(s.paths.dir)).map((rel) => `${s.runRel}/raw/${rel}`);
  return [...raw, ...(withRecord ? [`${s.runRel}/record.json`] : [])].sort();
}

/**
 * 台帳のリポジトリのすべてのコミットで変わったパス。
 */
function committedPaths(s) {
  return s.lgit("log", "--format=", "--name-only").split("\n").filter(Boolean);
}

const commitCount = (s) => Number(s.lgit("rev-list", "--count", "HEAD").trim());

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

/**
 * ランの記録を書き換える（1件を変え、1件を足し、1件を消す）。消したファイルは raw/ からも消えるべきもの。
 */
function mutate(s) {
  const tasks = join(s.paths.dir, "tasks");
  writeFileSync(s.paths.reviews, JSON.stringify([{ at: "2026-11-26T02:00:00.000Z", verdict: "approved", text: "変えた", draft_digest: "d3" }]));
  writeFileSync(join(tasks, "T2.post-history.json"), JSON.stringify([{ at: "2026-11-26T02:10:00.000Z", ok: true, failed: [], scope_outside: [] }]));
  rmSync(join(tasks, "T1.post-history.json"));
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

// ---- 正常系: --run で台帳に記録される ----

test("正常系: --run はランの集計を <プロジェクト>/<run>/record.json に、.tasque/runs/<run>/ の写しを raw/ に書き、両方を台帳のリポジトリにコミットする", async () => {
  const s = await setup();
  populate(s);
  const projectStatus = s.git("status", "--porcelain");
  const source = tree(s.paths.dir);

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

  assert.deepEqual(tree(s.rawDir()), source);
  assert.equal(existsSync(join(s.ledgerDir, s.project, `${s.plan.run}.json`)), false);

  assert.deepEqual(tracked(s), expectedTracked(s, { withRecord: true }));
  assert.ok(s.lgit("show", "--name-only", "--format=", "HEAD").split("\n").includes(`${s.runRel}/record.json`));
  assert.ok(committedPaths(s).every((p) => p.startsWith(`${s.runRel}/`)), committedPaths(s).join("\n"));
  assert.equal(s.lgit("log", "-1", "--format=%an <%ae>").trim(), "tasque-loop <tasque-loop@localhost>");
  assert.equal(s.lgit("status", "--porcelain").trim(), "");
  assert.equal(s.lgit("remote").trim(), "");

  assert.equal(s.git("status", "--porcelain"), projectStatus);
});

test("正常系: --snapshot の後でランの記録が変わっていても、--run は raw/ を最新の内容（消えたファイルは消す）にしてから record.json を書く", async () => {
  const s = await setup();
  populate(s);
  const snap = s.snapshot();
  assert.equal(snap.status, 0, snap.stderr);

  mutate(s);
  const r = s.ledger();
  assert.equal(r.status, 0, r.stderr);

  assert.deepEqual(tree(s.rawDir()), tree(s.paths.dir));
  assert.equal(existsSync(join(s.rawDir(), "tasks", "T1.post-history.json")), false);
  const record = JSON.parse(readFileSync(s.recordPath(), "utf8"));
  assert.deepEqual(record.human.reviews, [{ at: "2026-11-26T02:00:00.000Z", verdict: "approved", text: "変えた" }]);

  assert.deepEqual(tracked(s), expectedTracked(s, { withRecord: true }));
  assert.equal(s.lgit("status", "--porcelain").trim(), "");
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

test("正常系: 台帳のリポジトリに名前とメールの設定があればそれを使い、そのランのパスだけをコミットする", async () => {
  const s = await setup();
  populate(s);
  mkdirSync(s.ledgerDir, { recursive: true });
  s.lgit("init", "-q");
  s.lgit("config", "user.name", "ledger-owner");
  s.lgit("config", "user.email", "owner@example.invalid");
  writeFileSync(join(s.ledgerDir, "memo.txt"), "手元のメモ\n");

  const r = s.ledger();
  assert.equal(r.status, 0, r.stderr);

  assert.equal(s.lgit("log", "-1", "--format=%an <%ae>").trim(), "ledger-owner <owner@example.invalid>");
  assert.deepEqual(tracked(s), expectedTracked(s, { withRecord: true }));
  assert.ok(committedPaths(s).every((p) => p.startsWith(`${s.runRel}/`)), committedPaths(s).join("\n"));
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
  assert.deepEqual(tree(s.rawDir(ledgerDir)), tree(s.paths.dir));
  const status = execFileSync("git", ["status", "--porcelain"], { cwd: ledgerDir, env: s.env, encoding: "utf8" });
  assert.equal(status.trim(), "");
});

test("正常系: 台帳の場所が空のディレクトリなら git init して使う", async () => {
  const s = await setup();
  mkdirSync(s.ledgerDir, { recursive: true });
  const ok = s.ledger();
  assert.equal(ok.status, 0, ok.stderr);
  assert.ok(commitCount(s) >= 1);
  assert.ok(existsSync(s.recordPath()));
});

// ---- 正常系: --snapshot で raw/ だけを置き換える ----

test("正常系: --snapshot は .tasque/runs/<run>/ の写しを raw/ に書いてコミットし、record.json は書かない", async () => {
  const s = await setup();
  populate(s);
  const projectStatus = s.git("status", "--porcelain");

  const r = s.snapshot();
  assert.equal(r.status, 0, r.stderr);

  assert.deepEqual(tree(s.rawDir()), tree(s.paths.dir));
  assert.equal(existsSync(s.recordPath()), false);
  assert.deepEqual(tracked(s), expectedTracked(s, { withRecord: false }));
  assert.ok(committedPaths(s).every((p) => p.startsWith(`${s.runRel}/raw/`)), committedPaths(s).join("\n"));
  assert.equal(commitCount(s), 1);
  assert.equal(s.lgit("log", "-1", "--format=%an <%ae>").trim(), "tasque-loop <tasque-loop@localhost>");
  assert.equal(s.lgit("status", "--porcelain").trim(), "");
  assert.equal(s.lgit("remote").trim(), "");

  assert.equal(s.git("status", "--porcelain"), projectStatus);
});

test("正常系: --snapshot を繰り返すと、変わった・増えたファイルを反映し、コピー元で消えたファイルは raw/ からも消してコミットする", async () => {
  const s = await setup();
  populate(s);
  assert.equal(s.snapshot().status, 0);
  const before = commitCount(s);

  mutate(s);
  const r = s.snapshot();
  assert.equal(r.status, 0, r.stderr);

  assert.deepEqual(tree(s.rawDir()), tree(s.paths.dir));
  assert.equal(existsSync(join(s.rawDir(), "tasks", "T1.post-history.json")), false);
  assert.equal(commitCount(s), before + 1);
  assert.deepEqual(tracked(s), expectedTracked(s, { withRecord: false }));
  assert.ok(
    s.lgit("show", "--name-only", "--format=", "HEAD").split("\n").filter(Boolean).every((p) => p.startsWith(`${s.runRel}/raw/`)),
  );
  assert.equal(existsSync(s.recordPath()), false);
  assert.equal(s.lgit("status", "--porcelain").trim(), "");
});

test("正常系: --snapshot は中身が変わっていなければコミットせずに exit 0", async () => {
  const s = await setup();
  populate(s);
  assert.equal(s.snapshot().status, 0);
  const head = s.lgit("rev-parse", "HEAD").trim();

  const r = s.snapshot();
  assert.equal(r.status, 0, r.stderr);
  assert.equal(s.lgit("rev-parse", "HEAD").trim(), head);
  assert.deepEqual(tree(s.rawDir()), tree(s.paths.dir));
  assert.equal(s.lgit("status", "--porcelain").trim(), "");
});

test("正常系: --snapshot も台帳のリポジトリにある無関係のファイルには触れず、そのランのパスだけをコミットする", async () => {
  const s = await setup();
  populate(s);
  mkdirSync(s.ledgerDir, { recursive: true });
  s.lgit("init", "-q");
  s.lgit("config", "user.name", "ledger-owner");
  s.lgit("config", "user.email", "owner@example.invalid");
  writeFileSync(join(s.ledgerDir, "memo.txt"), "手元のメモ\n");

  const r = s.snapshot();
  assert.equal(r.status, 0, r.stderr);
  assert.equal(s.lgit("log", "-1", "--format=%an <%ae>").trim(), "ledger-owner <owner@example.invalid>");
  assert.ok(committedPaths(s).every((p) => p.startsWith(`${s.runRel}/raw/`)), committedPaths(s).join("\n"));
  assert.equal(s.lgit("status", "--porcelain").trim(), "?? memo.txt");
});

// ---- 異常系: 台帳に何も書かない ----

test("異常系: --run は record.json がすでにあればエラーにし、record.json も raw/ もコミットも変えない", async () => {
  const s = await setup();
  populate(s);
  assert.equal(s.ledger().status, 0);
  const record = readFileSync(s.recordPath(), "utf8");
  const raw = tree(s.rawDir());
  const head = s.lgit("rev-parse", "HEAD").trim();

  mutate(s);
  const r = s.ledger();
  assert.equal(r.status, 1);
  assert.equal(readFileSync(s.recordPath(), "utf8"), record);
  assert.deepEqual(tree(s.rawDir()), raw);
  assert.equal(s.lgit("rev-parse", "HEAD").trim(), head);
  assert.equal(s.lgit("status", "--porcelain").trim(), "");
});

test("異常系: --snapshot は record.json がすでにある（ランが終わっている）ならエラーにし、raw/ もコミットも変えない", async () => {
  const s = await setup();
  populate(s);
  assert.equal(s.ledger().status, 0);
  const raw = tree(s.rawDir());
  const head = s.lgit("rev-parse", "HEAD").trim();

  mutate(s);
  const r = s.snapshot();
  assert.equal(r.status, 1);
  assert.deepEqual(tree(s.rawDir()), raw);
  assert.equal(s.lgit("rev-parse", "HEAD").trim(), head);
  assert.equal(s.lgit("status", "--porcelain").trim(), "");
});

test("異常系: --run がなければ使い方を出して exit 2 で止まり、承認されていないランは --run でも --snapshot でもエラーにして台帳に何も書かない", async () => {
  const s = await setup();
  const usage = s.ledger([]);
  assert.equal(usage.status, 2);
  assert.match(usage.stderr, /usage/);

  const snapUsage = s.ledger(["--snapshot"]);
  assert.equal(snapUsage.status, 2);
  assert.match(snapUsage.stderr, /usage/);

  const r = s.ledger(["--run", "2026-01-01-none"]);
  assert.equal(r.status, 1);
  const snap = s.ledger(["--run", "2026-01-01-none", "--snapshot"]);
  assert.equal(snap.status, 1);
  assert.equal(existsSync(join(s.ledgerDir, s.project, "2026-01-01-none")), false);
  assert.equal(existsSync(join(s.ledgerDir, s.project, "2026-01-01-none.json")), false);
});

test("異常系: 台帳の場所が中身のある git 管理外のディレクトリなら、--run でも --snapshot でも何も書かずにエラーにする", async () => {
  const s = await setup();
  populate(s);
  const other = join(s.tmp, "notes");
  mkdirSync(other);
  writeFileSync(join(other, "memo.txt"), "手元のメモ\n");
  const otherEnv = { ...s.env, TASQUE_LEDGER_DIR: other };

  for (const r of [s.ledger(["--run", s.plan.run], otherEnv), s.snapshot(otherEnv)]) {
    assert.equal(r.status, 1);
    assert.match(r.stderr, /git リポジトリのルートでない/);
  }
  assert.equal(existsSync(join(other, ".git")), false);
  assert.equal(existsSync(join(other, s.project)), false);
});
