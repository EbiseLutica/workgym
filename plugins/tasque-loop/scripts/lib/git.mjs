import { execFileSync, spawnSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { posix } from "node:path";

/**
 * git を実行して標準出力を返す。失敗したら例外。
 */
export function git(cwd, args) {
  return execFileSync("git", args, { cwd, encoding: "utf8", maxBuffer: 1 << 30 });
}

/**
 * 現在のブランチ名。HEAD が detached なら null。
 */
export function currentBranch(cwd) {
  const r = spawnSync("git", ["symbolic-ref", "--short", "-q", "HEAD"], { cwd, encoding: "utf8" });
  if (r.status === 0) return r.stdout.trim();
  if (r.status === 1) return null;
  throw new Error(r.error?.message ?? (r.stderr.trim() || `git symbolic-ref が ${r.status} で終了した`));
}

export function headCommit(cwd) {
  return git(cwd, ["rev-parse", "HEAD"]).trim();
}

/**
 * git check-ignore でパスが無視されるかを返す。git が使えない・エラーのときは例外。
 */
export function isIgnored(cwd, rel) {
  const r = spawnSync("git", ["check-ignore", "-q", "--", rel], { cwd, encoding: "utf8" });
  if (r.status === 0) return true;
  if (r.status === 1) return false;
  throw new Error(r.error?.message ?? (r.stderr.trim() || `git check-ignore が ${r.status} で終了した`));
}

/**
 * cwd からの相対パス rel が、その名前のまま（大文字小文字も含めて）インデックスに載っているか。git のエラーは例外。
 */
export function isTrackedAs(cwd, rel) {
  const r = spawnSync("git", ["--literal-pathspecs", "ls-files", "-z", "--", rel], { cwd, encoding: "utf8" });
  if (r.error || r.status !== 0) {
    throw new Error(r.error?.message ?? (r.stderr.trim() || `git ls-files が ${r.status} で終了した`));
  }
  return r.stdout === `${rel}\0`;
}

/**
 * dir 直下のファイル name が、大文字小文字と Unicode の正規化の違いを無視してインデックスに載っているか。
 * 拒否する側に倒して照合する（大文字小文字を区別しないファイルシステムでは、別の書き方でも同じファイルを指すため）。
 * git のエラー（リポジトリの外など）は例外。
 */
export function isTrackedLoosely(dir, name) {
  const r = spawnSync("git", ["ls-files", "-z"], { cwd: dir, encoding: "utf8", maxBuffer: 1 << 30 });
  if (r.error || r.status !== 0) {
    throw new Error(r.error?.message ?? (r.stderr.trim() || `git ls-files が ${r.status} で終了した`));
  }
  const fold = (s) => s.normalize("NFC").toLowerCase();
  const target = fold(name);
  return r.stdout.split("\0").some((f) => f !== "" && !f.includes("/") && fold(f) === target);
}

/**
 * プロジェクト（tasque.config.json と .tasque のあるディレクトリ）とリポジトリの位置関係。
 * git の出力はリポジトリルートからのパスで受け取り、ここでプロジェクトからの相対パスに直す。
 * - top: リポジトリのルート（git コマンドはここで実行する）
 * - prefix: ルートからプロジェクトまでのパス（末尾 /、ルートと同じなら空文字列）
 * - toRel: リポジトリ相対パス → プロジェクト相対パス。プロジェクト外は ../ で始まる
 * - toRepo: プロジェクト相対パス → リポジトリ相対パス
 */
export function repoLayout(projectDir) {
  const top = git(projectDir, ["rev-parse", "--show-toplevel"]).trim();
  const prefix = git(projectDir, ["rev-parse", "--show-prefix"]).trim();
  const base = prefix.replace(/\/$/, "") || ".";
  return {
    top,
    prefix,
    toRel: (repoPath) => (prefix === "" ? repoPath : posix.relative(base, repoPath)),
    toRepo: (rel) => (prefix === "" ? rel : posix.join(base, rel)),
  };
}

/**
 * フックや CLI が対象にするプロジェクトディレクトリを決める。
 * Claude Code は worktree に入っても CLAUDE_PROJECT_DIR を元のリポジトリのまま渡すため、作業場所（cwd）の側の
 * リポジトリを優先する。CLAUDE_PROJECT_DIR がリポジトリのサブディレクトリなら、そのオフセットを cwd 側のルートにも適用する。
 * - envProjectDir がなければ cwd
 * - cwd か envProjectDir が git リポジトリの中でなければ envProjectDir ?? cwd
 * - cwd が envProjectDir と別のリポジトリ（git の共通ディレクトリが違う）なら envProjectDir
 * git を起動できないなどの異常は例外（フックは拒否に倒す）。
 */
export function resolveProjectDir({ cwd, envProjectDir }) {
  if (!envProjectDir) return cwd;
  if (!cwd) return envProjectDir;
  const here = repoInfo(cwd);
  const env = repoInfo(envProjectDir);
  if (!here || !env) return envProjectDir;
  if (!sameDir(here.common, env.common)) return envProjectDir;
  return env.prefix === "" ? here.top : posix.join(here.top, env.prefix.replace(/\/$/, ""));
}

/**
 * CLI（verify・approve・escalate）のプロジェクトディレクトリ。プロセスの cwd と CLAUDE_PROJECT_DIR から決める。
 */
export function cliProjectDir() {
  return resolveProjectDir({ cwd: process.cwd(), envProjectDir: process.env.CLAUDE_PROJECT_DIR });
}

/**
 * dir を含むリポジトリのルート・dir までのプレフィックス・共通の git ディレクトリ。リポジトリの外なら null。
 */
function repoInfo(dir) {
  const r = spawnSync(
    "git",
    ["rev-parse", "--path-format=absolute", "--show-toplevel", "--git-common-dir", "--path-format=relative", "--show-prefix"],
    { cwd: dir, encoding: "utf8" },
  );
  if (r.error) throw r.error;
  if (r.status !== 0) return null;
  const [top, common, prefix = ""] = r.stdout.split(/\r?\n/);
  return { top, common, prefix };
}

function sameDir(a, b) {
  const norm = (p) => {
    const real = realpathSync.native(p);
    return process.platform === "win32" ? real.toLowerCase() : real;
  };
  return norm(a) === norm(b);
}

/**
 * プロジェクト相対パスがプロジェクトの外を指すか。
 */
export function isOutsideProject(rel) {
  return rel === ".." || rel.startsWith("../");
}
