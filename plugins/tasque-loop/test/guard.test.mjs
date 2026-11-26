import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { decide, defaultIsIgnored, IMPLEMENTER, toProjectRelative } from "../scripts/lib/guard.mjs";
import { approvePlan } from "../scripts/lib/run.mjs";
import { approvableProject, decidedPlan } from "./helpers.mjs";

const projectDir = join(tmpdir(), "proj");
const pluginRoot = join(tmpdir(), "plugin");
const scratch = join(tmpdir(), "scratch");
const task = () =>
  JSON.parse(readFileSync(new URL("../examples/plan.example.json", import.meta.url), "utf8")).tasks[0];

const call = (tool_name, tool_input, extra = {}) => ({
  agent_type: IMPLEMENTER,
  tool_name,
  tool_input,
  scratchpad_dir: scratch,
  ...extra,
});
const write = (file, extra = {}) => call("Write", { file_path: file, content: "x" }, extra);
const run = (input, { loadTask = task, others = [], active = true, isIgnored = () => false, dir = projectDir } = {}) => {
  const loadContext = () => {
    const t = loadTask();
    return { task: t, tasks: [t, ...others] };
  };
  return decide(input, { projectDir: dir, pluginRoot, loadContext, runActive: () => active, isIgnored });
};
const denied = (r) => r?.hookSpecificOutput?.permissionDecision === "deny";

test("実行中でなければ tasque-loop 以外のエージェントは判定しない", () => {
  const main = { agent_type: undefined };
  assert.equal(run(write(join(projectDir, "..", "x.ts"), main), { active: false }), null);
  assert.equal(run(write(join(projectDir, "..", "x.ts"), { agent_type: "Explore" }), { active: false }), null);
});

test("実行中はメインエージェントでもプロジェクト外のファイル操作を拒否する", () => {
  const main = { agent_type: undefined };
  assert.ok(denied(run(write(join(projectDir, "..", "x.ts"), main))));
  assert.ok(denied(run(call("Read", { file_path: join(tmpdir(), "secret") }, main))));
  assert.ok(denied(run(call("Grep", { pattern: "x", path: join(projectDir, "..") }, main))));
  assert.ok(denied(run(call("Glob", { pattern: "../other/**" }, main))));
  assert.equal(run(write(join(projectDir, "README.md"), main)), null);
  assert.equal(run(call("Glob", { pattern: "src/**/*.ts" }, main)), null);
  assert.equal(run(call("Bash", { command: "cat /etc/hosts" }, main)), null);
});

test("Glob の相対パターンは path から解決して判定する（cwd がプロジェクトの親でもよい）", () => {
  const main = { agent_type: undefined, cwd: join(projectDir, "..") };
  assert.equal(run(call("Glob", { pattern: "src/*", path: projectDir }, main)), null);
  assert.equal(run(call("Glob", { pattern: "**/*", path: projectDir }, main)), null);
  assert.ok(denied(run(call("Glob", { pattern: "../*", path: projectDir }, main))));
  assert.ok(denied(run(call("Glob", { pattern: "src/*" }, main))));
});

test("tasque-loop のエージェントは実行中でなくてもプロジェクト外を拒否する", () => {
  assert.ok(denied(run(call("Read", { file_path: join(tmpdir(), "secret") }), { active: false })));
});

test("スクラッチパッドは読み書き、プラグインのディレクトリは読み取りだけ許す", () => {
  const main = { agent_type: undefined };
  assert.equal(run(write(join(scratch, "tmp.txt"), main)), null);
  assert.equal(run(call("Read", { file_path: join(pluginRoot, "skills", "x.md") }, main)), null);
  assert.ok(denied(run(write(join(pluginRoot, "skills", "x.md"), main))));
});

test("許可リスト内の書き込みは通す（絶対パス・相対パス）", () => {
  assert.equal(run(write(join(projectDir, "src", "config", "load.ts"))), null);
  assert.equal(run(write("src/config/load.ts")), null);
});

test("バックスラッシュは Windows では区切りとして通し、POSIX ではファイル名の一部になるので拒否する", () => {
  const backslash = [`${projectDir}\\src\\index.ts`.replaceAll("/", "\\"), "src\\index.ts"];
  for (const p of backslash) {
    if (process.platform === "win32") assert.equal(run(write(p)), null, p);
    else assert.match(run(write(p))?.hookSpecificOutput?.permissionDecisionReason ?? "", /バックスラッシュ/, p);
  }
});

test("許可リスト外・deny・プロジェクト外は拒否する", () => {
  assert.ok(denied(run(write(join(projectDir, "src", "cli.ts")))));
  assert.ok(denied(run(write(join(projectDir, "src", "config", "generated", "x.ts")))));
  assert.ok(denied(run(write(join(projectDir, "..", "elsewhere.ts")))));
  assert.ok(denied(run(write(join(projectDir, "src", "..", "..", "x.ts")))));
});

