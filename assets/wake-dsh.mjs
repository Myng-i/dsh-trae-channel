#!/usr/bin/env node
// wake-dsh — 通过 CDP 给 DSH 聊天框发一条消息（反向叫醒：让 TRAE 叫醒 dsh-lead）
// 前提：DSH 桌面端以 --remote-debugging-port=9223 启动（需要重启一次）。
// 用法：
//   node tools/wake-dsh.mjs status
//   node tools/wake-dsh.mjs probe
//   node tools/wake-dsh.mjs send --text "【TRAE 叫醒】..." [--dry] [--no-enter] [--port 9223]
// 退出码：0 成功 / 2 参数 / 3 端口不通 / 4 找不到输入框 / 5 协议错误
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";

const DEFAULT_PORT = 9223;
const argv = process.argv.slice(2);
function parse(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--port") out.port = Number(argv[++i]);
    else if (a === "--text") out.text = argv[++i];
    else if (a === "--text-file") out.textFile = argv[++i];
    else if (a === "--target") out.target = argv[++i];
    else if (a === "--dry") out.dry = true;
    else if (a === "--no-enter") out.noEnter = true;
    else if (a === "--json") out.json = true;
    else if (a === "--help" || a === "-h") out.help = true;
    else if (a.startsWith("--")) { console.error("未知参数: " + a); process.exit(2); }
    else out._.push(a);
  }
  out.port = out.port || Number(process.env.DSH_CDP_PORT || DEFAULT_PORT);
  out.cmd = out._[0] || "status";
  return out;
}
const O = parse(argv);
if (O.help) {
  console.log("wake-dsh — 用 CDP 往 DSH 聊天框发一条消息（反向叫醒）\n\n" +
    "  status                     端口 + 输入框是否可用（一行结论）\n" +
    "  probe                      列 target 与每页输入框（只读）\n" +
    "  send --text <文本>         聚焦输入框、插入文本、回车\n" +
    "       --text-file <路径>    从文件读（中文/长文本更稳）\n" +
    "       --dry                 只找输入框，不输入\n" +
    "       --no-enter            只填入不发\n" +
    "       --port <n>            默认 " + DEFAULT_PORT + "（或 DSH_CDP_PORT）\n" +
    "\n前提：DSH 以 \"DeepSeek Harness.exe\" --remote-debugging-port=" + DEFAULT_PORT + " 启动（需重启一次）。\n" +
    "不满足时 exit 3，并打印重启命令。");
  process.exit(0);
}
// DSH 可执行文件路径：不写死本机路径（包会公开）。按 DSH_EXE → 常见安装位置 探测，探测不到只给占位符。
function findDshExe() {
  const fromEnv = process.env.DSH_EXE;
  if (fromEnv && existsSync(fromEnv)) return fromEnv;
  const cands = [
    process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, "Programs", "DeepSeek Harness", "DeepSeek Harness.exe") : "",
    process.env.ProgramFiles ? path.join(process.env.ProgramFiles, "DeepSeek Harness", "DeepSeek Harness.exe") : "",
    "C:/Program Files/DeepSeek Harness/DeepSeek Harness.exe",
    "/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness",
  ].filter(Boolean);
  for (const c of cands) { try { if (existsSync(c)) return c; } catch {} }
  return null;
}
const DSH_EXE = findDshExe();
const RESTART_HINT = '重启方式（会中断当前窗口，会话可在列表里恢复）：\n  ' +
  (DSH_EXE ? '"' + DSH_EXE + '"' : '<DSH 可执行文件路径>') + ' --remote-debugging-port=' + O.port +
  (DSH_EXE ? '' : '\n（路径可用 DSH_EXE 环境变量指定；PowerShell 里 (Get-Process "DeepSeek Harness").Path 可查）');

function getJSON(url) {
  return fetch(url, { signal: AbortSignal.timeout(4000) }).then((r) => {
    if (!r.ok) throw new Error("HTTP " + r.status);
    return r.json();
  });
}

function cdpPage(wsUrl) {
  const sock = new WebSocket(wsUrl);
  let seq = 0;
  const pending = new Map();
  const events = [];
  const opened = new Promise((res, rej) => {
    sock.addEventListener("open", () => res());
    sock.addEventListener("error", () => rej(new Error("ws error")));
  });
  sock.addEventListener("message", (ev) => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch { return; }
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
    } else if (msg.method) events.push(msg);
  });
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++seq;
    pending.set(id, { resolve, reject });
    sock.send(JSON.stringify({ id, method, params }));
    setTimeout(() => { if (pending.has(id)) { pending.delete(id); reject(new Error("CDP timeout: " + method)); } }, 8000);
  });
  return { opened, send, events, close: () => sock.close() };
}

