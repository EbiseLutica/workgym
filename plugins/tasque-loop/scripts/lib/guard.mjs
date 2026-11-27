import { existsSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { CONTROL_PATHS, HIDING_FILES, isAllowed, isProtectedPath, matchesAny, testOwner } from "./contract.mjs";
import { DELETE_TOOL, isFullyAbsolute } from "./discard.mjs";
import { isIgnored, resolveProjectDir } from "./git.mjs";
import { PLANNER } from "./plan-check.mjs";
import { loadApproved } from "./run.mjs";

export const IMPLEMENTER = "tasque-loop:implementer";
const AGENT_PREFIX = "tasque-loop:";

/** implementer が使ってよいツール。これ以外は理由を問わず拒否する。 */
const READ_TOOLS = ["Read", "Glob", "Grep"];
const WRITE_TOOLS = ["Edit", "Write"];
/** 書き込みと同じ判定で守るツール。削除ツールは planner・implementer だけが使え、判定を通れば許可する。 */
const MODIFY_TOOLS = [...WRITE_TOOLS, DELETE_TOOL];
/** 呼び出し元へ報告を返すためのツール。これを拒否すると報告が届かない。 */
const REPORT_TOOLS = ["SubagentHandback"];

/**
 * 契約の allow に関係なく implementer に書かせないパスは、制御ファイル（CONTROL_PATHS）と、
 * どの階層の .gitignore も（HIDING_FILES）。大文字小文字を区別しないファイルシステムを考え、小文字に揃えて照合する。
 * planner も制御ファイルには書けないが、契約の下書きだけは .tasque の中でも書ける。
 */
const PLANNER_ALLOW = [".tasque/plan.draft.json"];

/**
 * PreToolUse の入力から判定を返す。null は「判定なし」（通常の権限フローに任せる）。
 * 1. 削除ツールは planner と implementer 以外には使わせない
 * 2. tasque-loop の実行中（.tasque/current がある）か tasque-loop のエージェントなら、プロジェクト外へのファイル操作を拒否する
 * 3. planner の書き込みと削除は、保護パス（.tasque の制御ファイル・.git・.claude・CLAUDE.md）を拒否する
 * 4. implementer なら、さらに実行中タスクの許可リストで書き込みと削除を制限し、ラン内のどのタスクのテストも、git が無視するパスも拒否する
 * 削除ツールは、判定を通れば許可（allow）を返す。ヘッドレスでは許可がないと権限の確認で拒否されるため。
 * 消せるのが未追跡のファイルだけであることは、MCP サーバーの側で確かめる。
 * 契約が読めない、git に問い合わせられないなどの異常はすべて拒否に倒す。
 */
export function decide(
  input,
  {
    projectDir,
    pluginRoot = undefined,
    loadContext = defaultLoadContext,
    runActive = defaultRunActive,
    isIgnored = defaultIsIgnored,
  },
) {
  const tool = input.tool_name;
  if (tool === DELETE_TOOL && input.agent_type !== PLANNER && input.agent_type !== IMPLEMENTER) {
    return deny(`${tool} は tasque-loop の planner と implementer だけが使える`);
  }

  const isTasqueAgent = typeof input.agent_type === "string" && input.agent_type.startsWith(AGENT_PREFIX);
  if (!isTasqueAgent && !runActive(projectDir)) return null;

  const base = typeof input.cwd === "string" && input.cwd !== "" ? input.cwd : projectDir;
  const outside = outsidePaths(input, projectDir, pluginRoot, base);
  if (outside.length > 0) return deny(`${outside.join(", ")} はプロジェクトの外。tasque-loop の実行中はアクセスできない`);

  if (input.agent_type === PLANNER) {
    if (!MODIFY_TOOLS.includes(tool)) return null;
    const target = writeTarget(input, projectDir, base);
    if (target.error) return deny(target.error);
    const lower = target.rel.toLowerCase();
    // 下書きは書き直せるが、消すことはできない
    const draftAllowed = tool !== DELETE_TOOL && PLANNER_ALLOW.includes(lower);
    if (isProtectedPath(lower) || (matchesAny(lower, CONTROL_PATHS) && !draftAllowed)) {
      return deny(`${target.rel} は planner が書き換えてはいけない`);
    }
    return permit(tool, target.rel);
  }

  if (input.agent_type !== IMPLEMENTER) return null;
  if (READ_TOOLS.includes(tool) || REPORT_TOOLS.includes(tool)) return null;
  if (!MODIFY_TOOLS.includes(tool)) return deny(`implementer は ${tool} を使えない`);

  const target = writeTarget(input, projectDir, base);
  if (target.error) return deny(target.error);
  const { rel } = target;

  let task;
  let tasks;
  try {
    ({ task, tasks } = loadContext(projectDir));
  } catch (e) {
    return deny(`実行中のタスク契約を読めない: ${e.message}`);
  }

  const lower = rel.toLowerCase();
  if (
    isProtectedPath(lower) ||
    matchesAny(lower, CONTROL_PATHS) ||
    HIDING_FILES.includes(lower.split("/").at(-1))
  ) {
    return deny(`${rel} は implementer が書き換えてはいけない`);
  }
  const owner = testOwner(rel, tasks);
  if (owner) {
    return deny(`${rel} は ${owner.id} の受け入れテスト。テストが誤っていると思うなら、編集せずに止まって理由を報告する`);
  }
  if (!isAllowed(rel, task)) {
    return deny(
      `${rel} は ${task.id} の許可リスト外。許可: ${task.allow.join(", ")}` +
        (task.deny?.length ? ` / 除外: ${task.deny.join(", ")}` : "") +
        "。必要なら編集せずに止まって理由を報告する",
    );
  }

  let ignored;
  try {
    ignored = isIgnored(projectDir, rel);
  } catch (e) {
    return deny(`${rel} が git に無視されるかを確かめられない: ${e.message}`);
  }
  if (ignored) return deny(`${rel} は git に無視されるパス。検査で変更を追えないため書き換えられない`);
  return permit(tool, rel);
}

/**
 * フックの入力と環境からプロジェクトディレクトリを決めて判定する（guard.mjs の本体）。
 * プロジェクトディレクトリを決められないときは、tasque-loop のエージェントか実行中か、削除ツールなら拒否する。
 */
export function decideHook(input, { envProjectDir, pluginRoot, resolveDir = resolveProjectDir, ...rest } = {}) {
  let projectDir;
  try {
    projectDir = resolveDir({ cwd: input.cwd, envProjectDir });
  } catch (e) {
    const isTasqueAgent = typeof input.agent_type === "string" && input.agent_type.startsWith(AGENT_PREFIX);
    const fallback = envProjectDir ?? input.cwd;
    if (isTasqueAgent || input.tool_name === DELETE_TOOL || (fallback && defaultRunActive(fallback))) {
      return deny(`プロジェクトディレクトリを決められない: ${e.message}`);
    }
    return null;
  }
  return decide(input, { projectDir, pluginRoot, ...rest });
}

/**
 * Edit・Write・削除ツールの対象をプロジェクトルートからの POSIX 相対パスにする。
 * 削除ツールの対象は絶対パスに限る（MCP サーバーはサブエージェントと別の cwd で動くため）。
 * 短い名前（8.3 形式）・代替データストリーム・末尾のドットや空白など、
 * Windows で別名として同じファイルを指しうる書き方は { error } で拒否する。
 */
function writeTarget(input, projectDir, base) {
  const tool = input.tool_name;
  const raw = input.tool_input?.file_path;
  if (typeof raw !== "string" || raw === "") return { error: `${tool} の対象パスが読めない` };
  if (tool === DELETE_TOOL && !isFullyAbsolute(raw)) return { error: `${raw} は絶対パスではない。削除は絶対パスで指定する` };

  // POSIX ではバックスラッシュは区切りではなくファイル名の一部になり、照合したパスと実際に書くファイルがずれる
  if (process.platform !== "win32" && raw.includes("\\")) {
    return { error: `${raw} はバックスラッシュを含む。区切りは / を使い、ファイル名にもバックスラッシュを使わない` };
  }

  // realpath は代替データストリームや末尾のドットを黙って落とすことがあるため、正規化の前の入力も確かめる
  const suspicious = suspiciousComponent(rawComponents(raw), { shortName: false });
  if (suspicious) return { error: aliasError(raw, suspicious) };

  const rel = toProjectRelative(projectDir, raw, base);
  if (rel === null) return { error: `${raw} はプロジェクトの外` };

  // 実在する部分は正式な名前に置き換わっているので、残るのは実在しない部分の書き方
  const suspiciousRel = suspiciousComponent(rel.split("/"), { shortName: true });
  if (suspiciousRel) return { error: aliasError(raw, suspiciousRel) };
  return { rel };
}

function aliasError(raw, component) {
  return `${raw} の「${component}」は別名で別のファイルを指しうる書き方。正式な名前で指定する`;
}

/**
 * 入力されたパス文字列の要素。先頭のドライブ指定（C:）は要素として扱わない。
 */
function rawComponents(raw) {
  const parts = raw.split(/[\\/]+/);
  if (/^[A-Za-z]:/.test(parts[0])) parts[0] = parts[0].slice(2);
  return parts;
}

/**
 * 別名になりうる要素を返す。なければ null。
 * - ":" を含む（NTFS の代替データストリーム）
 * - 末尾がドットか空白（Windows が黙って取り除く）
 * - shortName なら "~数字" を含む（8.3 形式の短い名前）
 */
function suspiciousComponent(parts, { shortName }) {
  return (
    parts.find(
      (c) =>
        c !== "" &&
        c !== "." &&
        c !== ".." &&
        (c.includes(":") || /[.\s]$/.test(c) || (shortName && /~\d/.test(c))),
    ) ?? null
  );
}

/**
 * ツール入力に含まれるパスのうち、プロジェクト外を指すものを返す。
 * セッションのスクラッチパッドは読み書きとも、プラグイン自身のディレクトリは読み取りだけ許す。
 * Bash のコマンド文字列は解析しない（サンドボックスで守る）。
 */
function outsidePaths(input, projectDir, pluginRoot, base) {
  const ti = input.tool_input ?? {};
  const isPath = (p) => typeof p === "string" && p !== "";
  // Glob の相対パターンは、path があればそこから解決される
  const globBase = isPath(ti.path) ? absolutize(ti.path, base) : base;
  const candidates = {
    Read: [[ti.file_path, base]],
    Write: [[ti.file_path, base]],
    Edit: [[ti.file_path, base]],
    [DELETE_TOOL]: [[ti.file_path, base]],
    Glob: [
      [ti.path, base],
      [ti.pattern, globBase],
    ],
    Grep: [[ti.path, base]],
  }[input.tool_name];
  if (!candidates) return [];

  const readOnly = READ_TOOLS.includes(input.tool_name);
  const allowedRoots = [input.scratchpad_dir, readOnly ? pluginRoot : undefined].filter(Boolean);
  return candidates
    .filter(([p]) => isPath(p))
    .filter(([p, from]) => !isInside(projectDir, p, { allowRoot: true, base: from }))
    .filter(([p, from]) => !allowedRoots.some((root) => isInside(root, p, { allowRoot: true, base: from })))
    .map(([p]) => p);
}

/**
 * ツールに渡されたパスをプロジェクトルートからの POSIX 相対パスにする。外を指す場合とルート自身は null。
 * 相対パスは base（既定はプロジェクトルート）から解決し、実在する部分は正式な名前に揃える。
 */
export function toProjectRelative(projectDir, p, base = projectDir) {
  const rel = relative(canonicalize(resolve(projectDir)), canonicalize(absolutize(p, base)));
  if (rel === "" || isAbsolute(rel) || rel.split(sep)[0] === "..") return null;
  return sep === "\\" ? rel.replaceAll("\\", "/") : rel;
}

function isInside(root, p, { allowRoot = false, base = root } = {}) {
  const rel = relative(canonicalize(resolve(root)), canonicalize(absolutize(p, base)));
  if (rel === "") return allowRoot;
  return !isAbsolute(rel) && rel.split(/[\\/]/)[0] !== "..";
}

/**
 * ツールと同じ解釈で絶対パスにする。先頭の ~ はホームディレクトリ、相対パスは base から解決する。
 */
function absolutize(p, base) {
  if (p === "~" || /^~[\\/]/.test(p)) return resolve(homedir(), p.slice(2));
  return resolve(base, p);
}

/**
 * 実在する最も深い祖先を realpath で正式な名前（長い名前・実際の大文字小文字）にし、残りを付け直す。
 */
function canonicalize(abs) {
  const tail = [];
  let cur = abs;
  for (;;) {
    try {
      return join(realpathSync.native(cur), ...tail.reverse());
    } catch {
      const parent = dirname(cur);
      if (parent === cur) return abs;
      tail.push(basename(cur));
      cur = parent;
    }
  }
}

/**
 * .tasque/current が指す承認済みタスクと、同じランの全タスク（テストの保護に使う）を返す。
 */
export function defaultLoadContext(projectDir) {
  const { run, task } = JSON.parse(readFileSync(join(projectDir, ".tasque", "current"), "utf8"));
  const { tasks } = loadApproved(projectDir, run);
  const found = tasks.find((t) => t.id === task);
  if (!found) throw new Error(`run ${run} にタスク ${task} はない`);
  return { task: found, tasks };
}

function defaultRunActive(projectDir) {
  return existsSync(join(projectDir, ".tasque", "current"));
}

/** git check-ignore でパスが無視されるかを返す。git が使えない・エラーのときは例外。 */
export const defaultIsIgnored = isIgnored;

/**
 * 判定を通った操作の結果。Edit・Write は通常の権限フローに任せ（null）、削除ツールは許可する。
 */
function permit(tool, rel) {
  if (tool !== DELETE_TOOL) return null;
  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "allow",
      permissionDecisionReason: `[tasque-loop] ${rel} は消してよい（未追跡のファイルに限る）`,
    },
  };
}

function deny(reason) {
  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: `[tasque-loop] ${reason}`,
    },
  };
}
