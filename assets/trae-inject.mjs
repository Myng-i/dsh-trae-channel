#!/usr/bin/env node
/**
 * trae-inject.mjs — 通过 Chrome DevTools Protocol 往 TRAE 聊天框投递消息（不抢鼠标/键盘）
 *
 * 前提：TRAE CN 需要以 --remote-debugging-port=9222 启动（一次性重启，之后照常用）。
 * 原理：CDP 的 Input.insertText 直接把文本写进聚焦的输入框，Input.dispatchKeyEvent 发回车，
 *       全程不经 OS 输入队列，不移动鼠标、不夺取键盘焦点。
 *
 * 用法：
 *   node tools/trae-inject.mjs probe                 # 看端口与所有 target（只读）
 *   node tools/trae-inject.mjs targets               # 只列 target
 *   node tools/trae-inject.mjs send --text "你好"    # 投递并回车
 *   node tools/trae-inject.mjs send --text "..." --dry   # 只聚焦+统计，不输入
 *   node tools/trae-inject.mjs send --text "..." --target <id|序号>
 *   node tools/trae-inject.mjs send --text "..." --no-enter
 *
 * 退出码：0 成功 / 2 参数错 / 3 端口不通（没开 CDP） / 4 找不到输入框 / 5 协议错误
 */
import { argv } from "node:process";
import fs from "node:fs";
import path from "node:path";

const DEFAULTS = { port: "auto" };

// 端口自动发现：优先读 TRAE 自己写的 DevToolsActivePort（首行是端口），读不到回 9222。
function autoPort() {
  const bases = [process.env.APPDATA, process.env.USERPROFILE && path.join(process.env.USERPROFILE, "AppData", "Roaming")].filter(Boolean);
  for (const b of bases) {
    try {
      const f = path.join(b, "Trae CN", "DevToolsActivePort");
      const n = Number(String(fs.readFileSync(f, "utf8")).split("\n")[0].trim());
      if (Number.isInteger(n) && n > 0) return n;
    } catch {}
  }
  return 9222;
}

function parseArgs() {
  const out = { _: [] };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--port") { const v = argv[++i]; out.port = v === "auto" ? "auto" : Number(v); }
    else if (a === "--text") out.text = argv[++i];
    else if (a === "--text-file") out.textFile = argv[++i];
    else if (a === "--target") out.target = argv[++i];
    else if (a === "--dry") out.dry = true;
    else if (a === "--no-enter") out.noEnter = true;
    else if (a === "--json") out.json = true;
    else if (a === "--chars") out.chars = Number(argv[++i]);
    else if (a === "--help" || a === "-h") out.help = true;
    else if (a.startsWith("--")) { console.error("未知参数: " + a); process.exit(2); }
    else out._.push(a);
  }
  out.port = out.port || DEFAULTS.port;
  if (out.port === "auto") out.port = autoPort();
  out.cmd = out._[0] || "probe";
  return out;
}

const HELP = `trae-inject — 通过 CDP 给 TRAE 聊天框发消息（不抢鼠标）

  probe                    看端口是否开着 + 列出全部 target（只读）
  targets                  同上，只列 target
  read [--chars 2000]      读聊天面板末尾文本（后台看它回了什么）
  status                   端口 + 输入框是否可用（一行结论）
  send --text <文本>       聚焦聊天输入框、插入文本、回车
       --text-file <路径>  从文件读（长文本/中文更稳）
       --target <id|序号>  指定 target（默认自动挑聊天页）
       --dry               只找输入框，不输入
       --no-enter          只填入不发
       --port <n|auto>     默认 auto（读 DevToolsActivePort，读不到用 9222）
  --json                   机器可读输出

前提：TRAE CN 以 --remote-debugging-port=9222 启动（需要重启一次）。
不满足时 exit 3，并打印重启命令。`;

async function getJSON(url) {
  const r = await fetch(url, { signal: AbortSignal.timeout(4000) });
  if (!r.ok) throw new Error("HTTP " + r.status);
  return r.json();
}

