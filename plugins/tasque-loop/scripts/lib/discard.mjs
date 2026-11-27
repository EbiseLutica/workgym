import { lstatSync, realpathSync, rmSync } from "node:fs";
import { basename, dirname, isAbsolute } from "node:path";
import { isTrackedLoosely } from "./git.mjs";

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
 * worktree の .git ファイル、git に問い合わせられない場所のファイルは消さずに DiscardError を投げる。
 * 大文字小文字を変えた名前や短い名前（8.3 形式）で追跡済みのファイルを指せないよう、正式な名前に直してから、
 * 大文字小文字と Unicode の正規化を無視して照合する。
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

  const real = realpathSync.native(path);
  const names = [...new Set([basename(path), basename(real)])];
  if (names.some((n) => n.toLowerCase() === ".git")) throw new DiscardError(`${path} は git の管理用のファイル。消せない`);

  let tracked;
  try {
    tracked = names.some((n) => isTrackedLoosely(dirname(real), n));
  } catch (e) {
    throw new DiscardError(`${path} が git の管理下かを確かめられない: ${e.message}`);
  }
  if (tracked) throw new DiscardError(`${path} は git の管理下にある。消せるのは自分が作った未追跡のファイルだけ`);

  rmSync(real);
  return `${path} を消した`;
}
