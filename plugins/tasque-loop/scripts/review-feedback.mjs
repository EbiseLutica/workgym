// 使い方: node review-feedback.mjs --verdict changes_requested|approved --text-file <パス>
// 人間が契約の下書きに返したレビュー結果を .tasque/plan.draft.reviews.json に1回分追記する。承認（approve.mjs）のときはランの reviews.json に移る。
// 人間の言葉は LLM がシェルに通すと展開されうるので、ファイルで渡す（UTF-8、末尾の改行1つは除く）。
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { cliProjectDir } from "./lib/git.mjs";
import { appendReview, REVIEW_VERDICTS } from "./lib/run.mjs";

const usage = "usage: review-feedback.mjs --verdict changes_requested|approved --text-file <パス>";

const { values } = parseArgs({
  options: {
    verdict: { type: "string" },
    "text-file": { type: "string" },
  },
});

if (!REVIEW_VERDICTS.includes(values.verdict) || values["text-file"] === undefined) {
  console.error(usage);
  process.exit(2);
}

try {
  const text = readFileSync(values["text-file"], "utf8").replace(/\r?\n$/, "");
  const entry = appendReview(cliProjectDir(), { verdict: values.verdict, text });
  console.log(JSON.stringify(entry));
} catch (e) {
  console.error(e.message);
  process.exit(1);
}
