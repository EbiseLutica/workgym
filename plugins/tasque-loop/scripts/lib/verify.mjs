import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { runCommand } from "./command.mjs";
import { CONFIG_FILE, loadConfig, testCommand } from "./config.mjs";
import {
  isAllowed,
  isDeclaredDelete,
  isTestPath,
  matchesAny,
  portablePathError,
  samePath,
  validatePlan,
} from "./contract.mjs";
import { currentBranch, git, headCommit, isIgnored, isOutsideProject, isTrackedAs, repoLayout } from "./git.mjs";
import { draftDigest, draftPaths } from "./plan-check.mjs";
import { baselinePath, loadApproval, runPaths, sha256Of, taskFile } from "./run.mjs";

/**
 * ランの基点の記録。worktree を作った直後、planner より前に走らせる（run id はまだない）。
 * HEAD・ブランチ・日時と、test_cmd があればその結果を .tasque/baseline.json に残す。
 * 基点で全体テストが落ちるなら ok: false（ランを始めない）。test_cmd がなければ suite: null。
 */
export async function verifyBaseline(projectDir, { now = new Date() } = {}) {
  const config = loadConfig(projectDir);
  const warnings = configWarnings(projectDir);
  const suiteCmd = testCommand(config);
  const suite = suiteCmd ? await exec(projectDir, suiteCmd, config) : null;
  if (suite && !suite.ok) warnings.push(`基点で全体テストが通らない（${suite.status}）。ランを始める前に直す`);

  const result = {
    phase: "baseline",
    ok: suite === null || suite.ok,
    commit: headCommit(projectDir),
    branch: currentBranch(projectDir),
    at: now.toISOString(),
    suite,
    warnings,
  };
  const file = baselinePath(projectDir);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(result, null, 2) + "\n");
  return result;
}

/**
 * 承認前の Red 確認。planner が書いた未コミットのテストを含む作業ツリーで、下書きの各タスクの受け入れコマンドを走らせる。
 * 実装前なので fail（通常の非ゼロ終了）が期待どおり。それ以外（通った・壊れている・タイムアウト）は warning として残し、
 * 判断は人間のレビューに任せる。結果は下書きとテストのハッシュとともに .tasque/plan.draft.red.json に保存する。
 * 実行中に下書きかテストが変わったら、ハッシュを null にして承認できないようにする。
 */
export async function verifyRed(projectDir) {
  const paths = draftPaths(projectDir);
  const plan = JSON.parse(readFileSync(paths.draft, "utf8"));
  const errors = validatePlan(plan, { stage: "draft" });
  if (errors.length > 0) throw new Error(`下書きの契約が不正:\n- ${errors.join("\n- ")}`);
  const config = loadConfig(projectDir);
  const warnings = configWarnings(projectDir);
  const before = draftDigest(projectDir);

  const results = [];
  for (const task of plan.tasks) {
    for (const a of task.acceptance) {
      const r = await exec(projectDir, a, config);
      results.push({ task: task.id, why: a.why, red: r.status === "fail", ...r });
      if (r.status !== "fail") warnings.push(`${task.id}: \`${a.cmd}\` — ${statusMark(r)}`);
    }
  }

  const after = draftDigest(projectDir);
  if (before !== after) warnings.push("Red 確認の実行中に下書きかテストが書き換えられた。承認前に Red 確認をやり直す");
  const result = { run: plan.run, phase: "red", digest: before === after ? after : null, warnings, results };
  writeFileSync(paths.red, JSON.stringify(result, null, 2) + "\n");
  return result;
}

/**
 * Red 確認の結果を、人間がそのまま読めるテキストにする。
 */
export function formatRed(result) {
  const lines = [`# Red 確認（run ${result.run}）`, ""];
  if (result.warnings.length > 0) {
    lines.push(`確認が必要な点が ${result.warnings.length} 件ある:`, ...result.warnings.map((w) => `- ${w}`), "");
  }
  for (const r of result.results) {
    lines.push(`## ${r.task}: \`${r.cmd}\` — ${statusMark(r)}`, "", `確かめること: ${r.why}`, "");
    if (r.cwd !== ".") lines.push(`作業ディレクトリ: ${r.cwd}`, "");
    for (const [name, text] of [
      ["stdout", r.stdout],
      ["stderr", r.stderr],
    ]) {
      if (text.trim() !== "") lines.push(`${name}（末尾）:`, "```", text.trimEnd(), "```", "");
    }
  }
  return lines.join("\n");
}

