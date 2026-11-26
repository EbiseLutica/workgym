import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { approvePlan, baselinePath } from "../scripts/lib/run.mjs";
import {
  formatRed,
  verifyBaseline,
  verifyPost,
  verifyPr,
  verifyPre,
  verifyRed,
} from "../scripts/lib/verify.mjs";
import { examplePlan, makeRepo } from "./helpers.mjs";

const RUN = "r1";

const CHECK =
  'import { readFileSync } from "node:fs";\n' +
  'let ok = false;\ntry { ok = readFileSync("src/impl.txt", "utf8").trim() === "ok"; } catch {}\n' +
  "process.exit(ok ? 0 : 1);\n";

const task = (id, extra = {}) => ({
  id,
  title: `${id} を作る`,
  goal: "src/impl.txt に ok と書く",
  depends_on: [],
  allow: ["src/**"],
  out_of_scope: [],
  tests: ["test/check.mjs"],
  acceptance: [{ cmd: "node test/check.mjs", why: "impl.txt の中身" }],
  max_diff: { lines: 5, files: 2 },
  uncertain: [],
  ...extra,
});

/**
 * 練習用リポジトリを作り、基点の記録 → planner のテスト → 承認 → テストのコミットまで進めた状態にする。
 * sub を指定すると、リポジトリのサブディレクトリをプロジェクトにする。
 */
async function setup({ config, tasks = [task("T1")], files = {}, sub = "" } = {}) {
  const repo = makeRepo({ sub, files: config ? { "tasque.config.json": JSON.stringify(config), ...files } : files });
  await verifyBaseline(repo.dir);
  repo.put("test/check.mjs", CHECK);
  for (const t of tasks.flatMap((x) => x.tests)) if (t !== "test/check.mjs") repo.put(t, "process.exit(1);\n");
  approvePlan(repo.dir, { version: 1, run: RUN, request: "impl.txt に ok と書く", base: "main", tasks });
  repo.git("add", "--", ...tasks.flatMap((x) => x.tests));
  repo.git("commit", "-q", "-m", "test: acceptance");
  return repo;
}

const failed = (result) => result.checks.filter((c) => !c.ok).map((c) => c.name);

test("baseline: HEAD・ブランチ・全体テストの結果を記録する", async () => {
  const { dir, git } = makeRepo();
  const r = await verifyBaseline(dir);
  assert.equal(r.ok, true);
  assert.equal(r.commit, git("rev-parse", "HEAD").trim());
  assert.equal(r.branch, "work");
  assert.equal(r.suite, null);
  assert.deepEqual(JSON.parse(readFileSync(baselinePath(dir), "utf8")).commit, r.commit);
});

test("baseline: 全体テストが落ちれば ok: false と warning", async () => {
  const { dir } = makeRepo({ files: { "tasque.config.json": JSON.stringify({ test_cmd: 'node -e "process.exit(1)"' }) } });
  const r = await verifyBaseline(dir);
  assert.equal(r.ok, false);
  assert.equal(r.suite.status, "fail");
  assert.ok(r.warnings.some((w) => w.includes("全体テストが通らない")));
});

test("baseline・red: tasque.config.json が git に無視されていれば warning（失敗にはしない）", async () => {
  const { dir, put, putRoot } = makeRepo();
  putRoot(".gitignore", ".tasque/\ntasque.config.json\n");
  put("tasque.config.json", "{}");
  const ignored = (w) => w.includes("tasque.config.json が git に無視されている");
  const r = await verifyBaseline(dir);
  assert.equal(r.ok, true);
  assert.ok(r.warnings.some(ignored));

  put("test/config.test.ts", "");
  put("test/cli.test.ts", "");
  put(".tasque/plan.draft.json", JSON.stringify(examplePlan()).replaceAll("npm test -- ", "node -e process.exit(1) "));
  assert.ok((await verifyRed(dir)).warnings.some(ignored));
});

