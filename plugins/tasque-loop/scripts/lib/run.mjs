import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { RUN_ID, TASK_ID, validatePlan } from "./contract.mjs";
import { currentBranch } from "./git.mjs";
import { draftDigest, draftPaths, planDigest, readJson } from "./plan-check.mjs";

export const REVIEW_VERDICTS = ["changes_requested", "approved"];

/**
 * ランのファイル配置。
 * - approved.json: 承認時に凍結した契約。以後は書き換えない
 * - approval.json: 凍結した契約の sha256、承認日時、基点コミット、テストファイルの sha256
 * - baseline.json: 承認時に .tasque/baseline.json から写した基点の記録
 * - escalations.json: 実行中に implementer が上げた不確実な点と、それへの人間の回答（項目の追記と、未回答の項目への回答の記録だけ）
 * - reviews.json: 承認時に下書きから移した、人間のレビュー結果の記録
 */
export function runPaths(projectDir, run) {
  if (!RUN_ID.test(run)) throw new Error(`run id が不正: ${run}`);
  const dir = join(projectDir, ".tasque", "runs", run);
  return {
    dir,
    approved: join(dir, "approved.json"),
    approval: join(dir, "approval.json"),
    baseline: join(dir, "baseline.json"),
    escalations: join(dir, "escalations.json"),
    reviews: join(dir, "reviews.json"),
  };
}

/**
 * タスク単位のファイルの置き場所。ID をファイル名に使うので形式を確かめる。
 */
export function taskFile(projectDir, run, taskId, suffix) {
  if (typeof taskId !== "string" || !TASK_ID.test(taskId)) throw new Error(`task id が不正: ${taskId}`);
  return join(runPaths(projectDir, run).dir, "tasks", `${taskId}${suffix}`);
}

/**
 * worktree を作った直後（planner より前）に記録する基点。verify --phase baseline が書く。
 */
export function baselinePath(projectDir) {
  return join(projectDir, ".tasque", "baseline.json");
}

/**
 * 契約を ready として検証し、承認済みとして凍結する。凍結済みのランは上書きしない。
 * 次のいずれかなら承認しない。
 * - .tasque/baseline.json がない、または基点の全体テストが落ちていた
 * - HEAD が detached か、現在のブランチが契約の base と同じ（ベースブランチで直接作業させない）
 * - tests に挙げたファイルがない
 * 承認記録には基点コミット（base_commit）と、全タスクのテストファイルの sha256 を残す。
 * 下書きのレビュー結果があれば、承認に成功したあとでランの reviews.json に移す。
 * 戻り値は凍結した契約のパスとハッシュ。
 */
export function approvePlan(projectDir, plan, { now = new Date() } = {}) {
  const errors = validatePlan(plan, { stage: "ready" });
  if (errors.length > 0) throw new ContractError(errors);

  const paths = runPaths(projectDir, plan.run);
  if (existsSync(paths.approved)) {
    throw new Error(`run ${plan.run} は承認済み。変更は新しい run で行う`);
  }

  const baseline = readJson(baselinePath(projectDir));
  if (!baseline?.commit) {
    throw new Error(".tasque/baseline.json がない。worktree を作った直後に verify --phase baseline を走らせる");
  }
  if (baseline.ok === false) throw new Error("基点で全体テストが落ちている。ランを始める前に直す");

  const branch = currentBranch(projectDir);
  if (branch === null) throw new Error("HEAD が detached。作業ブランチに切り替えてから承認する");
  if (branch === plan.base) throw new Error(`現在のブランチが base（${plan.base}）と同じ。作業ブランチで承認する`);

  const tests = {};
  for (const t of plan.tasks.flatMap((task) => task.tests).sort()) {
    const file = join(projectDir, t);
    if (!existsSync(file)) throw new Error(`テスト ${t} がない`);
    tests[t] = sha256Of(readFileSync(file));
  }

  mkdirSync(paths.dir, { recursive: true });
  const body = JSON.stringify(plan, null, 2) + "\n";
  const sha256 = sha256Of(body);
  writeFileSync(paths.approved, body, { flag: "wx" });
  chmodSync(paths.approved, 0o444);
  writeFileSync(paths.baseline, JSON.stringify(baseline, null, 2) + "\n", { flag: "wx" });
  writeFileSync(
    paths.approval,
    JSON.stringify(
      { run: plan.run, sha256, approved_at: now.toISOString(), base_commit: baseline.commit, branch, tests },
      null,
      2,
    ) + "\n",
    { flag: "wx" },
  );
  const reviews = draftPaths(projectDir).reviews;
  if (existsSync(reviews)) renameSync(reviews, paths.reviews);
  return { path: paths.approved, sha256 };
}