/**
 * コマンド結果の表示。Red 確認では fail だけが期待どおり。
 */
export function statusMark(r) {
  switch (r.status) {
    case "fail":
      return `✖ Red（exit ${r.exit}）`;
    case "timeout":
      return "⏱ タイムアウト";
    case "broken":
      return `⚠ 壊れている（${r.error ? `${r.error.code ?? ""} ${r.error.message}`.trim() : r.signal ? `signal ${r.signal}` : `exit ${r.exit}`}）`;
    default:
      return "⚠ 実装前から通った";
  }
}

/**
 * 実装前の検査。作業ツリーがクリーンで、planner のテストがコミット済みで、ベースブランチの上にいないことを確かめる。
 * 契約の delete に挙がったファイルがあれば、それらが追跡済みで実在することも確かめる。
 * 通れば HEAD をこのタスクの基点として記録し、delete のファイルを git rm で消す（削除はこのタスクの変更になる）。
 * 基点の記録がすでにあるタスクには使えない（基点を動かさないため）。
 */
export async function verifyPre(projectDir, run, taskId) {
  const { plan, task } = load(projectDir, run, taskId);
  if (existsSync(statePath(projectDir, run, taskId))) {
    throw new Error(`${taskId} は pre の検査を通過済み。基点は記録し直さない`);
  }
  const layout = repoLayout(projectDir);
  const warnings = configWarnings(projectDir);
  const checks = [];

  const dirty = changedSince(layout, "HEAD");
  checks.push(check("clean_tree", dirty.length === 0, dirty.length ? `未コミットの変更: ${dirty.join(", ")}` : ""));

  const missing = task.tests.filter((t) => !isTracked(projectDir, t, dirty));
  checks.push(check("tests_committed", missing.length === 0, missing.length ? `未コミット: ${missing.join(", ")}` : ""));

  const branch = currentBranch(projectDir);
  checks.push(
    check(
      "branch",
      branch !== null && branch !== plan.base,
      branch === null ? "HEAD が detached" : branch === plan.base ? `ベースブランチ ${plan.base} の上で作業している` : "",
    ),
  );

  const deletes = task.delete ?? [];
  const untracked = deletes.filter((p) => !isTrackedAs(projectDir, p));
  checks.push(
    check("delete_tracked", untracked.length === 0, untracked.length ? `追跡済みのファイルではない: ${untracked.join(", ")}` : ""),
  );

  const result = { ...finish(run, taskId, "pre", checks), warnings };
  if (result.ok) {
    // git rm が失敗したときに基点だけが残って pre をやり直せなくならないよう、消してから基点を記録する
    const base = headCommit(projectDir);
    if (deletes.length > 0) git(projectDir, ["--literal-pathspecs", "rm", "-q", "--", ...deletes]);
    writeState(projectDir, run, taskId, { base });
    result.deleted = deletes;
  }
  return save(projectDir, run, `${taskId}.pre`, result);
}

/**
 * 実装後の検査。基点からの変更が許可リストと diff 上限に収まり、どのタスクのテストも手つかずで、受け入れコマンドが通ることを確かめる。
 * 追跡済みのファイルの削除は、契約の delete に挙がったものだけを認める（allow に一致していても、宣言のない削除は scope で落とす）。
 * delete に挙がったファイルは消えたままでなければならず、diff 上限の行数とファイル数には数えない（件数は diff.deleted に残す）。
 * 受け入れコマンドが作業ツリーを書き換えうるため、変更の一覧はコマンドの前後で取り、判定は後の一覧で行う。
 */
