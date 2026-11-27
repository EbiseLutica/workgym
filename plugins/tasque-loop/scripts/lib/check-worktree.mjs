import { existsSync } from "node:fs";
import { join } from "node:path";
import { git } from "./git.mjs";
import { isSameDir } from "./paths.mjs";

/**
 * cwd が後片付けしてよいワークツリーの中か（リンクされたワークツリーで、.tasque/current がなく、未コミットの変更がないか）を調べる。
 * 満たさない理由の配列を返す。空なら満たす。git のエラー（リポジトリの外など）は例外。
 * - git-dir と git-common-dir が違えばリンクされたワークツリー。相対パスでは比べず、実在パスに直してから比べる
 * - .tasque/current は cwd の直下を見る
 * - 未コミットの変更はワークツリー全体で見る（追跡中の変更・ステージ済み・追跡されていない新しいファイル。無視されるファイルは除く）
 */
export function checkWorktree(cwd) {
  const [gitDir, commonDir] = git(cwd, ["rev-parse", "--path-format=absolute", "--git-dir", "--git-common-dir"])
    .split(/\r?\n/);
  const reasons = [];
  if (isSameDir(gitDir, commonDir)) {
    reasons.push("リンクされたワークツリーの中ではない（元のチェックアウトで実行している）");
  }
  if (existsSync(join(cwd, ".tasque", "current"))) {
    reasons.push(".tasque/current が残っている（実行中のタスクがある）");
  }
  if (git(cwd, ["status", "--porcelain", "-z"]) !== "") {
    reasons.push("コミットされていない変更がある");
  }
  return reasons;
}
