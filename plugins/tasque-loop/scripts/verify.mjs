// 使い方:
//   node verify.mjs --phase baseline                      worktree 作成直後・planner より前（基点と全体テストの結果を記録）
//   node verify.mjs --phase red                           承認前（下書きの受け入れコマンドが実装前に落ちるか）
//   node verify.mjs --run <run> --task <id> --phase pre   実装前（作業ツリーがクリーンでテストがコミット済みか。基点を記録）
//   node verify.mjs --run <run> --task <id> --phase post  実装後（スコープ・テスト不変・diff 上限・受け入れ）
//   node verify.mjs --run <run> --phase pr                PR 前（スコープ・テストの改ざん・サイズ・全体テスト・全タスクの受け入れ）
// baseline は結果の JSON を標準出力と .tasque/baseline.json に出す。基点で全体テストが落ちれば exit 1（ランを始めない）。
// red は人間が読むテキストを標準出力に出し、結果の JSON を .tasque/plan.draft.red.json に保存する。exit 0。
// それ以外は結果の JSON を標準出力に出し、.tasque/runs/<run>/tasks/ にも保存する。すべて通れば exit 0、どれか落ちれば exit 1。
// warning は標準エラーにも出す。
import { parseArgs } from "node:util";
import { cliProjectDir } from "./lib/git.mjs";
import { formatRed, verifyBaseline, verifyPost, verifyPr, verifyPre, verifyRed } from "./lib/verify.mjs";

const { values } = parseArgs({
  options: { run: { type: "string" }, task: { type: "string" }, phase: { type: "string" } },
});

const usage = "usage: verify.mjs --phase baseline|red | --run <run> [--task <id>] --phase pre|post|pr";
const needsRun = ["pre", "post", "pr"].includes(values.phase);
const needsTask = values.phase === "pre" || values.phase === "post";
if (
  !["baseline", "red", "pre", "post", "pr"].includes(values.phase) ||
  (needsRun && !values.run) ||
  (needsTask && !values.task)
) {
  console.error(usage);
  process.exit(2);
}

try {
  const projectDir = cliProjectDir();
  if (values.phase === "red") {
    console.log(formatRed(await verifyRed(projectDir)));
    process.exit(0);
  }
  const result =
    values.phase === "baseline"
      ? await verifyBaseline(projectDir)
      : values.phase === "pre"
        ? await verifyPre(projectDir, values.run, values.task)
        : values.phase === "post"
          ? await verifyPost(projectDir, values.run, values.task)
          : await verifyPr(projectDir, values.run);
  for (const w of result.warnings ?? []) console.error(`⚠ ${w}`);
  console.log(JSON.stringify(result, null, 2));
  process.exit(result.ok ? 0 : 1);
} catch (e) {
  console.error(e.message);
  process.exit(2);
}
