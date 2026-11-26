import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { OUTPUT_TAIL, runCommand } from "../scripts/lib/command.mjs";

const cwd = () => mkdtempSync(join(tmpdir(), "tasque-cmd-"));

test("終了コードで pass と fail を分け、標準出力と標準エラーを別々に残す", async () => {
  const dir = cwd();
  const ok = await runCommand("node -e \"console.log('out'); console.error('err')\"", { cwd: dir, timeoutMs: 10000 });
  assert.deepEqual([ok.status, ok.ok, ok.exit, ok.stdout.trim(), ok.stderr.trim()], ["pass", true, 0, "out", "err"]);
  const ng = await runCommand('node -e "process.exit(3)"', { cwd: dir, timeoutMs: 10000 });
  assert.deepEqual([ng.status, ng.ok, ng.exit], ["fail", false, 3]);
});

test("見つからないコマンドは broken", async () => {
  const r = await runCommand("tasque_no_such_command_xyz", { cwd: cwd(), timeoutMs: 10000 });
  assert.equal(r.status, "broken");
  assert.ok([127, 9009].includes(r.exit), `exit ${r.exit}`);
});

test("出力が上限を超えたら止めて broken（ENOBUFS）にし、末尾だけを残す", async () => {
  const r = await runCommand("node -e \"process.stdout.write('x'.repeat(100000))\"", {
    cwd: cwd(),
    timeoutMs: 10000,
    maxBuffer: 1000,
  });
  assert.equal(r.status, "broken");
  assert.equal(r.error.code, "ENOBUFS");
  assert.ok(r.stdout.length <= OUTPUT_TAIL);
});

test("タイムアウトではプロセスツリーごと止め、孫プロセスを残さない", async () => {
  const dir = cwd();
  writeFileSync(
    join(dir, "parent.mjs"),
    'import { spawn } from "node:child_process";\n' +
      'spawn(process.execPath, ["grand.mjs"], { stdio: "inherit" });\n' +
      "setInterval(() => {}, 1000);\n",
  );
  writeFileSync(
    join(dir, "grand.mjs"),
    'import { writeFileSync } from "node:fs";\n' +
      'setTimeout(() => writeFileSync("survived.txt", "x"), 2500);\n' +
      "setInterval(() => {}, 1000);\n",
  );
  const r = await runCommand("node parent.mjs", { cwd: dir, timeoutMs: 800 });
  assert.equal(r.status, "timeout");
  await sleep(3500);
  assert.equal(existsSync(join(dir, "survived.txt")), false);
});
