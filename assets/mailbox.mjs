#!/usr/bin/env node
/**
 * mailbox.mjs — DSH ⇄ TRAE 信件信箱（零依赖，跨平台）
 *
 * 为什么用它：任务是"要执行的事"，信是"要谈拢的事"。商量通信方案本身，
 * 用信箱最稳：每个信件是一个独立文件，只增不改，没有锁竞争，谁先写谁先有。
 *
 * 目录：<root>/mailbox/<id>.md   （id = YYYYMMDD-HHMM-<seq3>）
 * 索引：<root>/mailbox/INDEX.md  （生成物，随时可重建，不手改）
 *
 * 用法：
 *   node tools/mailbox.mjs post --from dsh-lead --to trae-ide --subject "..." --body "..." [--thread design] [--re <id>]
 *   node tools/mailbox.mjs post --stdin --from dsh-lead --to trae-ide   # 从 stdin 读整封信
 *   node tools/mailbox.mjs post --body-file body.md --from dsh-lead --to trae-ide --subject "..."
 *   node tools/mailbox.mjs inbox --as trae-ide [--after <id>] [--advance] [--limit N] [--json]
 *   node tools/mailbox.mjs read <id>
 *   node tools/mailbox.mjs reply <id> --from trae-ide --body "..." [--body-file f.md]
 *   node tools/mailbox.mjs index
 *   node tools/mailbox.mjs threads [--json]
 */
import fs from "node:fs";
import { resolveWorkspace, loadLedger, markKnocked, corruptionNote } from "./knock-ledger.mjs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));

const argv = process.argv.slice(2);
const cmd = argv[0];
const rest = argv.slice(1);
function opt(name, dflt) {
  const i = rest.indexOf("--" + name);
  if (i < 0) return dflt;
  const v = rest[i + 1];
  if (v === undefined || v.startsWith("--")) return true;
  return v;
}