export async function verifyPost(projectDir, run, taskId) {
  const { plan, task, config } = load(projectDir, run, taskId);
  const { base } = readState(projectDir, run, taskId);
  const layout = repoLayout(projectDir);

  const before = changedSince(layout, base);
  const commandChecks = [];
  for (const a of task.acceptance) {
    const r = await exec(projectDir, a, config);
    commandChecks.push(check(`acceptance: ${a.cmd}`, r.ok, r.ok ? "" : statusMark(r), r));
  }
  const changed = changedSince(layout, base);
  const moved = !sameList(before, changed);
  const note = moved ? `（受け入れコマンドの実行中に変更の一覧が変わった。実行前: ${before.join(", ") || "なし"}）` : "";

  const removed = deletedSince(layout, base);
  const declared = removed.filter((f) => isDeclaredDelete(f, task));

  const checks = [];
  const outside = changed.filter(
    (f) => isOutsideProject(f) || (removed.includes(f) ? !isDeclaredDelete(f, task) : !isAllowed(f, task)),
  );
  checks.push(check("scope", outside.length === 0, (outside.length ? `許可リスト外: ${outside.join(", ")}` : "") + note));

  // git rm の後に作り直したファイルは、未追跡のまま差分上は削除に見えるので、ディスク上の有無も見る
  const remaining = (task.delete ?? []).filter(
    (p) => !declared.includes(p) || existsSync(join(projectDir, p)),
  );
  checks.push(check("delete_done", remaining.length === 0, remaining.length ? `消えていない: ${remaining.join(", ")}` : ""));

  const touched = changed.filter((f) => isTestPath(f, plan));
  checks.push(check("tests_unchanged", touched.length === 0, (touched.length ? `変更された: ${touched.join(", ")}` : "") + note));

  checks.push(portableNamesCheck(projectDir, changed));

  const size = diffSize(projectDir, layout, base, changed, config.diff_exclude, { skip: declared });
  checks.push(
    check(
      "max_diff",
      size.lines <= task.max_diff.lines && size.files <= task.max_diff.files,
      `${size.lines}/${task.max_diff.lines} 行、${size.files}/${task.max_diff.files} ファイル${deletedNote(declared)}`,
    ),
  );
  checks.push(...commandChecks);

  const result = finish(run, taskId, "post", checks);
  result.diff = { base, changed, ...size, deleted: declared, ...(moved ? { before_commands: before } : {}) };
  appendPostHistory(projectDir, run, taskId, {
    at: new Date().toISOString(),
    ok: result.ok,
    failed: checks.filter((c) => !c.ok).map((c) => c.name),
    scope_outside: outside,
  });
  return save(projectDir, run, `${taskId}.post`, result);
}

/**
 * PR 前の検査。承認時の基点コミットからのラン全体の変更について、次を確かめる。
 * - 作業ツリーがクリーン（コマンドの実行前後とも）
 * - 変更がプロジェクト内で、どれかのタスクの範囲に収まる（追跡済みのファイルの削除は、どれかのタスクの delete に挙がっている）
 * - テストファイルの中身が承認時のハッシュと一致する
 * - PR の上限を超えない（delete に挙がったファイルの削除は行数にもファイル数にも数えず、diff.deleted に残す）
 * - test_cmd があれば全体テストが通り、全タスクの受け入れコマンドが通る
 */
export async function verifyPr(projectDir, run) {
  const { plan, approval } = loadApproval(projectDir, run);
  const config = loadConfig(projectDir);
  const layout = repoLayout(projectDir);
  const base = approval.base_commit;
  if (!base) throw new Error(`run ${run} の承認記録に base_commit がない`);

  const dirtyBefore = changedSince(layout, "HEAD");
  const commandChecks = [];
  const suiteCmd = testCommand(config);
  if (suiteCmd) {
    const r = await exec(projectDir, suiteCmd, config);
    commandChecks.push(check(`suite: ${suiteCmd.cmd}`, r.ok, r.ok ? "" : `全体テストが通らない: ${statusMark(r)}`, r));
  }
  for (const task of plan.tasks) {
    for (const a of task.acceptance) {
      const r = await exec(projectDir, a, config);
      commandChecks.push(check(`acceptance: ${task.id}: ${a.cmd}`, r.ok, r.ok ? "" : statusMark(r), r));
    }
  }
  const dirty = [...new Set([...dirtyBefore, ...changedSince(layout, "HEAD")])].sort();

  const checks = [];
  checks.push(check("clean_tree", dirty.length === 0, dirty.length ? `未コミットの変更: ${dirty.join(", ")}` : ""));

  const changed = changedSince(layout, base, { committedOnly: true });
  const removed = deletedSince(layout, base, { committedOnly: true });
  const declared = removed.filter((f) => plan.tasks.some((t) => isDeclaredDelete(f, t)));
  const orphan = changed.filter(
    (f) =>
      isOutsideProject(f) ||
      (removed.includes(f)
        ? !declared.includes(f)
        : !plan.tasks.some((t) => isAllowed(f, t) || isTestPath(f, [t]))),
  );
  checks.push(check("scope", orphan.length === 0, orphan.length ? `どのタスクにも属さない: ${orphan.join(", ")}` : ""));
  checks.push(portableNamesCheck(projectDir, changed));

  const tampered = testsTampered(projectDir, plan, approval);
  checks.push(check("tests_intact", tampered.length === 0, tampered.length ? `承認時と違う: ${tampered.join(", ")}` : ""));

  const size = diffSize(projectDir, layout, base, changed, config.diff_exclude, { committedOnly: true, skip: declared });
  checks.push(
    check(
      "pr_size",
      size.lines <= config.pr.max_lines && size.files <= config.pr.max_files,
      `${size.lines}/${config.pr.max_lines} 行、${size.files}/${config.pr.max_files} ファイル${deletedNote(declared)}`,
    ),
  );
  checks.push(...commandChecks);

  const result = {
    run,
    phase: "pr",
    ok: checks.every((c) => c.ok),
    checks,
    diff: { base, changed, ...size, deleted: declared },
  };
  return save(projectDir, run, "pr", result);
}

