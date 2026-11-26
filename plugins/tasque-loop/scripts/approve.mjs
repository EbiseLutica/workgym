// 使い方: node approve.mjs <plan.json>
// uncertain がすべて決定済みの契約を承認済みとして凍結する。プロジェクトルートは cwd と CLAUDE_PROJECT_DIR から決める（worktree の中ならその worktree）。
// 下書きの検査（SubagentStop）と Red 確認を通り、その後に契約（decision を除く）もテストも変わっていないことを要求する。
import { readFileSync } from "node:fs";
import { cliProjectDir } from "./lib/git.mjs";
import { approveChecked, ContractError } from "./lib/run.mjs";

const [file] = process.argv.slice(2);
if (!file) {
  console.error("usage: approve.mjs <plan.json>");
  process.exit(2);
}

try {
  const plan = JSON.parse(readFileSync(file, "utf8"));
  const { path, sha256 } = approveChecked(cliProjectDir(), plan);
  console.log(`approved: ${path} (sha256 ${sha256})`);
} catch (e) {
  console.error(e instanceof ContractError ? e.errors.join("\n") : e.message);
  process.exit(1);
}