const FIND_INPUT = `(() => {
  const sel = ['textarea', 'input[type="text"]', '[contenteditable="true"]', '[role="textbox"]'];
  const all = [];
  for (const s of sel) for (const el of document.querySelectorAll(s)) all.push(el);
  const vis = all.filter((el) => {
    const r = el.getBoundingClientRect();
    const st = getComputedStyle(el);
    return r.width > 40 && r.height > 10 && st.visibility !== 'hidden' && st.display !== 'none' && !el.disabled;
  });
  if (!vis.length) return { found: false, total: all.length };
  vis.sort((a, b) => b.getBoundingClientRect().width * b.getBoundingClientRect().height - a.getBoundingClientRect().width * a.getBoundingClientRect().height);
  const el = vis[0];
  el.focus();
  const r = el.getBoundingClientRect();
  return {
    found: true,
    tag: el.tagName.toLowerCase(),
    cls: String(el.className || '').slice(0, 120),
    placeholder: el.getAttribute('placeholder') || el.getAttribute('data-placeholder') || '',
    rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
    totalEditable: all.length,
  };
})()`;

async function listTargets() {
  const list = await getJSON(`http://127.0.0.1:${O.port}/json/list`);
  return list.filter((t) => t.webSocketDebuggerUrl && (t.type === "page" || t.type === "webview"));
}

function looksLikeDsh(t) {
  const u = String(t.url || "");
  const ti = String(t.title || "");
  return /5184|dsh-app|deepseek/i.test(u) || /DeepSeek Harness|DSH/i.test(ti);
}

async function findInputOn(t) {
  const p = cdpPage(t.webSocketDebuggerUrl);
  try {
    await p.opened;
    await p.send("Runtime.enable");
    const r = await p.send("Runtime.evaluate", { expression: FIND_INPUT, returnByValue: true });
    return { page: p, input: r && r.result && r.result.value };
  } catch (e) {
    try { p.close(); } catch {}
    return { page: null, input: null, error: String(e.message || e).slice(0, 120) };
  }
}

async function pick() {
  const targets = await listTargets();
  const ordered = targets.filter(looksLikeDsh).concat(targets.filter((t) => !looksLikeDsh(t)));
  for (const t of ordered) {
    const hit = await findInputOn(t);
    if (hit.input && hit.input.found) return { target: t, page: hit.page, input: hit.input };
    try { hit.page && hit.page.close(); } catch {}
  }
  return { target: null };
}

async function main() {
  const cmd = O.cmd;
  if (!["status", "probe", "send"].includes(cmd)) { console.error("未知子命令: " + cmd + "（status|probe|send）"); process.exit(2); }
  let targets;
  try { targets = await listTargets(); }
  catch (e) {
    console.error("端口 " + O.port + " 上没找到 CDP：" + String(e.message || e).slice(0, 100));
    console.error(RESTART_HINT);
    process.exit(3);
  }
  if (cmd === "probe" || O.json) {
    const rows = targets.map((t) => ({ id: String(t.id).slice(0, 8), type: t.type, title: String(t.title || "").slice(0, 60), url: String(t.url || "").slice(0, 100) }));
    if (O.json && cmd !== "probe") { /* send 的 json 输出后面统一打 */ }
    else { console.log(JSON.stringify({ port: O.port, targets: rows }, null, 2)); if (cmd === "probe") process.exit(0); }
  }
  if (cmd === "status") {
    const t0 = Date.now();
    const got = await pick();
    if (!got.target) {
      console.log("NO_INPUT cdp=" + O.port + "ok targets=" + targets.length + "（没有可用的输入框）");
      process.exit(4);
    }
    const i = got.input;
    console.log("READY cdp=" + O.port + "ok targets=" + targets.length + " input=" + i.tag + (i.placeholder ? " [" + i.placeholder.slice(0, 24) + "]" : "") + " rect=" + i.rect.w + "x" + i.rect.h + " " + (Date.now() - t0) + "ms");
    try { got.page.close(); } catch {}
    process.exit(0);
  }
  // send
  let text = O.text;
  if (O.textFile) { try { text = readFileSync(O.textFile, "utf8"); } catch (e) { console.error("读不到 " + O.textFile + "：" + e.message); process.exit(2); } }
  if (!text || !String(text).trim()) { console.error("缺少 --text 或 --text-file（拒绝发空消息）"); process.exit(2); }
  const got = await pick();
  if (!got.target) { console.error("找不到 DSH 聊天输入框（targets=" + targets.length + "）"); process.exit(4); }
  const p = got.page;
  try {
    if (O.dry) {
      console.log("[wake-dsh] dry: 找到输入框 " + got.input.tag + " '" + got.input.placeholder + "' → 不发送");
      console.log("[wake-dsh] 将发送 " + String(text).length + " 字符：" + String(text).replace(/\s+/g, " ").slice(0, 80));
      process.exit(0);
    }
    await p.send("Input.insertText", { text: String(text) });
    if (!O.noEnter) {
      await p.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });
      await p.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });
    }
    console.log("[wake-dsh] 已注入 " + String(text).length + " 字符" + (O.noEnter ? "（未回车）" : "并回车") + " → target=" + String(got.target.title || "").slice(0, 40));
    process.exit(0);
  } catch (e) {
    console.error("[wake-dsh] CDP 发送失败：" + String(e.message || e).slice(0, 160));
    process.exit(5);
  } finally {
    try { p.close(); } catch {}
  }
}
main().catch((e) => { console.error("[wake-dsh] 未捕获：" + String(e && e.stack || e).slice(0, 300)); process.exit(5); });