test("受け入れテストと .tasque は allow に含まれていても拒否する", () => {
  const wide = () => ({ ...task(), allow: ["**"] });
  assert.ok(denied(run(write(join(projectDir, "test", "config.test.ts")), { loadTask: wide })));
  assert.ok(denied(run(write(join(projectDir, ".tasque", "current")), { loadTask: wide })));
  assert.ok(denied(run(write(join(projectDir, ".git", "config")), { loadTask: wide })));
});

test("大文字小文字を変えても受け入れテストと保護パスはすり抜けられない", () => {
  const wide = () => ({ ...task(), allow: ["**"] });
  assert.ok(denied(run(write(join(projectDir, "Test", "Config.Test.ts")), { loadTask: wide })));
  assert.ok(denied(run(write(join(projectDir, ".Tasque", "current")), { loadTask: wide })));
  assert.ok(denied(run(write(join(projectDir, ".GIT", "config")), { loadTask: wide })));
  assert.ok(denied(run(write(join(projectDir, "Tasque.Config.json")), { loadTask: wide })));
});

test("大文字小文字が違うパスは allow に一致しないので拒否される", () => {
  assert.ok(denied(run(write(join(projectDir, "SRC", "config", "load.ts")))));
});

test("Edit・Write 以外の書き込み系や Bash は拒否し、読み取り系と報告は通す", () => {
  assert.ok(denied(run(call("Bash", { command: "ls" }))));
  assert.ok(denied(run(call("NotebookEdit", { notebook_path: join(projectDir, "src", "config", "a.ipynb") }))));
  assert.ok(denied(run(call("WebFetch", {}))));
  assert.equal(run(call("Read", { file_path: join(projectDir, "README.md") })), null);
  assert.equal(run(call("Grep", { pattern: "x" })), null);
  assert.equal(run(call("SubagentHandback", { message: "## 結果\n完了" })), null);
});

test("契約が読めないときは拒否する", () => {
  const r = run(write(join(projectDir, "src", "index.ts")), {
    loadTask: () => {
      throw new Error("no current");
    },
  });
  assert.ok(denied(r));
  assert.match(r.hookSpecificOutput.permissionDecisionReason, /no current/);
});

test("toProjectRelative はプロジェクト外とルート自身を null にする", () => {
  assert.equal(toProjectRelative(projectDir, join(projectDir, "a", "b.ts")), "a/b.ts");
  assert.equal(toProjectRelative(projectDir, projectDir), null);
  assert.equal(toProjectRelative(projectDir, join(projectDir, "..", "a.ts")), null);
  assert.equal(toProjectRelative(projectDir, join(projectDir, "..x", "a.ts")), "..x/a.ts");
});

test("フックスクリプトは .tasque/current と承認済み契約を使って判定する", async () => {
  const { dir } = await approvableProject();
  const plan = decidedPlan();
  approvePlan(dir, plan);
  mkdirSync(join(dir, ".tasque"), { recursive: true });
  writeFileSync(join(dir, ".tasque", "current"), JSON.stringify({ run: plan.run, task: "T2" }));

  const hook = (input) =>
    execFileSync("node", [fileURLToPath(new URL("../scripts/guard.mjs", import.meta.url))], {
      input: JSON.stringify(input),
      env: { ...process.env, CLAUDE_PROJECT_DIR: dir },
      encoding: "utf8",
    });
  assert.equal(hook(write(join(dir, "src/cli.ts"))), "");
  assert.match(hook(write(join(dir, "src/index.ts"))), /"deny"/);
  assert.match(hook(write(join(dir, "..", "x.ts"), { agent_type: undefined })), /"deny"/);
  assert.match(hook(write(join(dir, "test/config.test.ts"))), /T1 の受け入れテスト/);
});

test("他のタスクのテストも、現在のタスクの allow に関係なく拒否する", () => {
  const other = { ...task(), id: "T9", tests: ["src/config/other.test.ts"] };
  const r = run(write(join(projectDir, "src", "config", "other.test.ts")), { others: [other] });
  assert.ok(denied(r));
  assert.match(r.hookSpecificOutput.permissionDecisionReason, /T9 の受け入れテスト/);
  assert.ok(denied(run(write(join(projectDir, "SRC", "Config", "Other.Test.ts")), { others: [other], loadTask: wide() })));
});

const wide = (extra = {}) => () => ({ ...task(), allow: ["**"], ...extra });

/**
 * 実在するディレクトリで判定を試すための一時プロジェクト。git リポジトリにする。
 */
function realProject(files = {}) {
  const dir = mkdtempSync(join(tmpdir(), "tasque-guard-"));
  execFileSync("git", ["init", "-q"], { cwd: dir });
  for (const [file, text] of Object.entries(files)) {
    mkdirSync(join(dir, file, ".."), { recursive: true });
    writeFileSync(join(dir, file), text);
  }
  return dir;
}

