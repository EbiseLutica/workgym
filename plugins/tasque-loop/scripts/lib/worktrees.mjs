import { spawnSync } from "node:child_process";
import { cpSync, existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { git, repoLayout } from "./git.mjs";

/**
 * run スキルが切るワークツリーのブランチ名の接頭辞。EnterWorktree は名前 <name> のワークツリーに
 * ブランチ worktree-<name> を作り、スキルは名前を tasque-<slug> にする。
 */
export const BRANCH_PREFIX = "worktree-tasque-";

/**
 * プロジェクトと同じリポジトリにある tasque のワークツリーを列挙する。PR の状態は含めない。
 * - path: ワークツリーのルート
 * - project: ワークツリー内のプロジェクトディレクトリ（モノレポでは同じオフセットを当てる）
 * - runs: .tasque/runs にあるランの ID
 * - current: .tasque/current の中身（実行中のタスク）。なければ null
 * - dirty: コミットされていない変更（無視されるファイルを除く）があるか
 * - locked: git worktree lock の理由（理由なしのロックは空文字列）。ロックされていなければ null
 */
export function listTasqueWorktrees(projectDir) {
  const { top, prefix } = repoLayout(projectDir);
  const here = resolve(top);
  return parseWorktreeList(git(projectDir, ["worktree", "list", "--porcelain", "-z"]))
    .filter((w) => w.branch?.startsWith(BRANCH_PREFIX) && resolve(w.path) !== here)
    .map((w) => {
      const project = prefix ? join(w.path, prefix) : w.path;
      const tasque = join(project, ".tasque");
      const runsDir = join(tasque, "runs");
      return {
        name: basename(w.path),
        path: w.path,
        branch: w.branch,
        project,
        runs: existsSync(runsDir) ? readdirSync(runsDir).sort() : [],
        current: readCurrent(join(tasque, "current")),
        dirty: existsSync(w.path) && git(w.path, ["status", "--porcelain", "-z"]) !== "",
        locked: w.locked,
      };
    });
}

/**
 * git worktree list --porcelain -z の出力を { path, branch, locked } の配列にする。
 * branch は refs/heads/ を除いた名前（detached なら null）。locked はロックの理由（理由なしなら空文字列、ロックされていなければ null）。
 */
export function parseWorktreeList(out) {
  const entries = [];
  let cur = null;
  for (const field of out.split("\0")) {
    if (field === "") {
      if (cur) entries.push(cur);
      cur = null;
    } else if (field.startsWith("worktree ")) {
      cur = { path: field.slice("worktree ".length), branch: null, locked: null };
    } else if (cur && field.startsWith("branch ")) {
      cur.branch = field.slice("branch ".length).replace(/^refs\/heads\//, "");
    } else if (cur && (field === "locked" || field.startsWith("locked "))) {
      cur.locked = field.slice("locked".length).trim();
    }
  }
  if (cur) entries.push(cur);
  return entries;
}

/**
 * gh でブランチの PR の状態を調べる。{ state: "OPEN" | "MERGED" | "CLOSED", url } か、PR がなければ null。
 * gh が使えない・失敗したときは例外。
 */
export function ghPrState(branch, cwd) {
  const r = spawnSync("gh", ["pr", "list", "--head", branch, "--state", "all", "--json", "state,url", "--limit", "1"], {
    cwd,
    encoding: "utf8",
  });
  if (r.error) throw r.error;
  if (r.status !== 0) throw new Error(r.stderr.trim() || `gh が ${r.status} で終了した`);
  const [pr] = JSON.parse(r.stdout);
  return pr ? { state: pr.state, url: pr.url } : null;
}

/**
 * 終わったランのワークツリーを片付ける。.tasque をプロジェクトの .tasque/archive/<ワークツリー名>/ に退避してから、
 * ワークツリーとブランチを消す。次のときは何もせずに例外を投げる。
 * - tasque のワークツリーとして見つからない
 * - コミットされていない変更がある
 * - ワークツリーがロックされている（Claude Code のセッションが使用中など）
 * ワークツリーの削除に失敗したら、退避したコピーを消してから例外を投げる（やり直せるように）。
 * - PR がマージかクローズされていない（abandon のときは PR の状態を問わない）
 * - 退避先がすでにある
 * abandon は、PR を作らずに捨てると人間が決めたときだけ使う。
 */
export function cleanWorktree(projectDir, name, { prState = ghPrState, abandon = false } = {}) {
  const wt = listTasqueWorktrees(projectDir).find((w) => w.name === name);
  if (!wt) throw new Error(`tasque のワークツリー ${name} が見つからない`);
  if (wt.dirty) throw new Error(`${name} にコミットされていない変更がある`);
  if (wt.locked !== null) {
    throw new Error(
      `${name} はロックされている（${wt.locked || "理由なし"}）。使っているセッションがないことを確かめてから git worktree unlock で外す`,
    );
  }

  if (!abandon) {
    let pr;
    try {
      pr = prState(wt.branch, projectDir);
    } catch (e) {
      throw new Error(`${wt.branch} の PR の状態を確かめられない: ${e.message}`);
    }
    if (!pr) throw new Error(`${wt.branch} には PR がない。PR を作らずに捨てるなら abandon を指定する`);
    if (pr.state !== "MERGED" && pr.state !== "CLOSED") {
      throw new Error(`${wt.branch} の PR はまだ ${pr.state}（${pr.url}）`);
    }
  }

  const archive = join(projectDir, ".tasque", "archive", name);
  if (existsSync(archive)) throw new Error(`退避先 ${archive} がすでにある`);
  const source = join(wt.project, ".tasque");
  const archived = existsSync(source);
  if (archived) cpSync(source, archive, { recursive: true });

  try {
    git(projectDir, ["worktree", "remove", wt.path]);
  } catch (e) {
    if (archived) rmSync(archive, { recursive: true, force: true });
    throw e;
  }
  git(projectDir, ["branch", "-D", wt.branch]);
  return { ...wt, archive: archived ? archive : null };
}

function readCurrent(file) {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}
