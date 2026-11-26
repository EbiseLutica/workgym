// SubagentStop フック。planner が書いた契約の下書きを検査し、不正なら差し戻す。
// SubagentStop では onFailure: block が効かないため、このスクリプトが落ちると planner はそのまま終了する。
// その場合は検査結果ファイルが更新されないので、メインエージェントは ok を確認できない。
// プロジェクトディレクトリは入力の cwd（worktree の中ならその worktree）と CLAUDE_PROJECT_DIR から決める。
import { resolveProjectDir } from "./lib/git.mjs";
import { decidePlannerStop } from "./lib/plan-check.mjs";

let raw = "";
process.stdin.setEncoding("utf8");
for await (const chunk of process.stdin) raw += chunk;

const input = JSON.parse(raw);
const envProjectDir = process.env.CLAUDE_PROJECT_DIR;
let projectDir;
try {
  projectDir = resolveProjectDir({ cwd: input.cwd, envProjectDir });
} catch {
  projectDir = envProjectDir ?? input.cwd;
}
const result = decidePlannerStop(input, { projectDir });
if (result) process.stdout.write(JSON.stringify(result));
