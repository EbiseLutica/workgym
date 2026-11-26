// 使い方: node escalate.mjs --run <run> --task <id> (--q <質問> | --q-file <パス>) [--context <補足> | --context-file <パス>]
// implementer が実行中に見つけた不確実な点を escalations.json に追記する。承認済みの契約は変更しない。
// LLM が書いた文章はシェルに通すと展開されうるので、ファイルで渡せる（--q-file / --context-file。UTF-8、末尾の改行は除く）。
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { cliProjectDir } from "./lib/git.mjs";
import { appendEscalation } from "./lib/run.mjs";

const usage =
  "usage: escalate.mjs --run <run> --task <id> (--q <質問> | --q-file <パス>) [--context <補足> | --context-file <パス>]";

const { values } = parseArgs({
  options: {
    run: { type: "string" },
    task: { type: "string" },
    q: { type: "string" },
    "q-file": { type: "string" },
    context: { type: "string" },
    "context-file": { type: "string" },
  },
});

const both = (a, b) => values[a] !== undefined && values[b] !== undefined;
if (!values.run || !values.task || both("q", "q-file") || both("context", "context-file")) {
  console.error(usage);
  process.exit(2);
}

try {
  const fromFile = (file) => readFileSync(file, "utf8").replace(/\r?\n$/, "");
  const q = values["q-file"] !== undefined ? fromFile(values["q-file"]) : values.q;
  const context = values["context-file"] !== undefined ? fromFile(values["context-file"]) : (values.context ?? "");
  if (q === undefined) {
    console.error(usage);
    process.exit(2);
  }
  const entry = appendEscalation(cliProjectDir(), values.run, { task: values.task, q, context });
  console.log(JSON.stringify(entry));
} catch (e) {
  console.error(e.message);
  process.exit(1);
}