test("pre: クリーンでテストがコミット済みなら通り、post: 正しく実装すれば通る", async () => {
  const { dir, put } = await setup();
  assert.deepEqual(failed(await verifyPre(dir, RUN, "T1")), []);
  put("src/impl.txt", "ok\n");
  const post = await verifyPost(dir, RUN, "T1");
  assert.deepEqual(failed(post), []);
  assert.deepEqual(post.diff.changed, ["src/impl.txt"]);
  assert.equal(post.diff.lines, 1);
  assert.equal(post.checks.at(-1).command.status, "pass");
});

test("pre: 未コミットの変更やテストがあれば落とし、直せばやり直せる", async () => {
  const { dir, put, git } = await setup();
  put("test/check.mjs", "process.exit(1);\n");
  const names = failed(await verifyPre(dir, RUN, "T1"));
  assert.ok(names.includes("clean_tree"));
  assert.ok(names.includes("tests_committed"));
  git("checkout", "--", "test/check.mjs");
  assert.deepEqual(failed(await verifyPre(dir, RUN, "T1")), []);
});

test("pre: 通過済みのタスクにはもう一度使えない（基点を動かさない）", async () => {
  const { dir } = await setup();
  await verifyPre(dir, RUN, "T1");
  await assert.rejects(verifyPre(dir, RUN, "T1"), /通過済み/);
});

test("pre: ベースブランチの上では落とす", async () => {
  const { dir, git } = await setup();
  git("switch", "-q", "main");
  git("merge", "-q", "--ff-only", "work");
  assert.deepEqual(failed(await verifyPre(dir, RUN, "T1")), ["branch"]);
});

test("post: pre を通っていなければ例外", async () => {
  const { dir } = await setup();
  await assert.rejects(verifyPost(dir, RUN, "T1"), /pre/);
});

test("post: 許可リスト外の変更・テストの変更・diff 超過を検出する", async () => {
  const { dir, put } = await setup();
  await verifyPre(dir, RUN, "T1");
  put("src/impl.txt", "ok\n");
  put("README.md", "practice\nedited\n");
  put("test/check.mjs", "process.exit(0);\n");
  put("src/big.txt", "a\nb\nc\nd\ne\nf\n");
  const names = failed(await verifyPost(dir, RUN, "T1"));
  assert.ok(names.includes("scope"));
  assert.ok(names.includes("tests_unchanged"));
  assert.ok(names.includes("max_diff"));
});

test("post: 他のタスクのテストの変更も検出する", async () => {
  const { dir, put } = await setup({
    tasks: [task("T1"), task("T2", { tests: ["test/other.mjs"], acceptance: [{ cmd: "node test/other.mjs", why: "T2" }] })],
  });
  await verifyPre(dir, RUN, "T1");
  put("src/impl.txt", "ok\n");
  put("test/other.mjs", "process.exit(0);\n");
  const post = await verifyPost(dir, RUN, "T1");
  assert.ok(failed(post).includes("tests_unchanged"));
  assert.match(post.checks.find((c) => c.name === "tests_unchanged").detail, /test\/other\.mjs/);
});

test("post: 受け入れコマンドが書き換えたファイルも判定に含め、そのことを残す", async () => {
  const sneaky = task("T1", {
    acceptance: [{ cmd: 'node -e "require(\'fs\').writeFileSync(\'docs.txt\', \'x\')"', why: "副作用" }],
  });
  const { dir, put } = await setup({ tasks: [sneaky] });
  await verifyPre(dir, RUN, "T1");
  put("src/impl.txt", "ok\n");
  const post = await verifyPost(dir, RUN, "T1");
  assert.deepEqual(failed(post), ["scope"]);
  assert.match(post.checks[0].detail, /docs\.txt/);
  assert.match(post.checks[0].detail, /実行中に変更の一覧が変わった/);
  assert.deepEqual(post.diff.before_commands, ["src/impl.txt"]);
});

