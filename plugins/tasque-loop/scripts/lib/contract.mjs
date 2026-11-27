import { posix } from "node:path";
import { foldPath, samePath } from "./paths.mjs";

/**
 * 契約の検証段階。
 * - draft: planner が書き終えた直後。構造だけを検査する
 * - ready: 人間の承認後。uncertain がすべて決定済みであることも要求する
 */
export const STAGES = ["draft", "ready"];

const RAISED_BY = ["planner", "implementer"];

export const RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** タスク ID の形式。ファイル名に使うため run id と同じ制約にする。 */
export const TASK_ID = RUN_ID;

const GLOB_CHARS = /[*?[\]{}]/;

/**
 * パスが glob のいずれかに一致するかを返す。パスはプロジェクトルートからの POSIX 相対パスを前提とする。
 */
export function matchesAny(path, globs) {
  return globs.some((g) => posix.matchesGlob(path, g));
}

/**
 * パスが allow に一致し、deny に一致しないかを返す。
 * 大文字小文字を区別しないファイルシステムで deny をすり抜けられないよう、deny は小文字に揃えて照合する。
 * allow は区別したままにする（大文字小文字が違えば許可されないので、拒否側に倒れる）。
 */
export function isAllowed(path, task) {
  const deny = (task.deny ?? []).map((g) => g.toLowerCase());
  return matchesAny(path, task.allow) && !matchesAny(path.toLowerCase(), deny);
}

/**
 * 2つのプロジェクト相対パスが同じファイルを指しうるかを返す（本体は paths.mjs）。テストファイルの照合はすべてこの関数を通す。
 */
export { samePath };

/**
 * パスがどれかのタスクの受け入れテストなら、そのタスクを返す。なければ undefined。
 * plan か tasks の配列を受け取る。
 */
export function testOwner(path, planOrTasks) {
  const tasks = Array.isArray(planOrTasks) ? planOrTasks : planOrTasks.tasks;
  return tasks.find((t) => (t.tests ?? []).some((x) => samePath(x, path)));
}

/**
 * パスがどれかのタスクの受け入れテストかを返す。
 */
export function isTestPath(path, planOrTasks) {
  return testOwner(path, planOrTasks) !== undefined;
}

/**
 * 契約に書くパスの正規形を検査し、問題があればメッセージを返す。正規形なら null。
 * 照合は文字列のまま行うため、`./` や `//`、末尾の `/` などの書き方の揺れは黙って直さずに拒否する。
 * glob: false なら glob の特殊文字も拒否する（テストファイルや作業ディレクトリのように1つのパスを指すもの）。
 */
export function canonicalPathError(p, { glob = true } = {}) {
  if (p.includes("\\")) return "区切りは / を使う";
  if (posix.isAbsolute(p) || /^[A-Za-z]:/.test(p)) return "プロジェクトルートからの相対パスにする";
  const parts = p.split("/");
  if (parts.includes("..")) return ".. は使えない";
  if (parts.includes(".")) return ". は使えない（先頭の ./ も書かない）";
  if (parts.includes("")) return "空の要素がある（// や末尾の / を書かない）";
  if (!glob && GLOB_CHARS.test(p)) return "glob の特殊文字（* ? [ ] { }）は使えない";
  return null;
}

const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(\..*)?$/i;

/**
 * プロジェクト相対パスが、どの OS でも同じファイルとして扱える名前かを確かめる。問題がなければ null。
 * POSIX で作れても Windows で扱えない名前（git に載せると Windows で壊れる）を止める。
 * - Windows で使えない文字（\ : * ? " < > | と制御文字）
 * - 末尾のドットや空白
 * - Windows の予約名（CON、NUL、COM1 など。拡張子つきも含む）
 */
