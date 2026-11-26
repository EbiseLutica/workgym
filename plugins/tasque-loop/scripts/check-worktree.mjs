// 使い方:
//   node check-worktree.mjs   カレントディレクトリがリンクされたワークツリーの中で、.tasque/current がなく、未コミットの変更もないかを判定する
// 満たせば exit 0。満たさなければ理由を標準出力に出して exit 1。使い方の誤りや git のエラーは標準エラーに出して exit 2。
// 判定はカレントディレクトリで行い、CLAUDE_PROJECT_DIR は見ない。ワークツリーの作成・削除・移動はしない。
import { parseArgs } from "node:util";
import { checkWorktree } from "./lib/check-worktree.mjs";

const usage = "usage: check-worktree.mjs（引数はない）";
try {
  parseArgs({ options: {} });
} catch {
  console.error(usage);
  process.exit(2);
}

let reasons;
try {
  reasons = checkWorktree(process.cwd());
} catch (e) {
  console.error(e.message);
  process.exit(2);
}

for (const r of reasons) console.log(`✗ ${r}`);
process.exit(reasons.length === 0 ? 0 : 1);