test("8.3 形式の短い名前で保護パスをすり抜けられない", () => {
  for (const p of ["CLAUDE~1/settings.json", "GIT~1/hooks/pre-commit", "TASQUE~1/current", "src/LONGNA~1.TS"]) {
    assert.ok(denied(run(write(join(projectDir, p)), { loadTask: wide() })), p);
  }
});

test("実在するディレクトリでも短い名前の書き込みは拒否する（短い名前が作られるかに依らない）", () => {
  const dir = realProject({ ".claude/settings.json": "{}", ".git/hooks/x": "", "src/a.test.js": "" });
  const loadTask = wide({ tests: ["src/a.test.js"] });
  for (const p of ["CLAUDE~1/settings.json", "GIT~1/hooks/pre-commit", "src/ATEST~1.JS"]) {
    assert.ok(denied(run(write(join(dir, p)), { loadTask, dir })), p);
  }
});

test("代替データストリーム・末尾のドットや空白は拒否する", () => {
  const loadTask = wide({ allow: ["src/**"], tests: ["src/a.test.js"] });
  for (const p of ["src/a.test.js::$DATA", "src/x.js:hidden", "src/a.test.js.", "src/x.js ", "src. /x.js"]) {
    assert.ok(denied(run(write(join(projectDir, p)), { loadTask })), p);
  }
  assert.equal(run(write(join(projectDir, "src", "x.js")), { loadTask }), null);
});

test("deny は大文字小文字を区別せずに照合する", () => {
  const loadTask = wide({ allow: ["src/**"], deny: ["src/secret/**"] });
  assert.ok(denied(run(write(join(projectDir, "src", "SECRET", "x.js")), { loadTask })));
  assert.ok(denied(run(write(join(projectDir, "src", "Secret", "x.js")), { loadTask })));
});

test("入れ子の CLAUDE.md・.claude・.git・.gitignore は allow に関係なく拒否する", () => {
  const loadTask = wide({ allow: ["src/**", "src/.claude/**", "src/.git/**", "src/.gitignore"] });
  for (const p of [
    "src/CLAUDE.md",
    "src/deep/claude.local.md",
    "CLAUDE.md",
    "src/.claude/settings.json",
    "src/.git/config",
    "src/.gitignore",
  ]) {
    assert.ok(denied(run(write(join(projectDir, p)), { loadTask })), p);
  }
});

test("git に無視されるパスへの書き込みは拒否する", () => {
  const dir = realProject({ ".gitignore": "node_modules/\n" });
  const loadTask = wide({ allow: ["**/*.js"] });
  const opts = { loadTask, dir, isIgnored: defaultIsIgnored };
  assert.ok(denied(run(write(join(dir, "node_modules", "lodash", "index.js")), opts)));
  assert.equal(run(write(join(dir, "src", "a.js")), opts), null);
});

test("git に問い合わせられないときは implementer の書き込みを拒否する", () => {
  const notRepo = mkdtempSync(join(tmpdir(), "tasque-guard-"));
  assert.ok(denied(run(write(join(notRepo, "src", "a.js")), { loadTask: wide(), dir: notRepo, isIgnored: defaultIsIgnored })));
  const r = run(write(join(projectDir, "src", "a.js")), {
    loadTask: wide(),
    isIgnored: () => {
      throw new Error("git がない");
    },
  });
  assert.ok(denied(r));
  assert.match(r.hookSpecificOutput.permissionDecisionReason, /git がない/);
});

test("先頭の ~ はホームディレクトリとして扱う", () => {
  const main = { agent_type: undefined };
  assert.ok(denied(run(call("Read", { file_path: "~/.ssh/id_rsa" }, main))));
  assert.ok(denied(run(write("~/x.ts", main))));
  assert.ok(denied(run(write("~"))));
});

test("相対パスは入力の cwd から解決する", () => {
  assert.equal(run(write("config/load.ts", { cwd: join(projectDir, "src") })), null);
  assert.ok(denied(run(write("src/config/load.ts", { cwd: join(projectDir, "src") }))));
  assert.ok(denied(run(write("src/config/load.ts", { cwd: join(tmpdir(), "elsewhere"), agent_type: undefined }))));
});

test("planner は保護パスに書けず、下書きとテストは書ける", () => {
  const planner = { agent_type: "tasque-loop:planner" };
  for (const p of [
    ".tasque/runs/r1/approval.json",
    ".tasque/runs/r1/approved.json",
    ".tasque/current",
    ".Tasque/plan.draft.check.json",
    ".git/config",
    ".claude/settings.json",
    "src/CLAUDE.md",
    "tasque.config.json",
    "TASQUE~1/runs/r1/approval.json",
    "src/a.test.js::$DATA",
  ]) {
    assert.ok(denied(run(write(join(projectDir, p), planner))), p);
  }
  for (const p of [".tasque/plan.draft.json", "test/config.test.ts", "src/new.ts", "docs/x.md"]) {
    assert.equal(run(write(join(projectDir, p), planner)), null, p);
  }
  assert.equal(run(call("Read", { file_path: join(projectDir, ".tasque", "current") }, planner)), null);
});