// 信箱目录：--dir 优先，其次 MAILBOX_DIR，最后 <cwd>/mailbox。
// --dir 是给「调用方 cwd 不等于信件所在工作区」准备的（TRAE 被叫醒时在自己工作区，读不到别人的信箱）。
const DIR_OPT = opt("dir");
if (DIR_OPT === true) { console.error("[mailbox] --dir 需要目录，例如 --dir <工作区>/mailbox"); process.exit(2); }
const ROOT = path.resolve(String(DIR_OPT || process.env.MAILBOX_DIR || path.join(process.cwd(), "mailbox")));
const INDEX = path.join(ROOT, "INDEX.md");
const SELF = path.join(HERE, "mailbox.mjs");
// 读命令不建目录：cwd 不对时静默建出一个空信箱，「没信」就是假象（TRAE 复验抓过）。
function ensureRootForWrite() {
  if (!fs.existsSync(ROOT)) fs.mkdirSync(ROOT, { recursive: true });
}
function requireRoot(cmdName) {
  let st = null;
  try { st = fs.statSync(ROOT); } catch {}
  if (st && st.isDirectory()) return;
  console.error((st ? "[mailbox] 信箱路径不是目录：" : "[mailbox] 信箱不存在：") + ROOT);
  console.error("[mailbox] 若信件在别的工作区，用绝对路径：node \"" + SELF + "\" " + cmdName + " --dir \"<工作区>/mailbox\" ...");
  console.error("[mailbox] 这里不替你建空信箱：读不到信通常说明 cwd 不对（也可能信还没到）。");
  process.exit(5);
}
// 敲门（CDP）：只发「引用 id 的提醒」，不承载正文。正文永远在 mailbox/ 里。
// --wake 把「落盘」与「敲门」合成一步，消除「先敲门、后投件」的时序竞态（TRAE 曾因此在 inbox 里查不到）。
function knockTrae({ id, subject, to, from }) {
  // 方向过滤：收件方自己写的信不敲门（否则 to: all 广播会自叫醒，TRAE 复验抓过）
  if (String(from || "").toLowerCase() === "trae-ide" || String(to || "").toLowerCase() === "dsh-lead") {
    console.error("[mailbox] 这是发给自己的信（from=" + (from || "?") + " to=" + to + "），跳过敲门");
    return;
  }
  // 幽灵 id 守卫：MAILBOX_DIR 指向隔离信箱时，id 在对方信箱里不存在，敲门等于宣告一个读不到的号。
  if (process.env.MAILBOX_DIR && opt("wake-force") === undefined) {
    console.error("[mailbox] 隔离信箱（MAILBOX_DIR=" + ROOT + "）默认不敲门：CDP 提醒是全局的，这里的 id 对方读不到。要试敲门加 --wake-force。信件已落盘。");
    return;
  }
  // 重复敲门去重 + 损坏账本守卫（TRAE T-000022 / 0155 复核）
  const WS = resolveWorkspace(ROOT);
  const lg = loadLedger(WS);
  if (lg.status === "corrupt") { console.error(corruptionNote(lg)); return "corrupt"; }
  if (lg.ids.includes(id)) {
    console.error("[mailbox] " + id + " 已通知过，跳过重复敲门（要重发先删 watch/knock-notified.json）");
    return;
  }
  // 绝对路径 + 可复制的命令：收信方可能不在这个工作区（cwd 不同），只给相对路径它会读自己的信箱。
  const self = path.join(HERE, "mailbox.mjs");
  const text = "【DSH 叫醒】新信 " + id + "（" + to + "）：" + String(subject).slice(0, 60) +
    "。信箱目录：\"" + ROOT + "\"；读取：node \"" + self + "\" inbox --as trae-ide --advance --dir \"" + ROOT + "\"。" +
    "请以此绝对路径为准，不要用你自己 cwd 下的 mailbox/；正文只在文件里。";
  if (process.env.MAILBOX_WAKE_DRY === "1") { console.log("[wake] would knock: " + text); return; }
  const inj = path.join(HERE, "trae-inject.mjs");
  if (!fs.existsSync(inj)) { console.error("[mailbox] 未找到 trae-inject.mjs，跳过敲门（信件已落盘，不影响投递）"); return; }
  const r = spawnSync(process.execPath, [inj, "send", "--text", text], { encoding: "utf8", timeout: 60000 });
  if (r.status === 0) { markKnocked(WS, id); console.error("[mailbox] 已叫醒 TRAE（" + id + "）"); }
  else console.error("[mailbox] 敲门失败（exit " + r.status + "）：信件已落盘，对方下一轮仍能读到");
}

const positional = rest.filter((a, i) => !a.startsWith("--") && !(i > 0 && rest[i - 1].startsWith("--")));

