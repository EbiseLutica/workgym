import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { DiscardError, discardFile } from "../scripts/lib/discard.mjs";
import { makeRepo } from "./helpers.mjs";

test("未追跡のファイルは消せる", () => {
  const { dir, put } = makeRepo();
  put("src/oops.js", "x\n");
  assert.match(discardFile(join(dir, "src", "oops.js")), /消した/);
  assert.equal(existsSync(join(dir, "src", "oops.js")), false);
});

test("追跡済み・ステージ済みのファイルは消さない", () => {
  const { dir, put, git } = makeRepo();
  assert.throws(() => discardFile(join(dir, "README.md")), DiscardError);
  put("src/staged.js", "x\n");
  git("add", "src/staged.js");
  assert.throws(() => discardFile(join(dir, "src", "staged.js")), /git の管理下/);
  assert.ok(existsSync(join(dir, "README.md")));
  assert.ok(existsSync(join(dir, "src", "staged.js")));
});

test("相対パス・存在しないパス・ディレクトリは消さない", () => {
  const { dir, put } = makeRepo();
  put("src/a.js", "x\n");
  mkdirSync(join(dir, "empty"));
  assert.throws(() => discardFile("src/a.js"), /絶対パス/);
  assert.throws(() => discardFile(join(dir, "nope.js")), /存在しない/);
  assert.throws(() => discardFile(join(dir, "empty")), /通常のファイル/);
  assert.ok(existsSync(join(dir, "src", "a.js")));
});

test("大文字小文字を変えた名前でも追跡済みのファイルは消さない", () => {
  const { dir, put, git } = makeRepo();
  put("src/Foo.ts", "x\n");
  git("add", "src/Foo.ts");
  git("commit", "-q", "-m", "foo");
  // 大文字小文字を区別するファイルシステムでは FOO.TS は別のファイルなので、作ってから確かめる
  if (!existsSync(join(dir, "src", "FOO.TS"))) put("src/FOO.TS", "y\n");
  assert.throws(() => discardFile(join(dir, "src", "FOO.TS")), /git の管理下/);
  assert.ok(existsSync(join(dir, "src", "Foo.ts")));
});

test("短い名前（8.3 形式）でも追跡済みのファイルは消さない", { skip: process.platform !== "win32" }, (t) => {
  const { dir, put, git } = makeRepo();
  put("src/LongFileName.ts", "x\n");
  git("add", "src/LongFileName.ts");
  git("commit", "-q", "-m", "long");
  const short = join(dir, "src", "LONGFI~1.TS");
  if (!existsSync(short)) return t.skip("このボリュームでは短い名前が作られない");
  assert.throws(() => discardFile(short), /git の管理下/);
  assert.ok(existsSync(join(dir, "src", "LongFileName.ts")));
});

test("代替データストリームや末尾のドット・空白を含むパスは消さない", () => {
  const { dir } = makeRepo();
  for (const p of [`${join(dir, "README.md")}:hidden`, `${join(dir, "README.md")}.`, `${join(dir, "README.md")} `]) {
    assert.throws(() => discardFile(p), /別名/, p);
  }
  assert.ok(existsSync(join(dir, "README.md")));
});

test("worktree の .git ファイルは未追跡でも消さない", () => {
  const { dir, put } = makeRepo();
  put("sub/.git", "gitdir: elsewhere\n");
  assert.throws(() => discardFile(join(dir, "sub", ".git")), /git の管理用/);
  assert.ok(existsSync(join(dir, "sub", ".git")));
});

/**
 * MCP サーバーを起動し、リクエストを1件ずつ送って応答を受け取る。
 */
function startServer() {
  const child = spawn("node", [fileURLToPath(new URL("../scripts/mcp-server.mjs", import.meta.url))], {
    stdio: ["pipe", "pipe", "inherit"],
  });
  const pending = new Map();
  createInterface({ input: child.stdout }).on("line", (line) => {
    const msg = JSON.parse(line);
    pending.get(msg.id)?.(msg);
  });
  let id = 0;
  const request = (method, params) =>
    new Promise((resolve) => {
      id += 1;
      pending.set(id, resolve);
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
  const notify = (method) => child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method }) + "\n");
  const raw = (line) => child.stdin.write(line + "\n");
  return { request, notify, raw, close: () => child.kill() };
}

test("MCP サーバー: 初期化・ツール一覧・削除の呼び出しに応答する", async () => {
  const { dir, put } = makeRepo();
  put("oops.txt", "x\n");
  const server = startServer();
  try {
    const init = await server.request("initialize", { protocolVersion: "2025-06-18", capabilities: {} });
    assert.equal(init.result.protocolVersion, "2025-06-18");
    assert.ok(init.result.capabilities.tools);
    server.notify("notifications/initialized");

    const list = await server.request("tools/list", {});
    assert.deepEqual(list.result.tools.map((t) => t.name), ["delete_file"]);

    const ok = await server.request("tools/call", { name: "delete_file", arguments: { file_path: join(dir, "oops.txt") } });
    assert.equal(ok.result.isError, undefined);
    assert.equal(existsSync(join(dir, "oops.txt")), false);

    const ng = await server.request("tools/call", { name: "delete_file", arguments: { file_path: join(dir, "README.md") } });
    assert.equal(ng.result.isError, true);
    assert.match(ng.result.content[0].text, /git の管理下/);

    const unknown = await server.request("server/discover", {});
    assert.equal(unknown.error.code, -32601);
  } finally {
    server.close();
  }
});

test("MCP サーバー: 未対応の版には自分の版を返し、異常な入力や引数でも落ちない", async () => {
  const server = startServer();
  try {
    const init = await server.request("initialize", { protocolVersion: "1999-01-01", capabilities: {} });
    assert.equal(init.result.protocolVersion, "2025-11-25");
    for (const line of ["null", "42", '"x"', "{ broken"]) server.raw(line);
    const noArgs = await server.request("tools/call", { name: "delete_file" });
    assert.equal(noArgs.result.isError, true);
    assert.match(noArgs.result.content[0].text, /絶対パス/);
    assert.ok((await server.request("ping", {})).result);
  } finally {
    server.close();
  }
});
