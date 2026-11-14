#!/usr/bin/env node
/**
 * bus-cli.mjs — 共享总线的终端入口（零依赖，跨平台）
 *
 * 为什么要有它：MCP 只是"接得上"的一种方式。任何能在终端跑命令的 agent
 * （TRAE 的 agent 模式、Cursor、Claude Code、CI、人）都能用这套 CLI 读写同一块任务板，
 * 不需要 MCP、不需要账号、不需要窗口自动化。
 *
 * 状态与 MCP server 共用 bus-store.mjs ⇒ 同一份 bus/state.json，不存在两套真相。
 *
 * 用法：
 *   node tools/bus-cli.mjs board                       # 任务板（人看）
 *   node tools/bus-cli.mjs post --title "..." [--body "..."] [--as dsh] [--to trae] [--priority high]
 *   node tools/bus-cli.mjs list [--status pending] [--as trae] [--json]
 *   node tools/bus-cli.mjs show T-000001 [--json]
 *   node tools/bus-cli.mjs claim T-000001 --as trae
 *   node tools/bus-cli.mjs progress T-000001 --as trae --note "跑测试中"
 *   node tools/bus-cli.mjs done T-000001 --as trae --result "改完，测试通过" [--artifact path]
 *   node tools/bus-cli.mjs note write --key decision-x --text "..." --as dsh
 *   node tools/bus-cli.mjs note read [--key decision-x]
 *   node tools/bus-cli.mjs poll --as trae [--claim] [--json]        # 只看一次，立刻返回（适合短轮询）
 *   node tools/bus-cli.mjs wait --as trae [--timeout 30] [--claim] [--json]  # 空转 exit 0，--strict 才 exit 1
 *   node tools/bus-cli.mjs post --stdin < task.json                 # 引号/编码不稳时走 stdin
 *   node tools/bus-cli.mjs stats [--json]
 *
 * 退出码：0 成功；1 业务失败（任务不存在/已被领走/不是你的）；2 参数错误（含 to/assignee 冲突）；
 *         5 任务板未初始化（找不到 state.json 或 0 字节，不会自动建板）；6 state.json 损坏（已备份，拒绝写入）。
 */
import fs from "node:fs";
import { resolveWorkspace, loadLedger, markKnocked, corruptionNote } from "./knock-ledger.mjs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));

// --bus <dir>：调用方 cwd 不在任务板所在工作区时用（TRAE 被叫醒时常见）。
// bus-store 的 BUS_DIR 是导入期常量，所以在解析参数前用 re-exec 把它注入子进程环境。
{
  const rest = process.argv.slice(2);
  const bi = rest.indexOf("--bus");
  if (bi >= 0) {
    const raw = rest[bi + 1];
    if (!raw || raw.startsWith("--")) { console.error("[bus] --bus 需要目录，例如 --bus <工作区>/bus"); process.exit(2); }
    const target = path.resolve(raw);
    const cur = process.env.BUS_DIR ? path.resolve(process.env.BUS_DIR) : "";
    const strip = [...rest.slice(0, bi), ...rest.slice(bi + 2)];
    if (cur.toLowerCase() !== target.toLowerCase()) {
      // 环境里没有 BUS_DIR，或指向别处：re-exec 一次把目标注入（子进程 argv 里已没有 --bus）
      const r = spawnSync(process.execPath, [fileURLToPath(import.meta.url), ...strip], {
        stdio: "inherit", env: { ...process.env, BUS_DIR: target },
      });
      process.exit(r.status === null ? 1 : r.status);
    }
    // 环境已指向同一块板：只把 --bus 从 argv 里剔除，照常往下跑
    process.argv = [process.argv[0], process.argv[1], ...strip];
  }
}

