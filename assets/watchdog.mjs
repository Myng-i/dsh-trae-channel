#!/usr/bin/env node
// watchdog.mjs — DSH 侧只读看门狗：盯信箱与任务板，发现新件就提醒（可选写触发卡给 TRAE）。
// 永不 claim / 永不 post / 永不改 mailbox 与 bus 的业务数据，只写 watch/ 自己的状态与触发卡。
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const argv = process.argv.slice(2);
function opt(name, def) {
  const i = argv.indexOf("--" + name);
  if (i < 0) return def;
  const v = argv[i + 1];
  return v && !v.startsWith("--") ? v : true;
}
const flag = (n) => opt(n, false) === true;

const ROOT = path.resolve(String(opt("root", process.cwd())));
const MAILBOX = path.resolve(String(opt("mailbox", path.join(ROOT, "mailbox"))));
const BUS = path.resolve(String(opt("bus", path.join(ROOT, "bus"))));
const STATE_FILE = path.resolve(String(opt("state", path.join(ROOT, "watch", "state.json"))));
const ME = String(opt("as", "dsh-lead"));
const AS_JSON = flag("json");
const QUIET = flag("quiet");
const TOAST = flag("toast");
const INIT = flag("init");
const INTERVAL = opt("interval", null);
const EMIT = opt("emit-trigger", null);
const ONCE = flag("once");

// 出站叫醒已统一到 wake-trae.mjs（自带扫描与游标），这里只保留一个明确的拒绝提示
if (argv.some((a) => a === "--notify-trae" || a.startsWith("--notify-trae="))) {
  console.error("[watch] --notify-trae 已移除：出站叫醒统一走 tools/wake-trae.mjs（看门狗只做只读扫描与提醒）。");
  process.exit(2);
}

function insidePath(child, parent) {
  const c = path.resolve(child), p = path.resolve(parent);
  return c === p || c.startsWith(p + path.sep);
}
if (EMIT && (insidePath(String(EMIT), MAILBOX) || insidePath(String(EMIT), BUS))) {
  console.error("拒绝：--emit-trigger 目录不能落在 mailbox/ 或 bus/ 内（会被当成信件/板数据）。改用工作区下的 triggers/");
  process.exit(2);
}

const KNOWN = new Set(["root","mailbox","bus","state","as","json","quiet","toast","init","interval","emit-trigger","once","help"]);
for (const a of argv) {
  if (a.startsWith("--") && !KNOWN.has(a.slice(2))) { console.error("未知参数：" + a + "（--help 看用法）"); process.exit(2); }
}
if (flag("help")) {
  console.log(`用法: node tools/watchdog.mjs [--init] [--once] [--json] [--toast] [--quiet]
       [--interval <秒>] [--emit-trigger <目录>] [--as <身份>]
       [--root <工作区>] [--mailbox <目录>] [--bus <目录>] [--state <文件>]

默认执行一轮巡检后退出；--interval 常驻；--init 只建基线不报历史件。
只读：不 claim、不 post、不改 bus/ 与 mailbox/ 的业务数据。
出站叫醒（用 CDP 把摘要注进 TRAE）不在这里：用 tools/wake-trae.mjs。
`);
  process.exit(0);
}

function readState() {
  try {
    const s = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
    return { mailSeen: typeof s.mailSeen === "string" ? s.mailSeen : "", busSeen: Array.isArray(s.busSeen) ? s.busSeen : [] };
  } catch { return { mailSeen: "", busSeen: [] }; }
}
function writeState(st) {
  fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
  const tmp = STATE_FILE + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify({ ...st, lastRun: new Date().toISOString() }, null, 2) + "\n");
  fs.renameSync(tmp, STATE_FILE);
}

function parseLetter(file) {
  const raw = fs.readFileSync(file, "utf8");
  const m = raw.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  const fm = {};
  if (m) for (const line of m[1].split(/\r?\n/)) {
    const kv = line.match(/^([A-Za-z_][\w-]*):\s*(.*)$/);
    if (kv) fm[kv[1].toLowerCase()] = kv[2].trim();
  }
  return {
    file: path.basename(file),
    id: fm.id || path.basename(file, ".md"),
    from: fm.from || "?", to: fm.to || "?", subject: fm.subject || "(无主题)", created: fm.created || "",
  };
}
function collectMail() {
  let names = [];
  try { names = fs.readdirSync(MAILBOX).filter((n) => n.endsWith(".md") && n !== "INDEX.md"); } catch { return []; }
  const letters = names.map((n) => parseLetter(path.join(MAILBOX, n)))
    .filter((l) => l.to === ME || l.to === "all")
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return letters;
}
function collectBus() {
  const file = path.join(BUS, "state.json");
  let raw;
  try { raw = fs.readFileSync(file, "utf8"); }
  catch (e) {
    if (e.code === "ENOENT") return { status: "missing", file, tasks: [] };
    return { status: "unreadable", file, error: e.message, tasks: [] };
  }
  let st;
  try { st = JSON.parse(raw); }
  catch (e) { return { status: "corrupt", file, error: e.message, tasks: [] }; }
  const tasks = Array.isArray(st.tasks) ? st.tasks : [];
  return { status: "ok", file, tasks: tasks.filter((t) => t && t.status === "pending" && (!t.assignee || t.assignee === ME)) };
}

