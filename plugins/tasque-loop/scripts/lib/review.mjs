import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { loadApproved, taskFile } from "./run.mjs";

export const REVIEW_ROUNDS = [1, 2];
export const PERSPECTIVES = ["要件", "正確性", "整合"];
export const SEVERITIES = ["blocker", "major", "minor", "nit"];
export const DISPOSITIONS = ["fix", "rejected", "carryover"];
export const FOUND_BY = ["並列:要件", "並列:正確性", "並列:整合", "1体"];

const FINDING_KEYS = ["perspective", "severity", "location", "problem", "fix", "disposition", "reject_reason", "found_by"];
const TEXT_KEYS = ["location", "problem", "fix"];

/**
 * 指摘の配列の形を確かめ、問題の一覧を返す。空の配列は指摘なしとして正しい。
 * 決められた以外のキーと、空の文字列は不正とする。found_by は FOUND_BY の重複なしの空でない配列で、
 * ラウンド 2 では 1体 を含めない（2ラウンド目は1体を起動しない）。
 */
export function findingErrors(findings, round) {
  if (!Array.isArray(findings)) return ["指摘は配列にする"];
  const errors = [];
  findings.forEach((f, i) => {
    const where = `指摘 ${i + 1}`;
    if (typeof f !== "object" || f === null || Array.isArray(f)) {
      errors.push(`${where}: オブジェクトにする`);
      return;
    }
    for (const key of Object.keys(f)) {
      if (!FINDING_KEYS.includes(key)) errors.push(`${where}: キー ${key} は使えない`);
    }
    if (!PERSPECTIVES.includes(f.perspective)) errors.push(`${where}: perspective は ${PERSPECTIVES.join("|")}`);
    if (!SEVERITIES.includes(f.severity)) errors.push(`${where}: severity は ${SEVERITIES.join("|")}`);
    if (!DISPOSITIONS.includes(f.disposition)) errors.push(`${where}: disposition は ${DISPOSITIONS.join("|")}`);
    for (const key of TEXT_KEYS) {
      if (!isText(f[key])) errors.push(`${where}: ${key} は空でない文字列にする`);
    }
    if (f.reject_reason !== undefined && !isText(f.reject_reason)) {
      errors.push(`${where}: reject_reason は空でない文字列にする`);
    }
    if (f.disposition === "rejected" && f.reject_reason === undefined) {
      errors.push(`${where}: disposition が rejected なら reject_reason が必要`);
    }
    if (!Array.isArray(f.found_by) || f.found_by.length === 0) {
      errors.push(`${where}: found_by は空でない配列にする`);
    } else {
      if (f.found_by.some((v) => !FOUND_BY.includes(v))) errors.push(`${where}: found_by は ${FOUND_BY.join("|")} のどれか`);
      if (new Set(f.found_by).size !== f.found_by.length) errors.push(`${where}: found_by に同じ値を重ねない`);
      if (round === 2 && f.found_by.includes("1体")) errors.push(`${where}: ラウンド 2 の found_by に 1体 は使えない`);
    }
  });
  return errors;
}

const isText = (s) => typeof s === "string" && s.trim() !== "";

/**
 * タスクのレビュー結果（指摘の配列）を tasks/<id>.review-<round>.json に1回分書く。
 * 承認済みのランと契約にあるタスクだけを受け付ける。ラウンド2は、ラウンド1の記録があるときだけ書く。
 * 同じラウンドの記録がすでにあれば書かない。形が不正なら何も書かず例外。
 */
export function recordReview(projectDir, run, { task, round, findings }, { now = new Date() } = {}) {
  if (!REVIEW_ROUNDS.includes(round)) throw new Error(`round が不正: ${round}`);
  const plan = loadApproved(projectDir, run);
  if (!plan.tasks.some((t) => t.id === task)) throw new Error(`run ${run} にタスク ${task} はない`);
  const errors = findingErrors(findings, round);
  if (errors.length > 0) throw new Error(errors.join("\n"));

  const file = taskFile(projectDir, run, task, `.review-${round}.json`);
  if (existsSync(file)) throw new Error(`タスク ${task} のラウンド ${round} のレビューは記録済み`);
  if (round === 2 && !existsSync(taskFile(projectDir, run, task, ".review-1.json"))) {
    throw new Error(`タスク ${task} のラウンド 1 の記録がない`);
  }

  const entry = { run, task, round, recorded_at: now.toISOString(), findings };
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(entry, null, 2) + "\n", { flag: "wx" });
  return entry;
}