/**
 * 承認時に記録したハッシュと中身が一致しないテストファイル（存在しないものを含む）。
 */
function testsTampered(projectDir, plan, approval) {
  const recorded = approval.tests ?? {};
  const all = plan.tasks.flatMap((t) => t.tests);
  return all.filter((t) => {
    const file = join(projectDir, t);
    return !recorded[t] || !existsSync(file) || sha256Of(readFileSync(file)) !== recorded[t];
  });
}

function load(projectDir, run, taskId) {
  const { plan } = loadApproval(projectDir, run);
  const task = plan.tasks.find((t) => t.id === taskId);
  if (!task) throw new Error(`run ${run} にタスク ${taskId} はない`);
  return { plan, task, config: loadConfig(projectDir) };
}

/**
 * tasque.config.json が git に無視されていれば warning を返す。新しい worktree にコピーされず、既定値で動いてしまうため。
 */
function configWarnings(projectDir) {
  try {
    if (existsSync(join(projectDir, CONFIG_FILE)) && isIgnored(projectDir, CONFIG_FILE)) {
      return [`${CONFIG_FILE} が git に無視されている。新しい worktree には入らないので、コミットするか .gitignore から外す`];
    }
  } catch {}
  return [];
}

/**
 * 受け入れコマンド（{ cmd, cwd? }）をプロジェクト内の cwd で走らせる。結果の cwd はプロジェクト相対で残す。
 */
async function exec(projectDir, { cmd, cwd = "." }, config) {
  const r = await runCommand(cmd, { cwd: join(projectDir, cwd), timeoutMs: config.command_timeout_sec * 1000 });
  return { ...r, cwd };
}

/**
 * 基点から変わったファイルを、プロジェクトからの相対パスで返す。プロジェクト外の変更は ../ で始まる。.tasque/ は除く。
 * 既定では作業ツリーまで（未追跡を含む）、committedOnly なら HEAD まで。
 * git はリポジトリのルートで実行し（diff.relative などの設定に左右されないように）、出力は -z（NUL 区切り）で受け取る。
 */
function changedSince(layout, base, { committedOnly = false } = {}) {
  const range = committedOnly ? [base, "HEAD"] : [base];
  const tracked = git(layout.top, ["diff", "--name-only", "--no-renames", "-z", ...range]).split("\0");
  const untracked = committedOnly
    ? []
    : git(layout.top, ["ls-files", "--others", "--exclude-standard", "-z"]).split("\0");
  return [...new Set([...tracked, ...untracked])]
    .filter(Boolean)
    .map(layout.toRel)
    .filter((f) => !f.startsWith(".tasque/"))
    .sort();
}

/**
 * 基点から消えた追跡済みのファイルを、プロジェクトからの相対パスで返す。範囲の考え方は changedSince と同じ。
 */
function deletedSince(layout, base, { committedOnly = false } = {}) {
  const range = committedOnly ? [base, "HEAD"] : [base];
  return git(layout.top, ["diff", "--name-only", "--no-renames", "--diff-filter=D", "-z", ...range])
    .split("\0")
    .filter(Boolean)
    .map(layout.toRel)
    .filter((f) => !f.startsWith(".tasque/"))
    .sort();
}

function deletedNote(deleted) {
  return deleted.length > 0 ? `（ほかに削除 ${deleted.length} ファイル。上限には数えない）` : "";
}

/**
 * 追加行＋削除行と、ファイル数。diff_exclude に一致するファイルと skip（契約どおりに消したファイル）はどちらにも数えない。
 * git がバイナリとみなしたファイル（numstat が "-"。.gitattributes の -diff を含む）は、変更前と変更後の行数の合計を変更行数とみなす。
 * textconv や外部 diff で行数を小さく見せられないよう、どちらも無効にする。
 */
