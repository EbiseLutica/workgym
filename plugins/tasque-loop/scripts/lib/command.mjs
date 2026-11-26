import { spawn } from "node:child_process";

export const OUTPUT_TAIL = 2000;
export const MAX_BUFFER = 64 * 1024 * 1024;

/**
 * コマンドの実行結果の分類。
 * - pass: exit 0
 * - fail: 通常の非ゼロ終了（テストが落ちた）
 * - broken: コマンドが見つからない（exit 127、cmd.exe の 9009）、起動できない、出力が多すぎる、こちらが送っていないシグナルで終了した
 * - timeout: タイムアウトでプロセスツリーごと止めた
 */
export const STATUSES = ["pass", "fail", "broken", "timeout"];

const NOT_FOUND_EXITS = [127, 9009];

/**
 * シェル経由でコマンドを実行し、結果を返す。例外は投げない。
 * タイムアウトや出力の上限超過では、孫プロセスが残らないようプロセスツリーごと止める
 * （Windows は taskkill /T、それ以外はプロセスグループへの SIGKILL）。
 * 標準出力と標準エラーは、それぞれ末尾 OUTPUT_TAIL 文字だけを残す。
 * Windows では cmd.exe /c がコマンド未検出でも 1 を返すため、末尾に `& exit` を付けて ERRORLEVEL（9009）をそのまま返させる。
 */
export function runCommand(cmd, { cwd, timeoutMs, maxBuffer = MAX_BUFFER }) {
  return new Promise((resolve) => {
    const posixGroup = process.platform !== "win32";
    const out = { text: "", bytes: 0 };
    const err = { text: "", bytes: 0 };
    let child;
    let timer;
    let timedOut = false;
    let overflow = false;
    let error = null;
    let exited = false;
    let settled = false;
    let exit = null;
    let signal = null;
    const started = Date.now();

    const settle = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child?.stdout?.destroy();
      child?.stderr?.destroy();
      resolve(
        describe({ cmd, cwd, exit, signal, error, timedOut, overflow, stdout: out.text, stderr: err.text, ms: Date.now() - started }),
      );
    };

    const stop = async () => {
      await killTree(child, posixGroup);
      if (exited) settle();
    };

    try {
      child = spawn(posixGroup ? cmd : `${cmd} & exit`, {
        cwd,
        shell: true,
        detached: posixGroup,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (e) {
      error = { code: e.code ?? null, message: e.message };
      return settle();
    }

    timer = setTimeout(() => {
      timedOut = true;
      stop();
    }, timeoutMs);

    const collect = (stream, buf) => {
      stream.setEncoding("utf8");
      stream.on("data", (chunk) => {
        buf.bytes += Buffer.byteLength(chunk);
        buf.text = (buf.text + chunk).slice(-OUTPUT_TAIL);
        if (buf.bytes > maxBuffer && !overflow) {
          overflow = true;
          error = { code: "ENOBUFS", message: `出力が ${maxBuffer} バイトを超えた` };
          stop();
        }
      });
    };
    collect(child.stdout, out);
    collect(child.stderr, err);

    child.on("error", (e) => {
      error = { code: e.code ?? null, message: e.message };
      if (child.pid === undefined) settle();
    });
    child.on("exit", (code, sig) => {
      exited = true;
      exit = code;
      signal = sig;
      // 止めたあとは、パイプを握ったまま残った子孫を待たずに終える
      if (timedOut || overflow) settle();
    });
    child.on("close", settle);
  });
}

function describe({ cmd, cwd, exit, signal, error, timedOut, overflow, stdout, stderr, ms }) {
  let status;
  if (timedOut) status = "timeout";
  else if (overflow || error || signal || NOT_FOUND_EXITS.includes(exit)) status = "broken";
  else status = exit === 0 ? "pass" : "fail";
  return { cmd, cwd, status, ok: status === "pass", exit, signal, error, duration_ms: ms, stdout, stderr };
}

/**
 * プロセスツリーごと止める。失敗しても例外は投げない（すでに終わっている場合など）。
 */
function killTree(child, posixGroup) {
  if (!child?.pid) return Promise.resolve();
  if (posixGroup) {
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {
      try {
        child.kill("SIGKILL");
      } catch {}
    }
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    const k = spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
    k.on("error", () => {
      try {
        child.kill();
      } catch {}
      resolve();
    });
    k.on("exit", () => resolve());
  });
}
