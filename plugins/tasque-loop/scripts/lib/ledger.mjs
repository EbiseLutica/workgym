import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { git } from "./git.mjs";
import { DISPOSITIONS, REVIEW_ROUNDS, SEVERITIES } from "./review.mjs";
import { loadApproval, runPaths, taskFile } from "./run.mjs";

/**
 * 台帳の場所。TASQUE_LEDGER_DIR があればそれ、なければ ~/.tasque/ledger。
 */
export function ledgerDir(env = process.env) {
  return env.TASQUE_LEDGER_DIR || join(homedir(), ".tasque", "ledger");
}

/**
 * プロジェクトの名前。元のリポジトリのルートのディレクトリ名（ワークツリーでは git の共通ディレクトリの親）に、
 * リポジトリのルートからプロジェクトまでのパスを / でつないだもの。モノレポの別プロジェクトと run の ID が重ならないようにする。
 */
export function projectName(projectDir) {
  const common = git(projectDir, ["rev-parse", "--path-format=absolute", "--git-common-dir"]).trim();
  const repo = basename(dirname(common));
  const prefix = git(projectDir, ["rev-parse", "--show-prefix"]).trim().replace(/\/$/, "");
  return prefix ? `${repo}/${prefix}` : repo;
}

/**
 * ランの記録を1件にまとめる。承認済みのランでなければ例外。
 * post の試行とレビューは tasks/ の記録から、PR のサイズは tasks/pr.json から、人間の判断は承認済みの契約と reviews.json・escalations.json から取る。
 * 記録がないものは、回数は 0、一覧は空、PR は null にする。
 */
export function buildRecord(projectDir, run, { now = new Date() } = {}) {
  const { plan } = loadApproval(projectDir, run);
  const paths = runPaths(projectDir, run);

  const tasks = plan.tasks.map((task) => {
    const history = readOptional(taskFile(projectDir, run, task.id, ".post-history.json")) ?? [];
    const rounds = REVIEW_ROUNDS.map((round) => readOptional(taskFile(projectDir, run, task.id, `.review-${round}.json`)))
      .filter((r) => r !== null)
      .map((r) => r.findings);
    const all = rounds.flat();
    return {
      id: task.id,
      title: task.title,
      post: { attempts: history.length, failed: history.map((h) => h.failed) },
      scope_violations: [...new Set(history.flatMap((h) => h.scope_outside))],
      review: {
        rounds: rounds.length,
        by_severity: countBy(all, "severity", SEVERITIES),
        by_disposition: countBy(all, "disposition", DISPOSITIONS),
        late: rounds[1]?.length ?? 0,
      },
    };
  });

  const pr = readOptional(join(paths.dir, "tasks", "pr.json"));
  const reviews = readOptional(paths.reviews) ?? [];
  const escalations = readOptional(paths.escalations) ?? [];

  return {
    project: projectName(projectDir),
    run,
    recorded_at: now.toISOString(),
    tasks,
    pr: pr?.diff ? { lines: pr.diff.lines, files: pr.diff.files } : null,
    human: {
      reviews: reviews.map(({ at, verdict, text }) => ({ at, verdict, text })),
      decisions: plan.tasks.flatMap((t) => t.uncertain.map((u) => ({ task: t.id, q: u.q, decision: u.decision }))),
      escalations: escalations.map((e) => ({ task: e.task, q: e.q, answer: "answer" in e ? e.answer : null })),
    },
  };
}

/**
 * 記録を台帳の <project>/<run>.json に書き、そのファイルだけを台帳のリポジトリにコミットする。
 * 台帳がない、または空のディレクトリなら git init する。中身のあるディレクトリが git リポジトリのルートでなければ例外（既存のディレクトリを勝手に git 管理にしない）。
 * 同じファイルがすでにあれば何も書かずに例外。コミットに失敗したら、書いたファイルを消してから例外にする。
 * 名前とメールは台帳のリポジトリの設定を使い、なければ tasque-loop / tasque-loop@localhost にする。
 */
export function commitRecord(dir, record) {
  const rel = `${record.project}/${record.run}.json`;
  const file = join(dir, rel);
  const fresh = !existsSync(dir) || readdirSync(dir).length === 0;
  if (!fresh) assertLedgerRoot(dir);
  if (existsSync(file)) throw new Error(`台帳に ${rel} がすでにある`);

  if (fresh) {
    mkdirSync(dir, { recursive: true });
    git(dir, ["init", "-q"]);
  }
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(record, null, 2) + "\n", { flag: "wx" });

  try {
    git(dir, ["add", "--", rel]);
    git(dir, [...identityOptions(dir), "commit", "-q", "-m", `record ${record.project} ${record.run}`, "--", rel]);
  } catch (e) {
    spawnSync("git", ["rm", "--cached", "-q", "--", rel], { cwd: dir });
    rmSync(file, { force: true });
    throw new Error(`台帳のコミットに失敗した。書いた ${rel} は消した: ${e.message}`);
  }
  return file;
}

function assertLedgerRoot(dir) {
  const r = spawnSync("git", ["rev-parse", "--show-prefix"], { cwd: dir, encoding: "utf8" });
  if (r.status !== 0 || r.stdout.trim() !== "") {
    throw new Error(`台帳 ${dir} が git リポジトリのルートでない。既存のディレクトリは git 管理にせず、台帳は空のディレクトリか git リポジトリにする`);
  }
}

function identityOptions(dir) {
  const opts = [];
  if (!configValue(dir, "user.name")) opts.push("-c", "user.name=tasque-loop");
  if (!configValue(dir, "user.email")) opts.push("-c", "user.email=tasque-loop@localhost");
  return opts;
}

function configValue(dir, key) {
  const r = spawnSync("git", ["config", key], { cwd: dir, encoding: "utf8" });
  return r.status === 0 ? r.stdout.trim() : "";
}

function countBy(items, key, keys) {
  return Object.fromEntries(keys.map((k) => [k, items.filter((i) => i[key] === k).length]));
}

function readOptional(file) {
  return existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : null;
}