function diffSize(projectDir, layout, base, changed, exclude, { committedOnly = false, skip = [] } = {}) {
  const counted = changed.filter((f) => !matchesAny(f, exclude) && !skip.includes(f));
  const range = committedOnly ? [base, "HEAD"] : [base];
  const numstat = new Map();
  const out = git(layout.top, ["diff", "--numstat", "--no-renames", "--no-textconv", "--no-ext-diff", "-z", ...range]);
  for (const record of out.split("\0")) {
    const m = /^(\d+|-)\t(\d+|-)\t(.+)$/s.exec(record);
    if (!m) continue;
    const [, add, del, file] = m;
    const binary = add === "-" || del === "-";
    numstat.set(layout.toRel(file), binary ? null : Number(add) + Number(del));
  }
  let lines = 0;
  for (const f of counted) {
    const n = numstat.get(f);
    if (n != null) lines += n;
    else if (numstat.has(f)) {
      const repoPath = layout.toRepo(f);
      const after = committedOnly ? blobAt(layout.top, "HEAD", repoPath) : readIfExists(join(projectDir, f));
      lines += countLines(blobAt(layout.top, base, repoPath)) + countLines(after);
    } else lines += countLines(readIfExists(join(projectDir, f)));
  }
  return { lines, files: counted.length };
}

function readIfExists(file) {
  try {
    return readFileSync(file, "utf8");
  } catch {
    return "";
  }
}

/**
 * rev 時点のファイルの中身（textconv などを通さない生の blob）。その時点で存在しなければ空文字列。
 */
function blobAt(top, rev, repoPath) {
  const r = spawnSync("git", ["cat-file", "blob", `${rev}:${repoPath}`], { cwd: top, encoding: "utf8", maxBuffer: 1 << 30 });
  return r.status === 0 ? r.stdout : "";
}

function countLines(text) {
  if (text === "") return 0;
  return text.split("\n").length - (text.endsWith("\n") ? 1 : 0);
}

/**
 * ファイルが git の管理下にあり、HEAD から変わっていないか。
 */
function isTracked(projectDir, file, dirty) {
  const r = spawnSync("git", ["ls-files", "--error-unmatch", "--", file], { cwd: projectDir });
  return r.status === 0 && !dirty.some((f) => samePath(f, file));
}

function sameList(a, b) {
  return a.length === b.length && a.every((x, i) => x === b[i]);
}

/**
 * 変更で増えた（または残っている）ファイルの名前が、どの OS でも扱えるかを確かめる。消したファイルは問わない。
 * ガードを通らずに書かれたファイル（受け入れコマンドの生成物など）もここで止める。
 */
function portableNamesCheck(projectDir, changed) {
  const bad = changed
    .filter((f) => !isOutsideProject(f) && existsSync(join(projectDir, f)))
    .map((f) => [f, portablePathError(f)])
    .filter(([, error]) => error !== null);
  return check("portable_names", bad.length === 0, bad.map(([f, e]) => `${f}: ${e}`).join(", "));
}

function check(name, ok, detail = "", command = undefined) {
  return command ? { name, ok, detail, command } : { name, ok, detail };
}

function finish(run, task, phase, checks) {
  return { run, task, phase, ok: checks.every((c) => c.ok), checks };
}

function statePath(projectDir, run, taskId) {
  return taskFile(projectDir, run, taskId, ".state.json");
}

function writeState(projectDir, run, taskId, state) {
  const file = statePath(projectDir, run, taskId);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(state, null, 2) + "\n", { flag: "wx" });
}

/**
 * post の試行を .tasque/runs/<run>/tasks/<id>.post-history.json（配列）に1件追記する。ファイルがなければ作る。
 * post.json は毎回上書きされるため、何回落ちたかはこの履歴で残す。
 */
function appendPostHistory(projectDir, run, taskId, entry) {
  const file = taskFile(projectDir, run, taskId, ".post-history.json");
  const history = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : [];
  history.push(entry);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(history, null, 2) + "\n");
}

function readState(projectDir, run, taskId) {
  const file = statePath(projectDir, run, taskId);
  if (!existsSync(file)) throw new Error(`${taskId} は pre の検査を通っていない`);
  return JSON.parse(readFileSync(file, "utf8"));
}

function save(projectDir, run, name, result) {
  const file = join(runPaths(projectDir, run).dir, "tasks", `${name}.json`);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(result, null, 2) + "\n");
  return result;
}