export function portablePathError(p) {
  for (const part of p.split("/")) {
    if (/[\\:*?"<>|\x00-\x1f]/.test(part)) return `「${part}」に Windows で使えない文字がある`;
    if (/[.\s]$/.test(part) && part !== "." && part !== "..") return `「${part}」がドットか空白で終わる`;
    if (WINDOWS_RESERVED.test(part)) return `「${part}」は Windows の予約名`;
  }
  return null;
}

/**
 * どの階層にあっても tasque-loop のエージェントに書かせない名前（小文字）。
 * - ディレクトリ: git の内部状態と Claude Code の設定
 * - ファイル: 後続のエージェントに読み込まれる指示ファイル（入れ子の CLAUDE.md を含む）
 * glob の ** はドットで始まるディレクトリをまたがないため、パスの要素ごとに照合する。
 */
const PROTECTED_DIRS = [".git", ".claude"];
const PROTECTED_FILES = ["claude.md", "claude.local.md"];

/**
 * foldPath で正規化したプロジェクト相対パスが、.git・.claude の中か、CLAUDE.md・CLAUDE.local.md を指すか。
 */
export function isProtectedPath(lowerRel) {
  const parts = lowerRel.split("/");
  return parts.some((c) => PROTECTED_DIRS.includes(c)) || PROTECTED_FILES.includes(parts.at(-1));
}

/** tasque の制御ファイルと設定（小文字の glob）。planner も implementer も書き換えられず、契約の delete にも書けない。 */
export const CONTROL_PATHS = [".tasque/**", "tasque.config.json"];

/**
 * どの階層にあっても implementer に書かせず、契約の delete にも書けないファイル名（小文字）。
 * .gitignore は書いた後のファイルを検査から隠せるため。
 */
export const HIDING_FILES = [".gitignore"];

/**
 * 契約の delete に書けないパス（保護パス、tasque の制御ファイルと設定、.gitignore）なら理由を返す。書けるなら null。
 */
function deletePathError(p) {
  const lower = foldPath(p);
  if (isProtectedPath(lower)) return ".git・.claude の中や CLAUDE.md は消せない";
  if (matchesAny(lower, CONTROL_PATHS)) return "tasque の制御ファイルと設定は消せない";
  if (HIDING_FILES.includes(lower.split("/").at(-1))) return ".gitignore は消せない";
  return null;
}

/**
 * ラン単位の契約（plan）を検証し、エラーメッセージの配列を返す。空配列なら妥当。
 */
export function validatePlan(plan, { stage = "draft" } = {}) {
  if (!STAGES.includes(stage)) throw new Error(`unknown stage: ${stage}`);
  const errors = [];
  const err = (where, msg) => errors.push(`${where}: ${msg}`);

  if (!isObject(plan)) return ["plan: オブジェクトではない"];
  if (plan.version !== 1) err("version", "1 でなければならない");
  for (const key of ["run", "request", "base"]) {
    if (!isNonEmptyString(plan[key])) err(key, "空でない文字列が必要");
  }
  if (isNonEmptyString(plan.run) && !RUN_ID.test(plan.run)) {
    err("run", "英数字と . _ - だけで構成する（ディレクトリ名に使うため）");
  }
  if (!Array.isArray(plan.tasks) || plan.tasks.length === 0) {
    err("tasks", "1件以上の配列が必要");
    return errors;
  }

  const seen = new Set();
  plan.tasks.forEach((task, i) => {
    const where = `tasks[${i}]${isNonEmptyString(task?.id) ? `(${task.id})` : ""}`;
    if (!isObject(task)) return err(where, "オブジェクトではない");

    if (!isNonEmptyString(task.id)) err(where, "id が必要");
    else if (!TASK_ID.test(task.id)) err(where, "id は英数字と . _ - だけで構成する（ファイル名に使うため）");
    else if (seen.has(task.id)) err(where, `id ${task.id} が重複している`);

    for (const key of ["title", "goal"]) {
      if (!isNonEmptyString(task[key])) err(where, `${key} が必要`);
    }

    // depends_on は予約フィールド。実行順には使わず、参照先が前方のタスクであることだけを確かめる
    checkStringArray(task.depends_on ?? [], `${where}.depends_on`, err);
    for (const dep of task.depends_on ?? []) {
      if (!seen.has(dep)) err(`${where}.depends_on`, `${dep} はこのタスクより前に定義されていない`);
    }

    if (checkStringArray(task.allow, `${where}.allow`, err, { nonEmpty: true })) {
      task.allow.forEach((g) => checkCanonical(g, `${where}.allow`, err));
    }
    if (checkStringArray(task.deny ?? [], `${where}.deny`, err)) {
      (task.deny ?? []).forEach((g) => checkCanonical(g, `${where}.deny`, err));
    }
    checkStringArray(task.out_of_scope, `${where}.out_of_scope`, err);

    if (checkStringArray(task.delete ?? [], `${where}.delete`, err)) {
      for (const p of task.delete ?? []) {
        checkCanonical(p, `${where}.delete`, err, { glob: false });
        const msg = deletePathError(p);
        if (msg) err(`${where}.delete`, `${p}: ${msg}`);
      }
    }

    if (checkStringArray(task.tests, `${where}.tests`, err)) {
      task.tests.forEach((t) => checkCanonical(t, `${where}.tests`, err, { glob: false }));
    }

    if (!Array.isArray(task.acceptance)) err(`${where}.acceptance`, "配列が必要");
    else {
      if (task.tests?.length > 0 && task.acceptance.length === 0) {
        err(`${where}.acceptance`, "tests があるのに受け入れコマンドがない");
      }
      task.acceptance.forEach((a, j) => {
        const w = `${where}.acceptance[${j}]`;
        if (!isNonEmptyString(a?.cmd)) err(w, "cmd が必要");
        if (!isNonEmptyString(a?.why)) err(w, "why が必要");
        if (a?.cwd !== undefined) {
          if (!isNonEmptyString(a.cwd)) err(w, "cwd は空でない文字列");
          else checkCanonical(a.cwd, `${w}.cwd`, err, { glob: false });
        }
      });
    }

    if (!isObject(task.max_diff)) err(`${where}.max_diff`, "オブジェクトが必要");
    else {
      for (const key of ["lines", "files"]) {
        if (!Number.isInteger(task.max_diff[key]) || task.max_diff[key] <= 0) {
          err(`${where}.max_diff.${key}`, "正の整数が必要");
        }
      }
    }

    if (!Array.isArray(task.uncertain)) err(`${where}.uncertain`, "配列が必要");
    else {
      task.uncertain.forEach((u, j) => {
        const w = `${where}.uncertain[${j}]`;
        if (!isNonEmptyString(u?.q)) err(w, "q が必要");
        if (!RAISED_BY.includes(u?.raised_by)) err(w, `raised_by は ${RAISED_BY.join(" / ")} のいずれか`);
        if (u?.decision !== null && typeof u?.decision !== "string") err(w, "decision は文字列か null");
        if (stage === "ready" && !isNonEmptyString(u?.decision)) err(w, "未決定のまま");
      });
    }

    if (isNonEmptyString(task.id)) seen.add(task.id);
  });

  checkTestsAcrossTasks(plan.tasks, err);
  checkDeletesAcrossTasks(plan.tasks, err);
  return errors;
}

/**
 * パスがタスクの delete に挙がっているか。delete は追跡済みの名前そのままであることを検査済みなので、完全一致で照合する
 * （大文字小文字を区別するファイルシステムで、宣言のない別のファイルの削除を宣言どおりと取り違えないため）。
 */
export function isDeclaredDelete(path, task) {
  return (task.delete ?? []).includes(path);
}

/**
 * ラン全体での delete の検査。
 * - 同じファイルを2つのタスク（または同じタスク内で2回）で消さない
 * - どのタスクの受け入れテストも消さない
 */
function checkDeletesAcrossTasks(tasks, err) {
  const valid = tasks.filter((t) => isObject(t) && Array.isArray(t.delete) && t.delete.every(isNonEmptyString));
  const listed = [];
  for (const task of valid) {
    for (const p of task.delete) {
      const dup = listed.find((x) => samePath(x.path, p));
      if (dup) err(`${label(task)}.delete`, `${p} は ${label(dup.task)} の delete と重複している`);
      else listed.push({ path: p, task });
      const owner = tasks.find((t) => isObject(t) && Array.isArray(t.tests) && t.tests.some((x) => samePath(x, p)));
      if (owner) err(`${label(task)}.delete`, `${p} は ${label(owner)} の受け入れテスト`);
    }
  }
}

/**
 * ラン全体での受け入れテストの検査。
 * - 同じテストファイルを2つのタスク（または同じタスク内で2回）に挙げない
 * - どのタスクの allow（deny を除く）も、どのタスクのテストにも一致しない（implementer が他のタスクのテストを書き換えられない）
 */
function checkTestsAcrossTasks(tasks, err) {
  const valid = tasks.filter(
    (t) => isObject(t) && Array.isArray(t.tests) && t.tests.every(isNonEmptyString),
  );
  const listed = [];
  for (const task of valid) {
    for (const t of task.tests) {
      const dup = listed.find((x) => samePath(x.path, t));
      if (dup) err(`${label(task)}.tests`, `${t} は ${label(dup.task)} の tests と重複している`);
      else listed.push({ path: t, task });
    }
  }
  for (const writer of tasks.filter((t) => isObject(t) && Array.isArray(t.allow) && t.allow.every(isNonEmptyString))) {
    const deny = Array.isArray(writer.deny) && writer.deny.every(isNonEmptyString) ? writer.deny : [];
    for (const { path, task } of listed) {
      if (isAllowed(path, { allow: writer.allow, deny })) {
        const whose = task === writer ? "" : `（${label(task)} のテスト）`;
        err(`${label(writer)}.allow`, `${path}${whose} が allow に含まれている（implementer がテストを書き換えられる）`);
      }
    }
  }
}

function label(task) {
  return isNonEmptyString(task.id) ? task.id : "tasks[?]";
}

function isObject(v) {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isNonEmptyString(v) {
  return typeof v === "string" && v.trim().length > 0;
}

function checkStringArray(v, where, err, { nonEmpty = false } = {}) {
  if (!Array.isArray(v) || !v.every(isNonEmptyString)) {
    err(where, "空でない文字列の配列が必要");
    return false;
  }
  if (nonEmpty && v.length === 0) {
    err(where, "1件以上必要");
    return false;
  }
  return true;
}

function checkCanonical(p, where, err, opts) {
  const msg = canonicalPathError(p, opts);
  if (msg) err(where, `${p}: ${msg}`);
}
