// 使い方: node ledger.mjs --run <run>
// 承認済みのランの記録（post の試行、レビュー、PR のサイズ、人間の判断）を1件の JSON にまとめ、
// 台帳の <プロジェクト>/<run>.json に書いて、台帳のリポジトリにそのファイルだけをコミットする。
// 台帳は TASQUE_LEDGER_DIR、なければ ~/.tasque/ledger。なければ作って git init する（remote は足さない）。
// 承認済みのランが読めない、または台帳に同じランがすでにあるときは、何も書かずに exit 1。
import { parseArgs } from "node:util";
import { cliProjectDir } from "./lib/git.mjs";
import { buildRecord, commitRecord, ledgerDir } from "./lib/ledger.mjs";

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
  const record = buildRecord(cliProjectDir(), values.run);
  const file = commitRecord(ledgerDir(), record);
  console.log(`recorded: ${file}`);
} catch (e) {
  console.error(e.message);
  process.exit(1);
}