test("post: 全体テスト（test_cmd）は走らせない", async () => {
  const { dir, put } = await setup({
    config: { test_cmd: "node -e \"process.exit(require('fs').existsSync('src/impl.txt') ? 1 : 0)\"" },
  });
  await verifyPre(dir, RUN, "T1");
  put("src/impl.txt", "ok\n");
  const post = await verifyPost(dir, RUN, "T1");
  assert.deepEqual(failed(post), []);
  assert.ok(post.checks.every((c) => !c.name.startsWith("suite")));
});

test("post: diff_exclude のファイルは diff 量に数えない", async () => {
  const { dir, put } = await setup({ config: { diff_exclude: ["src/generated/**"] } });
  await verifyPre(dir, RUN, "T1");
  put("src/impl.txt", "ok\n");
  put("src/generated/huge.txt", "x\n".repeat(100));
  const post = await verifyPost(dir, RUN, "T1");
  assert.deepEqual(failed(post), []);
  assert.equal(post.diff.lines, 1);
});

test("post: NUL を含むバイナリ扱いの変更も diff 量に数える", async () => {
  const { dir, git, put } = await setup();
  put("src/data.txt", "a\n");
  git("add", "--", "src/data.txt");
  git("commit", "-q", "-m", "既存のデータ");
  await verifyPre(dir, RUN, "T1");
  put("src/impl.txt", "ok\n");
  put("src/data.txt", "\0\n" + "hidden\n".repeat(20));
  const post = await verifyPost(dir, RUN, "T1");
  assert.deepEqual(failed(post), ["max_diff"]);
  assert.equal(post.diff.lines, 1 + 1 + 21);
});

test("post: .gitattributes の -diff で diff 量を実際の行数より小さくできない", async () => {
  const { dir, git, put } = await setup();
  put(".gitattributes", "*.txt -diff\n");
  put("src/data.txt", "a\nb\n");
  git("add", "--", ".gitattributes", "src/data.txt");
  git("commit", "-q", "-m", "既存のデータと属性");
  await verifyPre(dir, RUN, "T1");
  put("src/impl.txt", "ok\n");
  put("src/data.txt", "a\nb\n" + "hidden\n".repeat(20));
  const post = await verifyPost(dir, RUN, "T1");
  assert.ok(post.diff.lines >= 1 + 20, `lines=${post.diff.lines}`);
  assert.deepEqual(failed(post), ["max_diff"]);
});

test("post: 非 ASCII 名のテストの変更も検出する", async () => {
  const { dir, put } = await setup({ tasks: [task("T1", { tests: ["test/check.mjs", "test/日本語.mjs"] })] });
  await verifyPre(dir, RUN, "T1");
  put("src/impl.txt", "ok\n");
  put("test/日本語.mjs", "process.exit(0);\n");
  const post = await verifyPost(dir, RUN, "T1");
  assert.ok(failed(post).includes("tests_unchanged"));
  assert.ok(post.diff.changed.includes("test/日本語.mjs"));
});

test("pr: コミット済みで範囲内なら通り、上限を超えれば落とす", async () => {
  const { dir, git, put } = await setup({ config: { pr: { max_lines: 10 } } });
  put("src/impl.txt", "ok\n");
  git("add", "--", "src/impl.txt");
  git("commit", "-q", "-m", "feat: T1");
  assert.deepEqual(failed(await verifyPr(dir, RUN)), []);

  put("src/pad.txt", "pad\n".repeat(20));
  assert.deepEqual(failed(await verifyPr(dir, RUN)), ["clean_tree"]);
  git("add", "--", "src/pad.txt");
  git("commit", "-q", "-m", "膨らませる");
  assert.deepEqual(failed(await verifyPr(dir, RUN)), ["pr_size"]);
});

