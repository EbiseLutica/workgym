// 使い方: node answer.mjs --run <run> --task <id> --answer-file <パス>
// 人間の回答を、escalations.json のそのタスクの未回答のうち最後の項目に記録する。回答済みの項目は変えない。
// 回答は LLM がシェルに通すと展開されうるので、ファイルで渡す（UTF-8、末尾の改行1つは除く）。
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { cliProjectDir } from "./lib/git.mjs";
import { recordAnswer } from "./lib/run.mjs";

const usage = "usage: answer.mjs --run <run> --task <id> --answer-file <パス>";

const { values } = parseArgs({
  options: {
    run: { type: "string" },
    task: { type: "string" },
    "answer-file": { type: "string" },
  },
});

if (!values.run || !values.task || !values["answer-file"]) {
  console.error(usage);
  process.exit(2);
}

try {
  const answer = readFileSync(values["answer-file"], "utf8").replace(/\r?\n$/, "");
  const entry = recordAnswer(cliProjectDir(), values.run, { task: values.task, answer });
  console.log(JSON.stringify(entry));
} catch (e) {
  console.error(e.message);
  process.exit(1);
}
