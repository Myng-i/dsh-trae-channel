#!/usr/bin/env node
/**
 * mcp-bus-client.mjs — 总线客户端（MCP stdio），DSH 侧用；也能当通用 CLI 调试
 *
 *   node mcp-bus-client.mjs list                      # 列任务
 *   node mcp-bus-client.mjs tools                     # 列工具
 *   node mcp-bus-client.mjs call bus_post_task '{"title":"...","body":"..."}'
 *   node mcp-bus-client.mjs demo                      # 两端 agent 抢单/交付演示
 *   node mcp-bus-client.mjs raw '{"jsonrpc":"2.0","id":9,"method":"ping"}'
 */
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.join(HERE, "mcp-bus-server.mjs");

export class Bus {
  constructor(env = process.env) {
    this.child = spawn(process.execPath, [SERVER], { stdio: ["pipe", "pipe", "inherit"], env });
    this.nextId = 1;
    this.pending = new Map();
    this.buf = "";
    this.child.stdout.on("data", (d) => {
      this.buf += d.toString("utf8");
      let i;
      while ((i = this.buf.indexOf("\n")) >= 0) {
        const line = this.buf.slice(0, i); this.buf = this.buf.slice(i + 1);
        if (!line.trim()) continue;
        let msg; try { msg = JSON.parse(line); } catch { continue; }
        if (msg.id && this.pending.has(msg.id)) { const { resolve } = this.pending.get(msg.id); this.pending.delete(msg.id); resolve(msg); }
      }
    });
  }
  request(method, params) {
    const id = this.nextId++;
    this.child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    return new Promise((resolve) => this.pending.set(id, { resolve }));
  }
  notify(method) { this.child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method }) + "\n"); }
  async init() {
    const r = await this.request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "dsh", version: "1.0.0" } });
    this.notify("notifications/initialized");
    return r.result;
  }
  async call(name, args = {}) {
    const r = await this.request("tools/call", { name, arguments: args });
    if (r.error) throw new Error(r.error.message);
    return r.result;
  }
  close() { try { this.child.stdin.end(); } catch {} try { this.child.kill(); } catch {} }
}

const textOf = (r) => (r?.content || []).map((c) => c.text).join("\n");

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const bus = new Bus();
  try {
    const info = await bus.init();
    if (cmd === "tools" || cmd === "tools-list") {
      const r = await bus.request("tools/list", {});
      console.log(JSON.stringify(r.result.tools.map((t) => ({ name: t.name, desc: t.description.slice(0, 40) })), null, 2));
    } else if (cmd === "list") {
      console.log(textOf(await bus.call("bus_list_tasks", {})));
    } else if (cmd === "stats") {
      console.log(textOf(await bus.call("bus_stats", {})));
    } else if (cmd === "call") {
      const name = rest[0];
      const args = rest[1] ? JSON.parse(rest[1]) : {};
      const r = await bus.call(name, args);
      if (r.isError) { console.error("ERROR:", textOf(r)); process.exitCode = 1; } else console.log(textOf(r));
    } else if (cmd === "demo") {
      console.log("== server:", JSON.stringify(info.serverInfo));
      const post = await bus.call("bus_post_task", { title: "把 src/utils.ts 的 TODO 清掉", body: "只改 utils.ts，跑 npm test 通过为准", agent: "dsh-lead", priority: "high", tags: ["refactor"] });
      const id = JSON.parse(textOf(post)).id;
      console.log("== posted:", id);
      await bus.call("bus_note_write", { key: "decision/scope", text: "只允许动 utils.ts，别碰 index.ts", agent: "dsh-lead" });
      const claim = await bus.call("bus_claim_task", { id, agent: "trae-ide" });
      console.log("== claim:", JSON.parse(textOf(claim)).status);
      const claim2 = await bus.call("bus_claim_task", { id, agent: "dsh-lead" });
      console.log("== 二次抢单(应失败):", claim2.isError ? textOf(claim2) : "UNEXPECTED SUCCESS");
      await bus.call("bus_progress", { id, agent: "trae-ide", note: "已删除 3 处 TODO，正在跑测试" });
      await bus.call("bus_complete_task", { id, agent: "trae-ide", result: "3 处 TODO 清理完毕，npm test 12 passed", artifacts: ["src/utils.ts"] });
      console.log("== notes:", textOf(await bus.call("bus_note_read", {})));
      console.log("== stats:", textOf(await bus.call("bus_stats", {})));
    } else {
      console.log("usage: list|tools|stats|call <tool> [json]|demo|raw");
    }
  } finally { bus.close(); }
}
main().catch((e) => { console.error(e); process.exit(1); });
