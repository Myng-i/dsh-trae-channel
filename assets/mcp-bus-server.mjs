#!/usr/bin/env node
/**
 * mcp-bus-server.mjs — DSH ⇄ TRAE 共享总线（MCP server，零依赖）
 *
 * 传输：stdio（默认，MCP 2025-06-18 换行分隔 JSON-RPC）
 *       --http <port> 同一端口提供三种端点：POST /（Streamable HTTP 单发）
 *                     GET /sse（legacy HTTP+SSE 下行）、POST /messages?sessionId=（SSE 上行）
 * 状态：<BUS_DIR>/state.json（原子写 + 文件锁），<BUS_DIR>/events.jsonl 追加审计
 * 存储逻辑在 bus-store.mjs，与 bus-cli.mjs 共用同一份真相。
 *
 * 用法：
 *   node mcp-bus-server.mjs                 # stdio，给 MCP 客户端（TRAE / DSH / Claude 等）拉起
 *   node mcp-bus-server.mjs --http 8788     # 本地 HTTP，跨进程/跨机用
 *   BUS_DIR=/path/to/bus node mcp-bus-server.mjs
 */
import http from "node:http";
import readline from "node:readline";
import { BUS_DIR, TOOLS, callTool, readState } from "./bus-store.mjs";

const PROTOCOL = "2025-06-18";
const SERVER_INFO = { name: "dsh-trae-bus", version: "1.0.0" };
async function handle(msg) {
  const { id, method, params } = msg || {};
  const reply = (result) => ({ jsonrpc: "2.0", id, result });
  const fail = (code, message) => ({ jsonrpc: "2.0", id, error: { code, message } });
  switch (method) {
    case "initialize":
      return reply({
        protocolVersion: PROTOCOL,
        capabilities: { tools: { listChanged: false }, resources: { listChanged: false } },
        serverInfo: SERVER_INFO,
        instructions: "DSH ⇄ TRAE 共享任务总线。先 bus_list_tasks 看有没有活，bus_claim_task 领活，bus_complete_task 交活；决策写 bus_note_write。"
      });
    case "notifications/initialized":
    case "notifications/cancelled":
      return null;
    case "ping":
      return reply({});
    case "tools/list":
      return reply({ tools: TOOLS });
    case "tools/call": {
      if (!params || !params.name) return fail(-32602, "missing tool name");
      return reply(await callTool(params.name, params.arguments));
    }
    case "resources/list":
      return reply({ resources: [{ uri: "bus://state", name: "bus-state", mimeType: "application/json", description: "总线全量状态（任务与笔记）" }] });
    case "resources/read": {
      if (params?.uri !== "bus://state") return fail(-32602, "unknown resource");
      return reply({ contents: [{ uri: "bus://state", mimeType: "application/json", text: JSON.stringify(readState(), null, 2) }] });
    }
    case "prompts/list":
      return reply({ prompts: [] });
    default:
      return fail(-32601, "Method not found: " + method);
  }
}

const args = process.argv.slice(2);
const httpIdx = args.indexOf("--http");
const sseIdx = args.indexOf("--sse");

if (httpIdx >= 0 || sseIdx >= 0) {
  const port = Number(args[httpIdx >= 0 ? httpIdx + 1 : sseIdx + 1]) || 8788;
  /** legacy HTTP+SSE: sessionId -> res (open event stream) */
  const sseSessions = new Map();

  const srv = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    const cors = {
      "access-control-allow-origin": "*",
      "access-control-allow-headers": "content-type, mcp-session-id",
      "access-control-allow-methods": "GET, POST, OPTIONS"
    };

    if (req.method === "OPTIONS") { res.writeHead(204, cors); res.end(); return; }

    // ---- legacy HTTP+SSE: GET /sse ----
    if (req.method === "GET" && (url.pathname === "/sse" || url.pathname === "/mcp")) {
      const sid = Math.random().toString(36).slice(2);
      res.writeHead(200, { ...cors, "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
      res.write("event: endpoint\ndata: /messages?sessionId=" + sid + "\n\n");
      sseSessions.set(sid, res);
      const ka = setInterval(() => { try { res.write(": keepalive\n\n"); } catch {} }, 15000);
      req.on("close", () => { clearInterval(ka); sseSessions.delete(sid); });
      return;
    }

    // ---- legacy HTTP+SSE: POST /messages?sessionId=... ----
    if (req.method === "POST" && (url.pathname === "/messages" || url.pathname === "/message")) {
      let body = "";
      for await (const c of req) body += c;
      const sid = url.searchParams.get("sessionId");
      const stream = sid ? sseSessions.get(sid) : null;
      if (!stream) { res.writeHead(404, cors); res.end("unknown sessionId"); return; }
      let out;
      try { out = await handle(JSON.parse(body)); } catch { out = { jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } }; }
      res.writeHead(202, cors); res.end("accepted");
      if (out) stream.write("event: message\ndata: " + JSON.stringify(out) + "\n\n");
      return;
    }

    // ---- Streamable HTTP / single-shot: POST / ----
    if (req.method === "POST") {
      let body = "";
      for await (const c of req) body += c;
      let out;
      try { out = await handle(JSON.parse(body)); } catch { out = { jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } }; }
      res.writeHead(out ? 200 : 202, { ...cors, "content-type": "application/json" });
      res.end(out ? JSON.stringify(out) : "");
      return;
    }

    res.writeHead(405, cors); res.end("POST JSON-RPC, GET /sse");
  });

  srv.listen(port, "127.0.0.1", () => console.error(
    "[bus] HTTP ready on http://127.0.0.1:" + port +
    "  (POST / = JSON-RPC, GET /sse = legacy SSE, POST /messages = SSE 上行)  bus dir: " + BUS_DIR
  ));
} else {
  const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  rl.on("line", async (line) => {
    const s = line.trim();
    if (!s) return;
    let msg;
    try { msg = JSON.parse(s); } catch { process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } }) + "\n"); return; }
    const out = await handle(msg);
    if (out) process.stdout.write(JSON.stringify(out) + "\n");
  });
  rl.on("close", () => process.exit(0));
  console.error("[bus] stdio MCP server ready (bus dir: " + BUS_DIR + ")");
}

