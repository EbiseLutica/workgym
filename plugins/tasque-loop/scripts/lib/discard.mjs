import { spawnSync } from "node:child_process";
import { lstatSync, rmSync } from "node:fs";
import { basename, dirname, isAbsolute } from "node:path";

/** planner・implementer が誤って作ったファイルを消すツール（プラグインの MCP サーバー fs の delete_file）。 */
export const DELETE_TOOL = "mcp__plugin_tasque-loop_fs__delete_file";

export class DiscardError extends Error {}

/**
 * ドライブやルートまで含む絶対パスか。MCP サーバーの cwd はセッションを始めた場所のままで、
 * サブエージェントの cwd とずれうるため、相対パスやドライブを省いたパスは受け付けない。
 */
export function isFullyAbsolute(p) {
  if (typeof p !== "string" || p === "") return false;
  if (process.platform === "win32") return /^[A-Za-z]:[\\/]/.test(p);
  return isAbsolute(p);
}

/**
 * git 未追跡の通常のファイルを1つ消す。追跡済み（ステージ済みを含む）のファイル、ディレクトリ、シンボリックリンク、
 * git に問い合わせられない場所のファイルは消さずに DiscardError を投げる。
 * どのパスを消してよいか（許可リスト・保護パス）は PreToolUse のガードが判定する。ここではガードが外れても
 * 追跡済みのファイルが失われないことだけを守る。
 */
export function discardFile(path) {
  if (!isFullyAbsolute(path)) throw new DiscardError(`${path} は絶対パスではない。絶対パスで指定する`);

  let stat;
  try {
    stat = lstatSync(path);
  } catch {
    throw new DiscardError(`${path} は存在しない`);
  }
  if (!stat.isFile()) throw new DiscardError(`${path} は通常のファイルではない。消せるのはファイルだけ`);

  const r = spawnSync("git", ["ls-files", "-z", "--", basename(path)], { cwd: dirname(path), encoding: "utf8" });
  if (r.error || r.status !== 0) {
    throw new DiscardError(`${path} が git の管理下かを確かめられない: ${r.error?.message ?? r.stderr.trim()}`);
  }
  if (r.stdout !== "") {
    throw new DiscardError(`${path} は git の管理下にある。消せるのは自分が作った未追跡のファイルだけ`);
  }

  rmSync(path);
  return `${path} を消した`;
}