// 敲门（CDP）：只发「引用任务号」的提醒，不承载需求正文。
// --wake 让「建任务」与「叫人」同步完成，避免「先叫人、后建任务」导致对方当场查板为空。
function knockTrae({ id, title, assignee, poster }) {
  if (String(poster || "").toLowerCase() === String(assignee || "").toLowerCase() && assignee) {
    console.error("[bus] 这是派给自己的任务（" + poster + " → " + assignee + "），跳过敲门");
    return;
  }
  if (process.env.BUS_DIR && opt("wake-force") === undefined) {
    console.error("[bus] 隔离任务板（BUS_DIR=" + BUS_DIR + "）默认不敲门：CDP 提醒是全局的，这里的任务号对方板子上没有。要试敲门加 --wake-force。任务已落盘。");
    return;
  }
  const WS = resolveWorkspace(BUS_DIR);
  const lg = loadLedger(WS);
  if (lg.status === "corrupt") { console.error(corruptionNote(lg)); return "corrupt"; }
  if (lg.ids.includes(id)) {
    console.error("[bus] " + id + " 已通知过，跳过重复敲门（要重发先删 watch/knock-notified.json）");
    return;
  }
  // 绝对路径 + 可复制命令：收信方 cwd 可能不在本工作区，相对命令会读错板子。
  const self = path.join(HERE, "bus-cli.mjs");
  const text = "【DSH 叫醒】新任务 " + id + "（" + (assignee || "未指派") + "）：" + String(title).slice(0, 60) +
    "。任务板：\"" + BUS_DIR + "\"；领取：node \"" + self + "\" poll --as trae-ide --claim --bus \"" + BUS_DIR + "\"。" +
    "请以此绝对路径为准，不要用你自己 cwd 下的 bus/；正文与验收标准在任务板上。";
  if (process.env.BUS_WAKE_DRY === "1") { console.log("[wake] would knock: " + text); return; }
  const inj = path.join(HERE, "trae-inject.mjs");
  if (!fs.existsSync(inj)) { console.error("[bus] 未找到 trae-inject.mjs，跳过敲门（任务已落盘）"); return; }
  const r = spawnSync(process.execPath, [inj, "send", "--text", text], { encoding: "utf8", timeout: 60000 });
  if (r.status === 0) { markKnocked(WS, id); console.error("[bus] 已叫醒 TRAE（" + id + "）"); }
  else console.error("[bus] 敲门失败（exit " + r.status + "）：任务已落盘，对方下一轮仍能领到");
}

import { callTool, readStateStrict, initState, BusError, STATE, BUS_DIR } from "./bus-store.mjs";

const argv = process.argv.slice(2);
const cmd = argv[0];
const rest = argv.slice(1);

function opt(name, dflt = undefined) {
  const i = rest.indexOf("--" + name);
  if (i < 0) return dflt;
  const v = rest[i + 1];
  if (v === undefined || v.startsWith("--")) return true;
  return v;
}
function multi(name) {
  const out = [];
  for (let i = 0; i < rest.length; i++) if (rest[i] === "--" + name) {
    const v = rest[i + 1];
    if (v && !v.startsWith("--")) out.push(v);
  }
  return out;
}
const positional = rest.filter((a, i) => !a.startsWith("--") && !(i > 0 && rest[i - 1].startsWith("--")));

const USAGE = [
  "用法：node tools/bus-cli.mjs <命令> [选项]",
  "  board                              看任务板",
  "  post --title \"…\" [--body \"…\" | --body-file <文件> | --stdin] [--as 身份] [--to 执行方] [--accept \"验收标准\"]",
  "  list [--status pending] [--as 身份] [--json]",
  "  show T-000001 [--json]",
  "  claim T-000001 --as 身份",
  "  progress T-000001 --as 身份 --note \"…\"",
  "  done T-000001 --as 身份 --result \"…\" [--artifact 路径]",
  "  note write --key k --text \"…\" --as 身份 | note read [--key k]",
  "  poll --as 身份 [--claim] [--json]      # 只看一次，立刻返回",
  "  wait --as 身份 [--timeout 30] [--claim] [--strict]",
  "  stats [--json] | init [--force]",
  "退出码：0 成功 / 1 业务失败 / 2 参数错 / 5 未初始化 / 6 state.json 损坏",
].join("\n");
if (rest.includes("--help") || rest.includes("-h") || argv.includes("--help")) { console.log(USAGE); process.exit(0); }

function emit(res, asJson) {
  const text = (res.content || []).map((c) => c.text).join("\n");
  if (res.isError) { console.error(text); process.exit(res.code || 1); }
  if (asJson) { console.log(text); return; }
  try { console.log(pretty(JSON.parse(text))); } catch { console.log(text); }
}
function pretty(v) {
  if (v && Array.isArray(v.tasks)) {
    const lines = ["total " + v.total + ", showing " + v.showing];
    for (const t of v.tasks) lines.push(row(t));
    return lines.join("\n");
  }
  if (v && v.id && v.title) return row(v) + (v.body ? "\n  body: " + v.body : "") + (v.result ? "\n  result: " + v.result : "");
  return JSON.stringify(v, null, 2);
}
function row(t) {
  const who = t.claimed_by || t.assignee || "-";
  return [t.id, pad(t.status, 11), pad(t.priority || "normal", 6), pad(who, 12), t.title].join("  ");
}
function pad(s, n) { s = String(s); return s + " ".repeat(Math.max(0, n - s.length)); }

const as = opt("as", process.env.BUS_AGENT || "cli");

/** 读命令用：未初始化 exit 5，损坏 exit 6（并已备份），绝不显示空板。 */
function loadOrExit() {
  try { return readStateStrict(); }
  catch (e) {
    if (e instanceof BusError) { console.error(e.message); process.exit(e.code); }
    throw e;
  }
}