function cdpPage(wsUrl) {
  const sock = new WebSocket(wsUrl);
  let seq = 0;
  const pending = new Map();
  const events = [];
  const opened = new Promise((res, rej) => {
    sock.addEventListener("open", () => res());
    sock.addEventListener("error", (e) => rej(new Error("ws error")));
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

async function listTargets(port) {
  const list = await getJSON(`http://127.0.0.1:${port}/json/list`);
  return list.filter((t) => t.webSocketDebuggerUrl);
}

async function summarizeTargets(port, targets) {
  const rows = [];
  for (let i = 0; i < targets.length; i++) {
    const t = targets[i];
    const row = { i, id: t.id.slice(0, 8), type: t.type, title: (t.title || "").slice(0, 70), url: (t.url || "").slice(0, 110), input: null };
    if (t.type === "page" || t.type === "webview") {
      try {
        const p = cdpPage(t.webSocketDebuggerUrl);
        await p.opened;
        await p.send("Runtime.enable");
        const r = await p.send("Runtime.evaluate", { expression: FIND_INPUT, returnByValue: true });
        row.input = r?.result?.value ?? null;
        p.close();
      } catch (e) { row.input = { error: e.message }; }
    }
    rows.push(row);
  }
  return rows;
}

function pickChat(rows) {
  const score = (r) => {
    let s = 0;
    const hay = (r.title + " " + r.url).toLowerCase();
    if (/marscode|trae|chat|conversation/.test(hay)) s += 2;
    if (r.input && r.input.found) s += 5;
    if (r.type === "webview") s += 3;
    if (r.type !== "page" && r.type !== "webview") s -= 10;
    return s;
  };
  return rows.filter(r => r.input && r.input.found).sort((a, b) => score(b) - score(a))[0]
      || rows.slice().sort((a, b) => score(b) - score(a))[0];
}

async function main() {
  const args = parseArgs();
  if (args.help) { console.log(HELP); return; }

  let version;
  try {
    version = await getJSON(`http://127.0.0.1:${args.port}/json/version`);
  } catch (e) {
    console.error("[inject] 连不上 127.0.0.1:" + args.port + " — " + e.message);
    console.error("[inject] TRAE 当前没有开 CDP。需要一次性重启（之后照常用）：");
    console.error('  & "D:\\software\\Trae CN\\Trae CN.exe" --remote-debugging-port=9222');
    console.error("[inject] 或先退出 TRAE，再从带该参数的快捷方式启动。");
    process.exit(3);
  }

  const targets = await listTargets(args.port);
  if (args.cmd === "targets") {
    if (args.json) console.log(JSON.stringify(targets.map(t => ({ id: t.id, type: t.type, title: t.title, url: t.url })), null, 2));
    else targets.forEach((t, i) => console.log(`[${i}] ${t.type.padEnd(8)} ${(t.title || "").slice(0, 60)}  ${(t.url || "").slice(0, 80)}`));
    return;
  }

  const rows = await summarizeTargets(args.port, targets);

  if (args.cmd === "probe") {
    console.log("[inject] CDP 可用：" + (version.Browser || "?") + " @ " + args.port);
    console.log("[inject] target 数：" + rows.length + "，其中找到输入框的：" + rows.filter(r => r.input?.found).length);
    for (const r of rows) {
      const hint = r.input ? (r.input.found ? `输入框 ${r.input.tag} 「${r.input.placeholder}」 ${r.input.rect.w}x${r.input.rect.h}` : "无可编辑框") : "-";
      console.log(`[${r.i}] ${r.type.padEnd(8)} ${r.title.slice(0, 55).padEnd(55)} | ${hint}`);
    }
    if (args.json) console.log(JSON.stringify({ version, rows }, null, 2));
    return;
  }

  if (args.cmd === "status") {
    const withInput = rows.filter(r => r.input && r.input.found);
    console.log((withInput.length ? "READY" : "NO_INPUT") + "  cdp=9222ok targets=" + rows.length + " inputs=" + withInput.length + " browser=" + (version.Browser || "?"));
    if (args.json) console.log(JSON.stringify({ ready: withInput.length > 0, targets: rows.length, inputs: withInput.length, browser: version.Browser }));
    process.exit(withInput.length ? 0 : 4);
  }

  if (args.cmd === "read") {
    const row = pickChat(rows);
    if (!row) { console.error("没有可用 target"); process.exit(5); }
    const t = targets.find(x => x.id.slice(0, 8) === row.id) || targets[row.i];
    const p = cdpPage(t.webSocketDebuggerUrl);
    await p.opened;
    await p.send("Runtime.enable");
    const n = Number(args.chars || 2000);
    const expr = `(() => {
      const nodes = document.querySelectorAll('.turn__user-message, .turn__agent-message');
      const turns = [];
      for (const el of nodes) {
        const role = el.className.includes('user') ? 'user' : 'agent';
        const t = (el.innerText || '').trim();
        if (t) turns.push({ role, text: t });
      }
      return { turns, body: (document.body && document.body.innerText) || '' };
    })()`;
    const r = await p.send("Runtime.evaluate", { expression: expr, returnByValue: true });
    const v = r?.result?.value || { turns: [], body: "" };
    p.close();
    let text;
    if (v.turns && v.turns.length) {
      text = v.turns.map((t) => (t.role === "user" ? "我： " : "TRAE： ") + t.text).join("\n\n");
    } else {
      text = String(v.body || "");
    }
    if (args.json) console.log(JSON.stringify({ ok: true, target: row.title, mode: v.turns && v.turns.length ? "turns" : "body", turns: v.turns, chars: text.length, tail: text.slice(-n) }));
    else console.log(text.slice(-n));
    return;
  }

  if (args.cmd !== "send") { console.error("未知子命令: " + args.cmd + "（用 probe / targets / status / read / send）"); process.exit(2); }

  let text = args.text;
  if (!text && args.textFile) text = fs.readFileSync(args.textFile, "utf8");
  if (!text) { console.error("send 需要 --text 或 --text-file"); process.exit(2); }

  let row;
  if (args.target !== undefined) {
    row = rows.find(r => String(r.i) === args.target || r.id === args.target || r.id.startsWith(args.target));
    if (!row) { console.error("找不到 target: " + args.target); process.exit(2); }
  } else {
    row = pickChat(rows);
  }
  if (!row) { console.error("没有可用 target"); process.exit(5); }

  const t = targets.find(x => x.id.slice(0, 8) === row.id) || targets[row.i];
  const p = cdpPage(t.webSocketDebuggerUrl);
  await p.opened;
  await p.send("Runtime.enable");

  const find = await p.send("Runtime.evaluate", { expression: FIND_INPUT, returnByValue: true });
  const info = find?.result?.value;
  if (!info?.found) {
    console.error("[inject] target「" + row.title + "」里没找到可聚焦输入框");
    p.close();
    process.exit(4);
  }

  if (args.dry) {
    console.log("[inject] dry：已聚焦 " + info.tag + "「" + info.placeholder + "」 " + info.rect.w + "x" + info.rect.h + "，未输入");
    p.close();
    return;
  }

  await p.send("Input.insertText", { text });
  await new Promise(r => setTimeout(r, 150));
  if (!args.noEnter) {
    await p.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });
    await p.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });
  }
  await new Promise(r => setTimeout(r, 300));
  if (args.json) console.log(JSON.stringify({ ok: true, target: row.title, focused: info, chars: text.length, entered: !args.noEnter }));
  else console.log("[inject] 已投递 " + text.length + " 字符到「" + (row.title || row.url) + "」" + (args.noEnter ? "（未回车）" : " 并回车"));
  p.close();
  // 本机补丁 2026-11-14：socket 关闭后事件循环仍被残留定时器挂住，进程不退出，
  // 导致 wake-trae 的 spawnSync 30s 超时杀进程（status=null）并误报「未送达」。
  process.exit(0);
}

main().catch((e) => { console.error("[inject] 失败：" + e.message); process.exit(5); });
