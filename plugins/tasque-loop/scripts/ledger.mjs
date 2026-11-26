// 使い方: node ledger.mjs --run <run>
// 承認済みのランを台帳の <プロジェクト>/<run>/ に書き、台帳のリポジトリにそのランのパスだけをコミットする。
// raw/ は .tasque/runs/<run>/ の写しで、呼ぶたびに今の内容に置き換える。record.json は raw/ から作る集計。
// 記録に変化がなければコミットせず、その旨を出して exit 0。
// 台帳は TASQUE_LEDGER_DIR、なければ ~/.tasque/ledger。なければ作って git init する（remote は足さない）。
// 承認済みのランが読めない、台帳の場所が使えない、または台帳へのコミットに失敗したときは exit 1。
import { parseArgs } from "node:util";
import { cliProjectDir } from "./lib/git.mjs";
import { ledgerDir, writeRun } from "./lib/ledger.mjs";

const usage = "usage: ledger.mjs --run <run>";

const { values } = parseArgs({
  options: {
    run: { type: "string" },
  },
});

if (!values.run) {
  console.error(usage);
  process.exit(2);
}

try {
  const { dir, committed } = writeRun(ledgerDir(), cliProjectDir(), values.run);
  console.log(committed ? `recorded: ${dir}` : `変化なし（コミットしない）: ${dir}`);
} catch (e) {
  console.error(e.message);
  process.exit(1);
}
