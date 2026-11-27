import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { canonicalPathError, validatePlan } from "./contract.mjs";
import { isTrackedAs } from "./git.mjs";

export const PLANNER = "tasque-loop:planner";
export const MAX_ATTEMPTS = 3;

/**
 * planner が書く契約の下書きと、その検査結果・Red 確認結果・人間のレビュー結果の置き場所。
 * 検査結果はメインエージェントが「planner の契約が draft として妥当か」を知るために読む。
 */
export function draftPaths(projectDir) {
  const dir = join(projectDir, ".tasque");
  return {
    dir,
    draft: join(dir, "plan.draft.json"),
    check: join(dir, "plan.draft.check.json"),
    red: join(dir, "plan.draft.red.json"),
    reviews: join(dir, "plan.draft.reviews.json"),
  };
}

/**
 * 契約とそのテストファイルの中身をまとめたハッシュ。検査・Red 確認・承認が同じものを見ていることを確かめるために使う。
 * uncertain の decision は人間がレビュー中に埋めるものなので、ハッシュに含めない。
 * テストファイルはパス順に、パスと長さと中身を連結する（存在しなければその旨を含める）。
 */
export function planDigest(projectDir, plan) {
  const h = createHash("sha256");
  h.update(JSON.stringify(withoutDecisions(plan)));
  const tests = [...new Set((plan.tasks ?? []).flatMap((t) => (Array.isArray(t?.tests) ? t.tests : [])))]
    .filter((t) => typeof t === "string" && canonicalPathError(t, { glob: false }) === null)
    .sort();
  for (const t of tests) {
    const file = join(projectDir, t);
    h.update(`\0${t}\0`);
    if (existsSync(file)) {
      const body = readFileSync(file);
      h.update(`${body.length}\0`);
      h.update(body);
    } else h.update("missing\0");
  }
  return h.digest("hex");
}

/**
 * 現在の下書き（.tasque/plan.draft.json）のハッシュ。読めなければ null。
 */
export function draftDigest(projectDir) {
  try {
    return planDigest(projectDir, JSON.parse(readFileSync(draftPaths(projectDir).draft, "utf8")));
  } catch {
    return null;
  }
}

function withoutDecisions(plan) {
  if (!Array.isArray(plan?.tasks)) return plan;
  return {
    ...plan,
    tasks: plan.tasks.map((t) =>
      Array.isArray(t?.uncertain) ? { ...t, uncertain: t.uncertain.map((u) => ({ ...u, decision: null })) } : t,
    ),
  };
}

/**
 * planner の SubagentStop で契約の下書きと、tests に挙げたテストファイルの有無を検査する。
 * 不正なら差し戻し（decision: block）を返し、planner に直させる。差し戻しは MAX_ATTEMPTS 回まで。
 * 上限に達したら止めるのを許し、検査結果に ok: false を残す。planner 以外は null。
 * 検査結果には下書きとテストのハッシュ（digest）も残し、承認時に検査後の書き換えを検出できるようにする。
 */
export function decidePlannerStop(input, { projectDir, maxAttempts = MAX_ATTEMPTS }) {
  if (input.agent_type !== PLANNER) return null;

  const paths = draftPaths(projectDir);
  const previous = readJson(paths.check);
  const sameAgent = previous && input.agent_id && previous.agent_id === input.agent_id;
  const attempts = (sameAgent ? previous.attempts : 0) + 1;
  const errors = checkDraft(projectDir, paths.draft);
  const ok = errors.length === 0;

  mkdirSync(paths.dir, { recursive: true });
  writeFileSync(
    paths.check,
    JSON.stringify(
      {
        agent_id: input.agent_id ?? null,
        attempts,
        ok,
        gave_up: !ok && attempts >= maxAttempts,
        digest: draftDigest(projectDir),
        errors,
      },
      null,
      2,
    ) + "\n",
  );

  if (ok || attempts >= maxAttempts) return null;
  return {
    decision: "block",
    reason:
      `[tasque-loop] .tasque/plan.draft.json が契約として不正（差し戻し ${attempts}/${maxAttempts - 1} 回目）。` +
      `次を直してから終了すること:\n- ${errors.join("\n- ")}`,
  };
}

function checkDraft(projectDir, file) {
  if (!existsSync(file)) return [".tasque/plan.draft.json がない。契約をこのパスに書く"];
  let plan;
  try {
    plan = JSON.parse(readFileSync(file, "utf8"));
  } catch (e) {
    return [`JSON として読めない: ${e.message}`];
  }
  const errors = validatePlan(plan, { stage: "draft" });
  if (errors.length > 0) return errors;
  const missingTests = plan.tasks.flatMap((task) =>
    (task.tests ?? [])
      .filter((t) => !existsSync(join(projectDir, t)))
      .map((t) => `${task.id}: テスト ${t} がない。契約と一緒にテストファイルも書く`),
  );
  const badDeletes = plan.tasks.flatMap((task) =>
    (task.delete ?? [])
      .filter((p) => !existsSync(join(projectDir, p)) || !trackedOrFalse(projectDir, p))
      .map((p) => `${task.id}: delete の ${p} が git の管理下にない。delete には既存の追跡済みファイルを、その名前のまま書く`),
  );
  return [...missingTests, ...badDeletes];
}

function trackedOrFalse(projectDir, p) {
  try {
    return isTrackedAs(projectDir, p);
  } catch {
    return false;
  }
}

export function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}
