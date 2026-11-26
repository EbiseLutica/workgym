// PreToolUse フック。tasque-loop 実行中のプロジェクト外アクセスと、implementer の許可リスト外への書き込みを止める。
// プロジェクトディレクトリは入力の cwd（worktree の中ならその worktree）と CLAUDE_PROJECT_DIR から決める。
// 想定外の例外は非ゼロ終了になり、hooks.json の onFailure: block で拒否に倒れる。
import { decideHook } from "./lib/guard.mjs";

let raw = "";
process.stdin.setEncoding("utf8");
for await (const chunk of process.stdin) raw += chunk;

const input = JSON.parse(raw);
const result = decideHook(input, {
  envProjectDir: process.env.CLAUDE_PROJECT_DIR,
  pluginRoot: process.env.CLAUDE_PLUGIN_ROOT,
});
if (result) process.stdout.write(JSON.stringify(result));