function existingRefs(dir) {
  const refs = new Set();
  for (const sub of [dir, path.join(dir, "done")]) {
    try {
      for (const n of fs.readdirSync(sub)) {
        if (!n.endsWith(".md")) continue;
        try {
          const m = fs.readFileSync(path.join(sub, n), "utf8").match(/^ref:\s*(.+)$/m);
          if (m) refs.add(m[1].trim());
        } catch {}
      }
    } catch {}
  }
  return refs;
}
function emitTrigger(items) {
  if (!EMIT) return;
  const dir = path.resolve(String(EMIT));
  fs.mkdirSync(dir, { recursive: true });
  const seen = existingRefs(dir);
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  let seq = 0;
  items.forEach((it, i) => {
    if (seen.has(it.id)) return;  // 同一 ref 已有卡（含 done/），不重复写
    seen.add(it.id);
    const body = "---\nid: trigger-" + ts + "-" + i + "\nfrom: watchdog\nto: trae-ide\nkind: " + it.kind + "\nref: " + it.id + "\n---\n\n" +
      "看门狗发现新件，请在本轮处理：\n\n- 类型：" + it.kind + "\n- 编号：" + it.id + "\n- 摘要：" + it.subject + "\n" +
      "\n处理方式：任务用 bus-cli poll/claim；信件用 mailbox inbox/read。本卡仅提醒，不代表已认领。\n";
    const f = path.join(dir, "trigger-" + ts + "-" + seq + ".md");
    seq++;
    try { fs.writeFileSync(f, body, { flag: "wx" }); } catch {}
  });
}

function toast(msg) {
  const esc = msg.replace(/'/g, "''");
  const ps = "Add-Type -AssemblyName System.Windows.Forms; Add-Type -AssemblyName System.Drawing; " +
    "$n = New-Object System.Windows.Forms.NotifyIcon; $n.Icon = [System.Drawing.SystemIcons]::Information; " +
    "$n.Visible = $true; $n.ShowBalloonTip(6000, 'DSH-TRAE', '" + esc + "', 'Info'); Start-Sleep -Milliseconds 6500; $n.Dispose()";
  try { execFileSync("powershell", ["-NoProfile", "-NonInteractive", "-Command", ps], { stdio: "ignore", timeout: 15000 }); } catch {}
}

function run() {
  const st = readState();
  const letters = collectMail();
  const newMail = letters.filter((l) => !st.mailSeen || l.id > st.mailSeen);
  const bus = collectBus();
  const newTasks = bus.tasks.filter((t) => !st.busSeen.includes(t.id));

  const items = [
    ...newTasks.map((t) => ({ kind: "task", id: t.id, subject: t.title || t.subject || "(无标题)" })),
    ...newMail.map((l) => ({ kind: "mail", id: l.id, subject: l.subject + " ← " + l.from })),
  ];

  if (INIT) {
    writeState({ mailSeen: letters.length ? letters[letters.length - 1].id : "", busSeen: bus.tasks.map((t) => t.id) });
    if (!QUIET) console.log("[watch] 基线已建立：mailSeen=" + (letters.length ? letters[letters.length - 1].id : "(空)") + " busSeen=" + bus.tasks.length);
    if (bus.status === "corrupt" || bus.status === "unreadable")
      console.error("[watch] ⚠ 任务板损坏，基线只包含可解析任务（0 项）；先修板再跑一次 --init 更稳");
    return bus.status === "corrupt" || bus.status === "unreadable" ? 6 : 0;
  }

  const busInfo = { busStatus: bus.status, busFile: bus.file };
  if (bus.status === "corrupt" || bus.status === "unreadable") {
    busInfo.busCorrupt = true;
    busInfo.busError = bus.error || "parse error";
  }
  if (AS_JSON) {
    if (bus.status === "corrupt" || bus.status === "unreadable")
      console.error("[watch] ⚠ 任务板损坏/不可读（JSON 模式同样会 exit 6）：" + bus.file + " — " + (bus.error || ""));
    console.log(JSON.stringify(Object.assign({ ok: true, me: ME, newCount: items.length, newMail, newTasks: newTasks.map((t) => ({ id: t.id, title: t.title || t.subject, assignee: t.assignee || null })), busUninitialized: bus.status === "missing" }, busInfo), null, 2));
  } else if (!QUIET) {
    if (!items.length) console.log("[watch] 无新件（信箱 " + letters.length + " 封，板 " + bus.tasks.length + " 项待办）");
    else {
      console.log("[watch] 发现 " + items.length + " 件新东西：");
      for (const it of items.reverse()) console.log("  - [" + it.kind + "] " + it.id + "  " + it.subject);
    }
    if (bus.status === "missing") console.log("[watch] 任务板未初始化（只读，不建板）");
    if (bus.status === "corrupt" || bus.status === "unreadable")
      console.error("[watch] ⚠ 任务板 state.json 损坏/不可读，未解析任何任务（也不建板）：" + bus.file + "\n        " + (bus.error || "") + "\n        处理：人工修复，或 bus-cli init --force 重建（会丢现有任务）");
  }

  if (items.length) {
    writeState({ mailSeen: letters.length ? letters[letters.length - 1].id : st.mailSeen, busSeen: [...new Set([...st.busSeen, ...bus.tasks.map((t) => t.id)])] });
    emitTrigger(items);
    if (TOAST) toast(items.length + " 件新件：" + items.slice(0, 2).map((i) => i.kind + " " + i.id).join("；"));
  } else {
    writeState({ mailSeen: st.mailSeen, busSeen: st.busSeen });
  }
  return bus.status === "corrupt" || bus.status === "unreadable" ? 6 : 0;
}

if (INTERVAL && Number(INTERVAL) > 0 && ONCE) {
  console.error("--interval 与 --once 不能同时用");
  process.exit(2);
}

if (INTERVAL && Number(INTERVAL) > 0) {
  const tick = () => { try { run(); } catch (e) { console.error("[watch] error:", e.message); } };
  tick();
  setInterval(tick, Math.max(5, Number(INTERVAL)) * 1000);
  process.on("SIGINT", () => process.exit(0));
  process.on("SIGTERM", () => process.exit(0));
} else {
  process.exitCode = run();
}