function normBody(b) {
  return String(b || "").replace(/^\uFEFF/, "").replace(/\r\n/g, "\n").replace(/\u0000/g, "").trim();
}
function guardBody(body, allowEmpty) {
  if (!body) {
    if (allowEmpty) return;
    console.error("[mailbox] 拒绝写入空正文：请用 --body <文本> / --body-file <文件> / --stdin（确实要发空信加 --allow-empty）");
    process.exit(4);
  }
  if (body.length < 20) console.error("[mailbox] 警告：正文只有 " + body.length + " 字符，确认不是参数没传进去？");
}
function pad(n, w) { return String(n).padStart(w || 2, "0"); }
function localIso() {
  const d = new Date();
  const off = -d.getTimezoneOffset();            // 分钟，东八区 = +480
  const sign = off >= 0 ? "+" : "-";
  const ah = pad(Math.floor(Math.abs(off) / 60)), am = pad(Math.abs(off) % 60);
  return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate()) +
    "T" + pad(d.getHours()) + ":" + pad(d.getMinutes()) + ":" + pad(d.getSeconds()) + sign + ah + ":" + am;
}
function newId() {
  const d = new Date();
  const stamp = d.getFullYear() + pad(d.getMonth() + 1) + pad(d.getDate()) + "-" + pad(d.getHours()) + pad(d.getMinutes());
  let max = 0;
  for (const f of fs.readdirSync(ROOT)) {
    const m = f.match(/^(\d{8}-\d{4})-(\d{3})\.md$/);
    if (m && m[1] === stamp) max = Math.max(max, Number(m[2]));
  }
  return stamp + "-" + pad(max + 1, 3);
}
function parse(file) {
  const raw = fs.readFileSync(path.join(ROOT, file), "utf8").replace(/^\uFEFF/, "");
  const m = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  const meta = {};
  let body = raw;
  if (m) {
    for (const line of m[1].split(/\r?\n/)) {
      const i = line.indexOf(":");
      if (i > 0) meta[line.slice(0, i).trim()] = line.slice(i + 1).trim().replace(/^"|"$/g, "");
    }
    body = m[2];
  }
  return { file, id: meta.id || file.replace(/\.md$/, ""), meta, body: body.trim() };
}
function letters() {
  return fs.readdirSync(ROOT).filter((f) => /\.md$/.test(f) && f !== "INDEX.md").map(parse).sort((a, b) => a.id.localeCompare(b.id));
}
function write(meta, body) {
  // id 唯一性靠 'wx' 独占创建保证：同分钟并发发信不会算出同一个 seq 相互覆盖。
  let id = null, fd = null;
  for (let attempt = 0; attempt < 50 && fd === null; attempt++) {
    id = newId();
    try { fd = fs.openSync(path.join(ROOT, id + ".md"), "wx"); }
    catch (e) { if (e.code !== "EEXIST") throw e; }
  }
  if (fd === null) { console.error("[mailbox] 无法分配唯一 id（50 次撞名）"); process.exit(5); }
  const fm = ["---", "id: " + id,
    "from: " + (meta.from || "unknown"),
    "to: " + (meta.to || "all"),
    "subject: " + (meta.subject || "(no subject)"),
    "thread: " + (meta.thread || "general"),
    "re: " + (meta.re || ""),
    "created: " + localIso(),
    "---", ""].join("\n");
  fs.writeFileSync(fd, fm + body.trim() + "\n", "utf8");
  fs.closeSync(fd);
  buildIndex();
  return id;
}
function cursorPath(agent) { return path.join(ROOT, ".cursor-" + agent); }
function readCursor(agent) { try { return fs.readFileSync(cursorPath(agent), "utf8").trim() || null; } catch { return null; } }
function writeCursor(agent, id) {
  try { fs.writeFileSync(cursorPath(agent), id + "\n", "utf8"); } catch (e) { console.error("[mailbox] 游标写入失败：" + e.message); }
}
function buildIndex() {
  const all = letters();
  const lines = ["# 信箱索引", "", "> 生成物，勿手改。重建：node tools/mailbox.mjs index", "",
    "共 " + all.length + " 封，" + new Set(all.map((l) => l.meta.thread)).size + " 个线程。", "",
    "| id | 时间 | 发件 | 收件 | 主题 | 线程 |", "|---|---|---|---|---|---|"];
  const cell = (v) => String(v || "").replace(/\|/g, "\\|");
  for (const l of all) {
    lines.push("| " + cell(l.id) + " | " + cell((l.meta.created || "").slice(0, 16).replace("T", " ")) + " | " + cell(l.meta.from) +
      " | " + cell(l.meta.to) + " | " + cell(l.meta.subject) + " | " + cell(l.meta.thread) + " |");
  }
  fs.writeFileSync(INDEX, lines.join("\n") + "\n", "utf8");
}
function show(l, brief) {
  if (brief) {
    const th = l.meta.thread || "";
    const tag = th && !String(l.meta.subject || "").includes("[" + th + "]") ? "[" + th + "] " : "";
    return l.id + "  " + (l.meta.created || "").slice(0, 16).replace("T", " ") + "  " + (l.meta.from || "?") + " → " + (l.meta.to || "?") + "  " + tag + (l.meta.subject || "");
  }
  if (!l.body) return ["# " + l.id + "  " + (l.meta.subject || ""), "",
    "- from: " + (l.meta.from || ""), "- to: " + (l.meta.to || ""), "- created: " + (l.meta.created || ""),
    "", "---", "", "⚠ 正文为空（2026-11-12 之前 post 不认 --body-file 导致丢件；看同一线程的后续信件）"].join("\n");
  return ["# " + l.id + "  " + (l.meta.subject || ""), "",
    "- from: " + (l.meta.from || ""), "- to: " + (l.meta.to || ""), "- thread: " + (l.meta.thread || ""),
    "- re: " + (l.meta.re || "-"), "- created: " + (l.meta.created || ""), "", "---", "", l.body].join("\n");
}