switch (cmd) {
  case "board": {
    const st = loadOrExit();
    const order = { pending: 0, claimed: 1, in_progress: 2, done: 3, failed: 4 };
    const tasks = [...st.tasks].sort((a, b) => (order[a.status] - order[b.status]) || a.created_at.localeCompare(b.created_at));
    console.log("BUS  " + st.tasks.length + " tasks");
    console.log(pad("id", 10) + "  " + pad("status", 11) + "  " + pad("prio", 6) + "  " + pad("owner", 12) + "  title");
    for (const t of tasks) console.log(row(t));
    const notes = Object.keys(st.notes || {});
    if (notes.length) console.log("\nnotes: " + notes.join(", "));
    break;
  }
  case "init": {
    try {
      const r = initState(!!opt("force"));
      console.log((r.created ? "initialized: " : "already initialized: ") + r.path + (r.created ? "" : "  (" + r.tasks + " tasks)"));
    } catch (e) {
      if (e instanceof BusError) { console.error(e.message); process.exit(e.code); }
      throw e;
    }
    break;
  }
  case "post": {
    let inline = {};
    if (opt("stdin")) {
      // Windows 下引号/编码最容易出问题，允许把 payload 从 stdin 灌进来：
      //   node tools/bus-cli.mjs post --stdin < task.json
      const raw = fs.readFileSync(0, "utf8").replace(/^\uFEFF/, "").trim();
      if (raw) { try { inline = JSON.parse(raw); } catch (e) { console.error("stdin 不是合法 JSON: " + e.message); process.exit(2); } }
    }
    // assignee 的四个来源：--to / --assignee / payload.to / payload.assignee。冲突就报错，不静默取一个。
    const src = {
      "--to": opt("to") === true ? undefined : opt("to"),
      "--assignee": opt("assignee") === true ? undefined : opt("assignee"),
      "payload.to": inline.to,
      "payload.assignee": inline.assignee
    };
    const given = Object.entries(src).filter(([, v]) => typeof v === "string" && v.length);
    const vals = [...new Set(given.map(([, v]) => v))];
    if (vals.length > 1) {
      console.error("assignee 冲突（to 与 assignee 指向不同人）：" + given.map(([k, v]) => k + "=" + v).join(", ") +
        "\n只留一处：--to 或 --assignee（payload.to/payload.assignee 为兼容旧示例保留）");
      process.exit(2);
    }
    const KNOWN = new Set(["title", "body", "agent", "assignee", "to", "accept", "priority", "tags", "parent"]);
    for (const k of Object.keys(inline)) if (!KNOWN.has(k)) console.error("[bus] 警告：忽略未知字段 " + k + "（允许：title/body/agent/assignee/to/accept/priority/tags/parent）");
    let body = inline.body || opt("body") || "";
    const bf = opt("body-file");
    if (bf && bf !== true) body = fs.readFileSync(bf, "utf8");
    // D3 前置：缺验收标准/产出路径只警告不拦（硬拒会挡住紧急派活），但必须点名缺哪一项
    const accept = inline.accept || (opt("accept") === true ? undefined : opt("accept"));
    const bodyText = String(body || "");
    if (!accept && !/验收/.test(bodyText)) console.error("[bus] 警告：缺少「验收标准」——加 --accept \"…\" 或在 body 写一行「验收：…」（不阻断派活，但执行方按 D3 可退回不领）");
    const pathProbe = bodyText + " " + String(accept || "");
    if (!/产出|artifact|\.(ts|js|mjs|json|md|py|yml|yaml)\b/i.test(pathProbe)) console.error("[bus] 警告：缺少「产出路径」——body 里写明要改哪个文件/产出什么（不阻断）");
    const title = inline.title || opt("title") || positional[0];
    if (!title || !String(title).trim()) {
      console.error("[bus] 缺少标题：--title \"…\"（或用 --stdin 传 JSON 的 title）。拒绝创建空任务。");
      process.exit(2);
    }
    const posted = await callTool("bus_post_task", {
      title,
      body,
      accept,
      agent: inline.agent || as,
      assignee: vals[0],
      priority: inline.priority || opt("priority") || "normal",
      tags: inline.tags || multi("tag"),
      parent: inline.parent
    });
    emit(posted, opt("json"));
    if (opt("wake") !== undefined) {
      // callTool 返回的是 MCP 形状 { content: [{ text }] }，任务对象在 text 里 —— 直接读 posted.id 会恒为 undefined。
      let pid = "";
      try { pid = JSON.parse((posted.content || []).map((c) => c.text).join("\n")).id || ""; } catch {}
      const k = knockTrae({ id: pid || "T-??????", title, assignee: vals[0], poster: inline.agent || as });
      if (k === "corrupt") { console.error("[bus] 任务已落盘（" + (pid || "?") + "）；exit 6 只表示门铃账本损坏，不影响投递。"); process.exit(6); }
    }
    break;
  }
  case "knock": {
    const id = positional[0];
    if (!id) { console.error("[bus] 用法: knock <任务号> [--wake-force]"); process.exit(2); }
    const st = readStateStrict();
    const t = (st.tasks || []).find((x) => x.id === id);
    if (!t) { console.error("[bus] 找不到任务 " + id); process.exit(1); }
    const k = knockTrae({ id, title: t.title, assignee: t.assignee, poster: "dsh-lead" });
    if (k === "corrupt") process.exit(6);
    process.exit(0);
  }
  case "list":
    emit(await callTool("bus_list_tasks", { status: opt("status"), assignee: opt("as"), limit: Number(opt("limit")) || 20 }), opt("json"));
    break;
  case "show": {
    const id = positional[0];
    const st = loadOrExit();
    const t = st.tasks.find((x) => x.id === id);
    if (!t) { console.error("task not found: " + id); process.exit(1); }
    console.log(JSON.stringify(t, null, 2));
    break;
  }
  case "claim":
    emit(await callTool("bus_claim_task", { id: positional[0], agent: as }), opt("json"));
    break;
  case "progress":
    emit(await callTool("bus_progress", { id: positional[0], agent: as, note: opt("note") || "" }), opt("json"));
    break;
  case "done":
  case "fail":
    emit(await callTool("bus_complete_task", {
      id: positional[0], agent: as,
      result: opt("result") || "",
      artifacts: multi("artifact"),
      status: cmd === "fail" ? "failed" : "done"
    }), opt("json"));
    break;
  case "note": {
    const sub = positional[0];
    if (sub === "write") {
      // key 必填：它决定覆盖哪一条说明；缺了会被写成 "undefined" 这种幽灵条目（实测过）
      const key = opt("key") || positional[1];
      const text = opt("text");
      if (!key || !String(key).trim()) {
        console.error('usage: bus-cli note write --key <名字> --text <内容> [--as <身份>]\n  key 必填：说明按 key 覆盖，缺了会写成 undefined。');
        process.exit(2);
      }
      if (!text || !String(text).trim()) { console.error("[bus] note write 缺少 --text"); process.exit(2); }
      emit(await callTool("bus_note_write", { key, text, agent: as }), opt("json"));
    }
    else if (sub === "read" || sub === undefined) emit(await callTool("bus_note_read", { key: opt("key") }), opt("json"));
    else { console.error("usage: note write|read"); process.exit(2); }
    break;
  }
  case "wait": {
    // 长轮询：阻塞到有可领任务为止，省掉“隔几秒查一次”的对话噪音。
    const timeout = (Number(opt("timeout")) || 300) * 1000;
    const interval = Number(opt("interval")) || 1000;
    const autoClaim = !!opt("claim");
    const t0 = Date.now();
    for (;;) {
      const st = loadOrExit();
      const t = st.tasks.find((x) => x.status === "pending" && (!x.assignee || x.assignee === as));
      if (t) {
        if (!autoClaim) { console.log(opt("json") ? JSON.stringify(t, null, 2) : row(t) + (t.body ? "\n  body: " + t.body : "")); break; }
        const res = await callTool("bus_claim_task", { id: t.id, agent: as });
        emit(res, opt("json")); break;
      }
      if (Date.now() - t0 > timeout) {
        // 空转不是失败：TRAE 没有后台常驻，靠短轮询驱动，exit 0 才不会把循环打断。
        if (opt("json")) console.log(JSON.stringify({ task: null, reason: "no_task", waited_s: timeout / 1000 }));
        else console.log("idle: " + timeout / 1000 + "s 内没有可领任务");
        process.exit(opt("strict") ? 1 : 0);
      }
      await new Promise((r) => setTimeout(r, interval));
    }
    break;
  }
  case "poll": {
    const st = loadOrExit();
    const t = st.tasks.find((x) => x.status === "pending" && (!x.assignee || x.assignee === as));
    if (!t) {
      if (opt("json")) console.log(JSON.stringify({ task: null, reason: "no_task" }));
      else console.log("idle: no pending task");
      process.exit(0);
    }
    if (!opt("claim")) { console.log(opt("json") ? JSON.stringify(t, null, 2) : row(t) + (t.body ? "\n  body: " + t.body : "")); break; }
    emit(await callTool("bus_claim_task", { id: t.id, agent: as }), opt("json")); break;
  }
  case "stats":
    emit(await callTool("bus_stats", {}), opt("json"));
    break;
  default:
    console.log("usage: bus-cli.mjs init|board|post|list|show|claim|progress|done|fail|note|poll|wait|stats  (--as <agent>)");
    process.exit(cmd ? 2 : 0);
}
