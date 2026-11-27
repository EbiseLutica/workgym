import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { canonicalPathError, isInside } from "./paths.mjs";
import { draftDigest, draftPaths, readJson } from "./plan-check.mjs";
import { statusMark } from "./verify.mjs";

export const TEMPLATE = fileURLToPath(new URL("../../viewer/dist/review.html", import.meta.url));
export const DATA_MARKER = "__TASQUE_REVIEW_DATA__";
export const MAX_TEST_BYTES = 200 * 1024;

const LANGUAGES = {
  ".js": "javascript",
  ".mjs": "javascript",
  ".cjs": "javascript",
  ".jsx": "javascript",
  ".ts": "typescript",
  ".mts": "typescript",
  ".cts": "typescript",
  ".tsx": "typescript",
  ".py": "python",
  ".rb": "ruby",
  ".go": "go",
  ".rs": "rust",
  ".java": "java",
  ".kt": "kotlin",
  ".kts": "kotlin",
  ".cs": "csharp",
  ".swift": "swift",
  ".php": "php",
  ".c": "c",
  ".h": "c",
  ".cpp": "cpp",
  ".cc": "cpp",
  ".hpp": "cpp",
  ".sh": "bash",
  ".bash": "bash",
  ".ps1": "powershell",
  ".json": "json",
  ".yaml": "yaml",
  ".yml": "yaml",
  ".toml": "ini",
  ".ini": "ini",
  ".xml": "xml",
  ".html": "xml",
  ".vue": "xml",
  ".css": "css",
  ".scss": "scss",
  ".sql": "sql",
  ".md": "markdown",
  ".lua": "lua",
  ".pl": "perl",
  ".r": "r",
};

/**
 * 人間のレビュー用に、契約の下書き・検査結果・Red 確認の結果・テストファイルの中身を1つのデータにまとめる。
 * 下書きを読めなければ error に理由を入れて返す（ビューアはそれを表示する）。
 * テストファイルは、下書きの検査を通る正規形のパスで、プロジェクトの中にあるものだけを読む。
 */
export function collectReviewData(projectDir, { now = new Date() } = {}) {
  const paths = draftPaths(projectDir);
  const check = readJson(paths.check);
  const red = readJson(paths.red);
  const base = {
    version: 1,
    generated_at: now.toISOString(),
    integrity: { draft: draftDigest(projectDir), check: check?.digest ?? null, red: red?.digest ?? null },
    check: check ? { ok: check.ok === true, errors: check.errors ?? [] } : null,
    red: red ? { warnings: red.warnings ?? [] } : null,
  };

  let plan;
  try {
    plan = JSON.parse(readFileSync(paths.draft, "utf8"));
  } catch (e) {
    return { ...base, run: null, request: null, base: null, tasks: [], error: `.tasque/plan.draft.json: ${e.message}` };
  }

  const tasks = (Array.isArray(plan.tasks) ? plan.tasks : []).map((task) => {
    const results = (red?.results ?? []).filter((r) => r.task === task.id);
    return {
      ...task,
      acceptance: (Array.isArray(task.acceptance) ? task.acceptance : []).map((a, i) => ({
        ...a,
        result: results[i]?.cmd === a.cmd ? redResult(results[i]) : null,
      })),
      tests: (Array.isArray(task.tests) ? task.tests : []).map((t) => readTest(projectDir, t)),
    };
  });
  return { ...base, run: plan.run ?? null, request: plan.request ?? null, base: plan.base ?? null, tasks };
}

/**
 * ビューアのテンプレートにデータを埋め込んだ HTML を返す。
 * データは <script type="application/json"> の中に入るので、< をすべてエスケープして </script> で抜けられないようにする。
 */
export function renderReviewPage(data, template = readFileSync(TEMPLATE, "utf8")) {
  const parts = template.split(DATA_MARKER);
  if (parts.length !== 2) throw new Error(`ビューアのテンプレートに ${DATA_MARKER} がちょうど1つない`);
  const json = JSON.stringify(data).replaceAll("<", "\\u003c");
  return parts[0] + json + parts[1];
}

/**
 * プロジェクトのレビュー用ページを .tasque/tmp/review.html に書き、そのパスを返す。
 */
export function writeReviewPage(projectDir, options = {}) {
  const file = join(projectDir, ".tasque", "tmp", "review.html");
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, renderReviewPage(collectReviewData(projectDir, options), options.template));
  return file;
}

function redResult(r) {
  return { status: r.status, mark: statusMark(r), cwd: r.cwd, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

function readTest(projectDir, path) {
  const entry = { path, language: LANGUAGES[extname(String(path)).toLowerCase()] ?? null };
  if (typeof path !== "string" || canonicalPathError(path, { glob: false }) !== null) {
    return { ...entry, missing: true };
  }
  const file = join(projectDir, path);
  if (!existsSync(file) || !statSync(file).isFile() || !isInside(projectDir, file)) return { ...entry, missing: true };
  const body = readFileSync(file);
  const truncated = body.length > MAX_TEST_BYTES;
  return { ...entry, content: body.subarray(0, MAX_TEST_BYTES).toString("utf8"), truncated };
}