if (cmd === "--help" || cmd === "-h" || cmd === "help") {
  console.log(["mailbox.mjs — DSH ⇄ TRAE 信件信箱",
    "",
    "  post   --from <a> --to <b> --subject <s> [--thread t] [--body 文本 | --body-file 文件 | --stdin]",
    "  inbox  --as <a> [--after <id>] [--advance] [--limit N] [--json]",
    "  read   <id>",
    "  reply  <id> --from <a> [--body 文本 | --body-file 文件]",
    "  threads [--json]",
    "  index",
    "",
    "  退出码：0 成功；1 信件不存在；2 参数错；4 空正文被拒；5 信箱不存在（读命令不建目录）/ 游标或唯一 id 失败；6 门铃账本损坏。"].join("\n"));
  process.exit(0);
}

switch (cmd) {
  case "post": {
    ensureRootForWrite();
    let inline = {};
    if (opt("stdin")) {
      const raw = fs.readFileSync(0, "utf8").replace(/^\uFEFF/, "");
      const m = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
      if (m) {
        for (const line of m[1].split(/\r?\n/)) { const i = line.indexOf(":"); if (i > 0) inline[line.slice(0, i).trim()] = line.slice(i + 1).trim(); }
        inline.body = m[2].trim();
      } else inline.body = raw.trim();
    }
    let body = opt("body") || inline.body || "";
    const bf = opt("body-file");
    if (bf && bf !== true) body = fs.readFileSync(bf, "utf8");
    body = normBody(body);
    guardBody(body, opt("allow-empty") === true);
    const id = write({
      from: opt("from") || inline.from || "unknown",
      to: opt("to") || inline.to || "all",
      subject: opt("subject") || inline.subject || "(no subject)",
      thread: opt("thread") || inline.thread || "general",
      re: opt("re") || inline.re || ""
    }, body);
    console.log(id);
    if (opt("wake") !== undefined) {
      const k = knockTrae({ id, subject: opt("subject") || inline.subject || "(no subject)", to: opt("to") || inline.to || "all", from: opt("from") || inline.from || "" });
      if (k === "corrupt") { console.error("[mailbox] 信件已落盘（" + id + "）；exit 6 只表示门铃账本损坏，不影响投递。"); process.exit(6); }
    }
    break;
  }
  case "knock": {
    requireRoot("knock");
    // 补敲门：给一封已存在的信重发提醒（不会重复，除非删 ledger 或 --wake-force 前先清）
    const id = positional[0];
    if (!id) { console.error("[mailbox] 用法: knock <信件id> [--wake-force]"); process.exit(2); }
    const files = fs.readdirSync(ROOT).filter((f) => f.endsWith(".md") && f.includes(id));
    if (!files.length) { console.error("[mailbox] 找不到信件 " + id + "（在 " + ROOT + "）"); process.exit(1); }
    const raw = fs.readFileSync(path.join(ROOT, files[0]), "utf8");
    const fm = (raw.split(/^---\s*$/m)[1] || "");
    const pick = (k) => { const r = new RegExp("^" + k + ":\\s*(.+)$", "m").exec(fm); return r ? r[1].trim() : ""; };
    const k = knockTrae({ id, subject: pick("subject") || "(no subject)", to: pick("to") || "all", from: pick("from") || "" });
    if (k === "corrupt") process.exit(6);
    process.exit(0);
  }
  case "inbox": {
    requireRoot("inbox");
    const me = opt("as") || process.env.AGENT_NAME || "unknown";
    const advance = opt("advance") === true;
    let after = opt("after");
    if (advance && (after === undefined || after === true)) {
      after = readCursor(me);
      if (!after) console.error("[mailbox] 无游标（" + cursorPath(me) + "），本次全量列出并写入游标");
    }
    let all = letters().filter((l) => l.meta.to === me || l.meta.to === "all" || l.meta.to === "*");
    if (after && after !== true) all = all.filter((l) => l.id.localeCompare(String(after)) > 0);
    const lim = Number(opt("limit", 0)) || 0;
    if (lim > 0) all = all.slice(-lim);
    if (advance) {
      // 只推进到"本轮真的列出来"的最大 id：写全箱最大 id 会在并发写盘时越过尚未落盘的
      // 低序号信件（同分钟竞态），等于永久漏读；空轮不推进，否则等于批量判死刑。
      const last = all.at(-1);
      if (last) writeCursor(me, last.id);
      else console.error("[mailbox] 本轮无新信，游标不推进（" + (readCursor(me) || "-") + "）");
    }
    if (opt("json")) { console.log(JSON.stringify(all.map((l) => l.meta), null, 2)); break; }
    if (!all.length) { console.log("no letters for " + me); break; }
    for (const l of all) console.log(show(l, true));
    break;
  }
  case "read": {
    requireRoot("read");
    const id = positional[0];
    const l = letters().find((x) => x.id === id || x.id.startsWith(id));
    if (!l) { console.error("no such letter: " + id); process.exit(1); }
    console.log(show(l, false));
    break;
  }
  case "reply": {
    requireRoot("reply");
    const id = positional[0];
    const orig = letters().find((x) => x.id === id || x.id.startsWith(id));
    if (!orig) { console.error("no such letter: " + id); process.exit(1); }
    let body = opt("body") || "";
    const bf = opt("body-file");
    if (bf && bf !== true) body = fs.readFileSync(bf, "utf8");
    body = normBody(body);
    guardBody(body, opt("allow-empty") === true);
    const newId = write({
      from: opt("from") || "unknown",
      to: opt("to") || orig.meta.from,
      // 已有 Re: 前缀就沿用，避免 "Re: Re: Re:" 越滚越长（trae-ide 提的外观项）
      subject: opt("subject") || (/^re:\s*/i.test(String(orig.meta.subject || "")) ? String(orig.meta.subject) : "Re: " + (orig.meta.subject || "")),
      thread: opt("thread") || orig.meta.thread || "general",
      re: orig.id
    }, body);
    console.log(newId);
    break;
  }
  case "threads": {
    requireRoot("threads");
    const all = letters();
    const map = new Map();
    for (const l of all) {
      const t = l.meta.thread || "general";
      if (!map.has(t)) map.set(t, []);
      map.get(t).push(l);
    }
    if (opt("json")) { console.log(JSON.stringify([...map].map(([t, ls]) => ({ thread: t, count: ls.length, last: ls.at(-1).id })), null, 2)); break; }
    for (const [t, ls] of map) console.log(t + "  (" + ls.length + " 封)  最新 " + ls.at(-1).id + "  " + (ls.at(-1).meta.subject || ""));
    break;
  }
  case "index":
    ensureRootForWrite();
    buildIndex();
    console.log("index rebuilt: " + INDEX);
    break;
  default:
    console.log("usage: mailbox.mjs post|inbox|read|reply|threads|index  (--from/--to/--subject/--body/--stdin)");
    process.exit(cmd ? 2 : 0);
}