test("pr: 承認時の基点コミットを使う（main が進んでも差分を見失わない）", async () => {
  const { dir, git, put } = await setup({ config: { pr: { max_lines: 10 } } });
  put("src/impl.txt", "ok\n" );
  put("src/pad.txt", "pad\n".repeat(20));
  git("add", "--", "src/impl.txt", "src/pad.txt");
  git("commit", "-q", "-m", "feat: T1");
  git("branch", "-f", "main", "HEAD");
  const pr = await verifyPr(dir, RUN);
  assert.deepEqual(failed(pr), ["pr_size"]);
  assert.ok(pr.diff.changed.includes("src/pad.txt"));
});

test("pr: どのタスクにも属さない変更を検出する", async () => {
  const { dir, git, put } = await setup();
  put("src/impl.txt", "ok\n");
  put("docs/note.md", "memo\n");
  git("add", "--", "src/impl.txt", "docs/note.md");
  git("commit", "-q", "-m", "feat: T1");
  assert.deepEqual(failed(await verifyPr(dir, RUN)), ["scope"]);
});

test("pr: 全体テストと全タスクの受け入れコマンドを走らせ、落ちたら検出する", async () => {
  const { dir, git, put } = await setup({ config: { test_cmd: "node test/suite.mjs" }, files: {
    "test/suite.mjs": 'import { existsSync } from "node:fs";\nprocess.exit(existsSync("src/broken.txt") ? 1 : 0);\n',
  } });
  put("src/impl.txt", "ok\n");
  git("add", "--", "src/impl.txt");
  git("commit", "-q", "-m", "feat: T1");
  const pr = await verifyPr(dir, RUN);
  assert.deepEqual(failed(pr), []);
  assert.deepEqual(
    pr.checks.filter((c) => c.command).map((c) => c.name),
    ["suite: node test/suite.mjs", "acceptance: T1: node test/check.mjs"],
  );

  put("src/broken.txt", "x\n");
  put("src/impl.txt", "ng\n");
  git("add", "--", "src/broken.txt", "src/impl.txt");
  git("commit", "-q", "-m", "壊す");
  assert.deepEqual(failed(await verifyPr(dir, RUN)), ["suite: node test/suite.mjs", "acceptance: T1: node test/check.mjs"]);
});

test("pr: 承認後に書き換えられたテストを検出する", async () => {
  const { dir, git, put } = await setup();
  put("src/impl.txt", "ok\n");
  put("test/check.mjs", "process.exit(0);\n");
  git("add", "--", "src/impl.txt", "test/check.mjs");
  git("commit", "-q", "-m", "テストもいじる");
  assert.deepEqual(failed(await verifyPr(dir, RUN)), ["tests_intact"]);
});

test("monorepo: プロジェクト外の変更はスコープ違反、.tasque はサブディレクトリでも除く、cwd でコマンドを走らせる", async () => {
  const t1 = task("T1", {
    acceptance: [
      { cmd: "node test/check.mjs", why: "impl.txt の中身" },
      { cmd: 'node -e "process.exit(require(\'fs\').existsSync(\'impl.txt\') ? 0 : 1)"', cwd: "src", why: "cwd" },
    ],
  });
  const { dir, git, put, putRoot } = await setup({ sub: "packages/app", tasks: [t1] });
  await verifyPre(dir, RUN, "T1");
  put("src/impl.txt", "ok\n");
  assert.deepEqual(failed(await verifyPost(dir, RUN, "T1")).length, 0, "within project");
  assert.ok(existsSync(join(dir, ".tasque")));

  putRoot("other/x.txt", "x\n");
  const post = await verifyPost(dir, RUN, "T1");
  assert.deepEqual(failed(post), ["scope"]);
  assert.ok(post.diff.changed.includes("../../other/x.txt"));

  git("add", "--", "src/impl.txt", "../../other/x.txt");
  git("commit", "-q", "-m", "feat: T1 と外の変更");
  assert.deepEqual(failed(await verifyPr(dir, RUN)), ["scope"]);
  rmSync(join(dir, "..", "..", "other"), { recursive: true });
});

