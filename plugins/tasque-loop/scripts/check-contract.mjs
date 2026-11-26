// 使い方: node check-contract.mjs <plan.json> [--stage draft|ready]
// 妥当なら exit 0、問題があればエラーを標準エラーに出して exit 1。
import { readFileSync } from "node:fs";
import { STAGES, validatePlan } from "./lib/contract.mjs";

const args = process.argv.slice(2);
const stageIdx = args.indexOf("--stage");
const stage = stageIdx >= 0 ? args.splice(stageIdx, 2)[1] : "draft";
const [file] = args;

if (!file || !STAGES.includes(stage)) {
  console.error("usage: check-contract.mjs <plan.json> [--stage draft|ready]");
  process.exit(2);
}

let plan;
try {
  plan = JSON.parse(readFileSync(file, "utf8"));
} catch (e) {
  console.error(`${file}: 読み込めない: ${e.message}`);
  process.exit(1);
}

const errors = validatePlan(plan, { stage });
if (errors.length > 0) {
  for (const e of errors) console.error(e);
  process.exit(1);
}
console.log(`${file}: ok (${stage})`);
