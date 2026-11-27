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
  return { request, notify, close: () => child.kill() };
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
