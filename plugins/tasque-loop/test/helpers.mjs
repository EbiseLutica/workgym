import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { verifyBaseline } from "../scripts/lib/verify.mjs";

export const examplePlan = () =>
  JSON.parse(readFileSync(new URL("../examples/plan.example.json", import.meta.url), "utf8"));

/**
 * 例の契約の uncertain をすべて決定済みにしたもの。
 */
export const decidedPlan = () => {
  const plan = examplePlan();
  plan.tasks[0].uncertain[0].decision = "既定値で動く";
  return plan;
};

/**
 * 練習用の git リポジトリを作る。main に初期コミットをして作業ブランチ work に切り替えた状態にする。
 * sub を指定すると、そのサブディレクトリをプロジェクト（tasque.config.json と .tasque の場所）とする。
 * files はプロジェクトからの相対パスで初期コミットに含める。
 */
export function makeRepo({ files = {}, sub = "", branch = "work" } = {}) {
  const root = mkdtempSync(join(tmpdir(), "tasque-repo-"));
  const dir = sub ? join(root, sub) : root;
  const git = (...args) => execFileSync("git", args, { cwd: dir, encoding: "utf8" });
  const put = (file, text) => {
    mkdirSync(join(dir, file, ".."), { recursive: true });
    writeFileSync(join(dir, file), text);
  };
  const putRoot = (file, text) => {
    mkdirSync(join(root, file, ".."), { recursive: true });
    writeFileSync(join(root, file), text);
  };

  mkdirSync(dir, { recursive: true });
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: root });
  git("config", "user.email", "test@example.invalid");
  git("config", "user.name", "test");
  git("config", "core.autocrlf", "false");
  putRoot(".gitignore", ".tasque/\n");
  putRoot("README.md", "practice\n");
  for (const [file, text] of Object.entries(files)) put(file, text);
  git("add", "-A", ":/");
  git("commit", "-q", "-m", "init");
  if (branch) git("switch", "-q", "-c", branch);
  return { root, dir, git, put, putRoot };
}

/**
 * 承認できる状態のプロジェクト（例の契約のテストファイルがあり、基点を記録済み）を作る。
 */
export async function approvableProject() {
  const repo = makeRepo();
  await verifyBaseline(repo.dir);
  for (const t of examplePlan().tasks.flatMap((task) => task.tests)) repo.put(t, `// ${t}\n`);
  return repo;
}
