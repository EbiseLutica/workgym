import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { canonicalPathError } from "./paths.mjs";

export const CONFIG_FILE = "tasque.config.json";

/**
 * プロジェクト設定の既定値。プロジェクトルートの tasque.config.json で上書きする。
 * - test_cmd: プロジェクト全体のテストを走らせるコマンド。文字列か { cmd, cwd }（cwd はプロジェクト相対）。
 *   null なら全体テストは走らせない
 * - diff_exclude: diff 量の計算から外すパス（lockfile、生成物など）。スコープ照合からは外さない
 * - command_timeout_sec: 受け入れコマンドや全体テスト1本あたりのタイムアウト
 * - pr: PR 前のサイズゲートの上限
 */
export const DEFAULTS = {
  test_cmd: null,
  diff_exclude: [],
  command_timeout_sec: 600,
  pr: { max_lines: 500, max_files: 10 },
};

export function loadConfig(projectDir) {
  const file = join(projectDir, CONFIG_FILE);
  if (!existsSync(file)) return structuredClone(DEFAULTS);
  const user = JSON.parse(readFileSync(file, "utf8"));
  const config = { ...DEFAULTS, ...user, pr: { ...DEFAULTS.pr, ...(user.pr ?? {}) } };
  testCommand(config);
  return config;
}

/**
 * 設定の test_cmd を { cmd, cwd } にそろえて返す。未設定なら null。cwd はプロジェクト相対で、省略時は "."。
 * 形式が不正なら例外。
 */
export function testCommand(config) {
  const t = config.test_cmd;
  if (t === null || t === undefined) return null;
  if (typeof t === "string" && t.trim() !== "") return { cmd: t, cwd: "." };
  if (typeof t === "object" && typeof t.cmd === "string" && t.cmd.trim() !== "") {
    if (t.cwd === undefined) return { cmd: t.cmd, cwd: "." };
    const msg = typeof t.cwd === "string" ? canonicalPathError(t.cwd, { glob: false }) : "文字列が必要";
    if (msg) throw new Error(`${CONFIG_FILE}: test_cmd.cwd ${t.cwd}: ${msg}`);
    return { cmd: t.cmd, cwd: t.cwd };
  }
  throw new Error(`${CONFIG_FILE}: test_cmd は文字列か { "cmd": ..., "cwd": ... } にする`);
}
