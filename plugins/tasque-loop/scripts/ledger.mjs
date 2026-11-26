// 使い方: node ledger.mjs --run <run> [--snapshot]
// 承認済みのランを台帳の <プロジェクト>/<run>/ に書き、台帳のリポジトリにそのランのパスだけをコミットする。
// --run は raw/（.tasque/runs/<run>/ の写し）と record.json（記録の集計）を書く。
// --snapshot は raw/ だけを今の内容にし、中身が変わっていなければコミットせずに exit 0。
// 台帳は TASQUE_LEDGER_DIR、なければ ~/.tasque/ledger。なければ作って git init する（remote は足さない）。
// 承認済みのランが読めない、台帳の場所が使えない、または record.json が台帳にコミット済みのときは、何も書かずに exit 1。
import { parseArgs } from "node:util";
import { cliProjectDir } from "./lib/git.mjs";
import { ledgerDir, writeRun } from "./lib/ledger.mjs";

const usage = "usage: ledger.mjs --run <run> [--snapshot]";

const { values } = parseArgs({
  options: {
    run: { type: "string" },
    snapshot: { type: "boolean" },
  },
});

if (!values.run) {
  console.error(usage);
  process.exit(2);
}

try {
  const { dir, committed } = writeRun(ledgerDir(), cliProjectDir(), values.run, { withRecord: !values.snapshot });
  if (!values.snapshot) console.log(`recorded: ${dir}`);
  else console.log(committed ? `snapshot: ${dir}` : `snapshot: 変化なし（コミットしない） ${dir}`);
} catch (e) {
  console.error(e.message);
  process.exit(1);
}
