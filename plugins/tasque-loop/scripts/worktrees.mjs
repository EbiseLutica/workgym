// 使い方:
//   node worktrees.mjs                          tasque のワークツリーを PR の状態つきで一覧する（JSON）
//   node worktrees.mjs --clean <名前>            PR がマージかクローズ済みのワークツリーを、.tasque を退避してから消す
//   node worktrees.mjs --clean <名前> --abandon  PR を作らずに捨てる（人間がそう決めたときだけ）
// ワークツリーの中ではなく、元のチェックアウトのプロジェクトディレクトリで実行する。
// 退避先は <プロジェクト>/.tasque/archive/<名前>/。gh が使えないときの PR の状態は "unknown"。
import { parseArgs } from "node:util";
import { cliProjectDir } from "./lib/git.mjs";
import { cleanWorktree, ghPrState, listTasqueWorktrees } from "./lib/worktrees.mjs";

const { values } = parseArgs({
  options: { clean: { type: "string" }, abandon: { type: "boolean", default: false } },
});

if (values.abandon && !values.clean) {
  console.error("usage: worktrees.mjs [--clean <名前> [--abandon]]");
  process.exit(2);
}

try {
  const projectDir = cliProjectDir();
  if (values.clean) {
    console.log(JSON.stringify(cleanWorktree(projectDir, values.clean, { abandon: values.abandon }), null, 2));
  } else {
    const list = listTasqueWorktrees(projectDir).map((w) => {
      let pr;
      try {
        pr = ghPrState(w.branch, projectDir);
      } catch {
        pr = "unknown";
      }
      return { ...w, pr };
    });
    console.log(JSON.stringify(list, null, 2));
  }
} catch (e) {
  console.error(e.message);
  process.exit(1);
}