test("red: fail だけを Red とし、通った・壊れている・タイムアウトは warning にする", async () => {
  const { dir, put } = makeRepo({ files: { "tasque.config.json": JSON.stringify({ command_timeout_sec: 1 }) } });
  put("test/config.test.ts", "");
  put("test/cli.test.ts", "");
  const plan = examplePlan();
  plan.tasks[0].acceptance = [
    { cmd: 'node -e "process.exit(1)"', why: "落ちる" },
    { cmd: "tasque_no_such_command_xyz", why: "壊れている" },
  ];
  plan.tasks[1].acceptance = [
    { cmd: "node -e 0", why: "最初から通る" },
    { cmd: 'node -e "setTimeout(() => {}, 10000)"', why: "終わらない" },
  ];
  put(".tasque/plan.draft.json", JSON.stringify(plan));

  const red = await verifyRed(dir);
  assert.deepEqual(
    red.results.map((r) => [r.task, r.status, r.red]),
    [
      ["T1", "fail", true],
      ["T1", "broken", false],
      ["T2", "pass", false],
      ["T2", "timeout", false],
    ],
  );
  assert.equal(red.warnings.length, 3);
  assert.match(red.digest, /^[0-9a-f]{64}$/);
  assert.equal(JSON.parse(readFileSync(join(dir, ".tasque", "plan.draft.red.json"), "utf8")).warnings.length, 3);

  const text = formatRed(red);
  assert.match(text, /T1: `node -e "process\.exit\(1\)"` — ✖ Red（exit 1）/);
  assert.match(text, /T1: `tasque_no_such_command_xyz` — ⚠ 壊れている/);
  assert.match(text, /T2: `node -e 0` — ⚠ 実装前から通った/);
  assert.match(text, /— ⏱ タイムアウト/);
});

test("red: 実行中に下書きかテストが書き換えられたらハッシュを残さない", async () => {
  const { dir, put } = makeRepo();
  put("test/config.test.ts", "");
  put("test/cli.test.ts", "");
  const plan = examplePlan();
  plan.tasks[0].acceptance = [
    { cmd: 'node -e "require(\'fs\').writeFileSync(\'test/cli.test.ts\', \'x\'); process.exit(1)"', why: "書き換える" },
  ];
  put(".tasque/plan.draft.json", JSON.stringify(plan));
  const red = await verifyRed(dir);
  assert.equal(red.digest, null);
  assert.ok(red.warnings.some((w) => w.includes("書き換えられた")));
});

test("red: 下書きの契約が不正なら例外", async () => {
  const { dir, put } = makeRepo();
  put(".tasque/plan.draft.json", JSON.stringify({ version: 1 }));
  await assert.rejects(verifyRed(dir), /下書きの契約が不正/);
});

test("post: Windows で扱えない名前のファイルができたら portable_names で落とす（POSIX でだけ作れる）", { skip: process.platform === "win32" }, async () => {
  const { dir, put } = await setup({ tasks: [task("T1", { max_diff: { lines: 10, files: 5 } })] });
  await verifyPre(dir, RUN, "T1");
  put("src/impl.txt", "ok\n");
  put("src/a\b.txt", "x\n");
  put("src/con.txt", "x\n");
  const post = await verifyPost(dir, RUN, "T1");
  assert.deepEqual(failed(post), ["portable_names"]);
  assert.match(post.checks.find((c) => c.name === "portable_names").detail, /a\b\.txt.*con\.txt/s);
});

test("post: 普通の名前なら portable_names は通る", async () => {
  const { dir, put } = await setup();
  await verifyPre(dir, RUN, "T1");
  put("src/impl.txt", "ok\n");
  const post = await verifyPost(dir, RUN, "T1");
  assert.equal(post.checks.find((c) => c.name === "portable_names").ok, true);
});