/**
 * 契約の下書きに対する人間のレビュー結果を .tasque/plan.draft.reviews.json に1回分追記する。
 * text は読んだ原文（末尾の改行は呼び出し側で除く）。draft_digest は記録時点の下書きのハッシュ。
 * 下書きが読めない、または text が空なら何も書かない。承認時に approvePlan が reviews.json に移す。
 */
export function appendReview(projectDir, { verdict, text }, { now = new Date() } = {}) {
  if (!REVIEW_VERDICTS.includes(verdict)) throw new Error(`verdict が不正: ${verdict}`);
  if (typeof text !== "string" || text.trim() === "") throw new Error("text が空");
  const digest = draftDigest(projectDir);
  if (digest === null) throw new Error(".tasque/plan.draft.json が読めない");

  const file = draftPaths(projectDir).reviews;
  const list = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : [];
  const entry = { at: now.toISOString(), verdict, text, draft_digest: digest };
  list.push(entry);
  writeFileSync(file, JSON.stringify(list, null, 2) + "\n");
  return entry;
}

/**
 * 検査（SubagentStop）と Red 確認を通った下書きだけを承認する。CLI（approve.mjs）はこちらを使う。
 * 検査結果が ok で、検査時・Red 確認時・現在の契約とテストのハッシュがすべて一致することを要求する。
 * uncertain の decision はハッシュに含めないので、レビュー中に埋めても一致する。
 */
export function approveChecked(projectDir, plan, opts = {}) {
  const paths = draftPaths(projectDir);
  const check = readJson(paths.check);
  const red = readJson(paths.red);
  const current = planDigest(projectDir, plan);
  const problems = [];
  if (check?.ok !== true) problems.push("下書きの検査が通っていない");
  if (!check?.digest || check.digest !== current) problems.push("検査後に契約かテストが変わっている");
  if (!red?.digest || red.digest !== current) problems.push("Red 確認後に契約かテストが変わっている（または Red 確認をしていない）");
  if (problems.length > 0) throw new Error(`${problems.join("。")}。検査と Red 確認をやり直して`);
  return approvePlan(projectDir, plan, opts);
}

/**
 * 凍結した契約を読み、承認時のハッシュと一致することを確かめて返す。一致しなければ例外。
 */
export function loadApproved(projectDir, run) {
  return loadApproval(projectDir, run).plan;
}

/**
 * 凍結した契約と承認記録を読む。契約が承認時のハッシュと一致しなければ例外。
 */
export function loadApproval(projectDir, run) {
  const paths = runPaths(projectDir, run);
  const body = readFileSync(paths.approved, "utf8");
  const approval = JSON.parse(readFileSync(paths.approval, "utf8"));
  if (sha256Of(body) !== approval.sha256) {
    throw new Error(`run ${run} の承認済み契約が承認後に書き換えられている`);
  }
  return { plan: JSON.parse(body), approval };
}

/**
 * 実行中に見つかった不確実な点をエスカレーションとして追記する。契約そのものには触れない。
 */
export function appendEscalation(projectDir, run, { task, q, context = "" }, { now = new Date() } = {}) {
  const plan = loadApproved(projectDir, run);
  if (!plan.tasks.some((t) => t.id === task)) throw new Error(`run ${run} にタスク ${task} はない`);
  if (typeof q !== "string" || q.trim() === "") throw new Error("q が空");

  const paths = runPaths(projectDir, run);
  const list = existsSync(paths.escalations) ? JSON.parse(readFileSync(paths.escalations, "utf8")) : [];
  const entry = { task, q, context, raised_by: "implementer", raised_at: now.toISOString() };
  list.push(entry);
  writeFileSync(paths.escalations, JSON.stringify(list, null, 2) + "\n");
  return entry;
}

/**
 * 人間の回答を、そのタスクの未回答のエスカレーションのうち最後の1件に記録する。回答済みの項目は変えない。
 * answer は読んだ原文（末尾の改行は呼び出し側で除く）。空なら何も書かない。
 */
export function recordAnswer(projectDir, run, { task, answer }, { now = new Date() } = {}) {
  if (typeof answer !== "string" || answer.trim() === "") throw new Error("answer が空");
  loadApproved(projectDir, run);

  const file = runPaths(projectDir, run).escalations;
  if (!existsSync(file)) throw new Error(`run ${run} に escalations.json がない`);
  const list = JSON.parse(readFileSync(file, "utf8"));
  const index = list.findLastIndex((e) => e.task === task && !("answer" in e));
  if (index === -1) throw new Error(`タスク ${task} に未回答のエスカレーションがない`);

  list[index] = { ...list[index], answer, answered_at: now.toISOString() };
  writeFileSync(file, JSON.stringify(list, null, 2) + "\n");
  return list[index];
}

export class ContractError extends Error {
  constructor(errors) {
    super(errors.join("\n"));
    this.errors = errors;
  }
}

export function sha256Of(data) {
  return createHash("sha256").update(data).digest("hex");
}
