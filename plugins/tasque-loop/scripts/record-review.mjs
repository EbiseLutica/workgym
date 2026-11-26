// 使い方: node record-review.mjs --run <run> --task <id> --round <1|2> --findings-file <パス>
// タスクのレビュー結果を、ランの tasks/<id>.review-<round>.json に1回分書く。指摘がなければ空配列を渡す。
// 指摘は UTF-8 の JSON 配列のファイルで渡す。形が不正、または同じラウンドの記録がすでにあれば何も書かない。
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { cliProjectDir } from "./lib/git.mjs";
import { REVIEW_ROUNDS, recordReview } from "./lib/review.mjs";

const usage = "usage: record-review.mjs --run <run> --task <id> --round <1|2> --findings-file <パス>";

const { values } = parseArgs({
  options: {
    run: { type: "string" },
    task: { type: "string" },
    round: { type: "string" },
    "findings-file": { type: "string" },
  },
});

if (!values.run || !values.task || !REVIEW_ROUNDS.map(String).includes(values.round) || !values["findings-file"]) {
  console.error(usage);
  process.exit(2);
}

const readFindings = (file) => {
  let text;
  try {
    text = readFileSync(file, "utf8");
  } catch (e) {
    throw new Error(`${file} が読めない: ${e.message}`);
  }
  try {
    return JSON.parse(text);
  } catch (e) {
    throw new Error(`${file} が JSON として読めない: ${e.message}`);
  }
};

try {
  const findings = readFindings(values["findings-file"]);
  const entry = recordReview(cliProjectDir(), values.run, { task: values.task, round: Number(values.round), findings });
  console.log(JSON.stringify(entry));
} catch (e) {
  console.error(e.message);
  process.exit(1);
}
