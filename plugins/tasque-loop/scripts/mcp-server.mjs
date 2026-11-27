// stdio の MCP サーバー（.mcp.json の fs）。planner と implementer に、誤って作ったファイルを消すツールを1つだけ渡す。
// 1行1メッセージの JSON-RPC 2.0 を読み書きする。消してよいパスかの判定は PreToolUse のガード（guard.mjs）が行い、
// ここでは未追跡のファイルしか消さないことだけを確かめる（lib/discard.mjs）。
import { createInterface } from "node:readline";
import { discardFile } from "./lib/discard.mjs";

/** 対応するプロトコルの版。新しい順。クライアントの版が一覧になければ先頭を返す。 */
const PROTOCOL_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];

const TOOLS = [
  {
    name: "delete_file",
    description:
      "自分が誤って作った、git 未追跡のファイルを1つ消す。file_path は絶対パスで指定する。" +
      "git の管理下にある（コミット済み・ステージ済みの）ファイルとディレクトリは消せない。",
    inputSchema: {
      type: "object",
      properties: { file_path: { type: "string", description: "消すファイルの絶対パス" } },
      required: ["file_path"],
      additionalProperties: false,
    },
  },
];

const send = (msg) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...msg }) + "\n");
const text = (t, isError = false) => ({ content: [{ type: "text", text: t }], ...(isError ? { isError: true } : {}) });

/**
 * リクエスト1件への結果を返す。未対応のメソッドは JSON-RPC のエラーにする。
 */
function handle(method, params) {
  switch (method) {
    case "initialize":
      return {
        result: {
          protocolVersion: PROTOCOL_VERSIONS.includes(params?.protocolVersion)
            ? params.protocolVersion
            : PROTOCOL_VERSIONS[0],
          capabilities: { tools: {} },
          serverInfo: { name: "tasque-loop-fs", version: "1.0.0" },
        },
      };
    case "ping":
      return { result: {} };
    case "tools/list":
      return { result: { tools: TOOLS } };
    case "tools/call":
      return { result: callTool(params?.name, params?.arguments ?? {}) };
    default:
      return { error: { code: -32601, message: `未対応のメソッド: ${method}` } };
  }
}

/**
 * ツールの実行。失敗はプロトコルのエラーではなく、理由つきの isError の結果として返す。
 */
function callTool(name, args) {
  if (name !== "delete_file") return text(`未知のツール: ${name}`, true);
  try {
    return text(discardFile(args?.file_path));
  } catch (e) {
    return text(e.message, true);
  }
}

createInterface({ input: process.stdin }).on("line", (line) => {
  if (line.trim() === "") return;
  let req;
  try {
    req = JSON.parse(line);
  } catch {
    return send({ id: null, error: { code: -32700, message: "JSON として読めない" } });
  }
  if (typeof req !== "object" || req === null || req.id === undefined || req.id === null) return;
  try {
    send({ id: req.id, ...handle(req.method, req.params) });
  } catch (e) {
    send({ id: req.id, error: { code: -32603, message: e.message } });
  }
});
