#!/usr/bin/env node
// wake-trae.mjs — 出站叫醒：把「欠 TRAE 的活」经 CDP 注进它的聊天框，不抢鼠标。
// 与 watchdog 互补：watchdog 管「我这边有新件」，本工具管「它那边有新活」。
// 只读 mailbox/ 与 bus/，绝不认领、不改业务数据；唯一写的是 watch/traeWake.json 游标。

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { loadLedger, markKnocked, corruptionNote } from "./knock-ledger.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const has = (n) => argv.includes("--" + n);
function opt(name, dflt) {
  const i = argv.indexOf("--" + name);
  if (i < 0) return dflt;
  const v = argv[i + 1];
  return v && !v.startsWith("--") ? v : true;
}
if (has("help") || has("h")) {
  console.log("用法: node tools/wake-trae.mjs [--as trae-ide] [--root DIR] [--port 9222|auto] [--dry] [--reset] [--quiet]");
  console.log("  --dry    只打印将要注入的文案，不发送、不推进游标");
  console.log("  --reset  清空游标（下一次会把当前所有欠件都叫一遍）");
  console.log("  --init   建基线：把现存信件视为已读（不发送），只留未完成的指派任务");
  console.log("退出码: 0 已叫醒或无欠件 / 2 参数错 / 3 无调试端口 / 5 未初始化 / 6 任务板损坏");
  process.exit(0);
}

// --root 优先；否则用脚本所在工作区；两者都不像工作区（没有 bus/ 也没有 mailbox/）时退回 cwd。
// 退回的存在理由：从技能安装目录直接跑 <skills>/dsh-trae-channel/assets/wake-trae.mjs 时，HERE/.. 是技能目录。
function looksLikeWorkspace(d) {
  try { return fs.existsSync(path.join(d, "bus")) || fs.existsSync(path.join(d, "mailbox")); } catch { return false; }
}
const ROOT = path.resolve(String(opt("root", looksLikeWorkspace(path.resolve(HERE, "..")) ? path.resolve(HERE, "..") : process.cwd())));
const AS = String(opt("as", "trae-ide"));
const PORT = opt("port", "auto");
const DRY = has("dry");
const QUIET = has("quiet");
const MAIL = path.join(ROOT, "mailbox");
const BUS = path.join(ROOT, "bus");
const WATCH = path.join(ROOT, "watch");
const STATE = path.join(WATCH, "traeWake.json");

function loadState() {
  try {
    const s = JSON.parse(fs.readFileSync(STATE, "utf8"));
    return { mailSeen: s.mailSeen || null, tasksSeen: Array.isArray(s.tasksSeen) ? s.tasksSeen : [] };
  } catch { return { mailSeen: null, tasksSeen: [] }; }
}
function saveState(s) {
  fs.mkdirSync(WATCH, { recursive: true });
  const tmp = STATE + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(s, null, 2) + "\n", "utf8");
  fs.renameSync(tmp, STATE);
}

// 解析信件 front matter（mailbox.mjs 不导出，这里自己解析）
function parseMail(file) {
  let text = "";
  try { text = fs.readFileSync(file, "utf8"); } catch { return null; }
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  const meta = {};
  if (m) for (const line of m[1].split(/\r?\n/)) {
    const kv = line.match(/^([A-Za-z_][\w-]*):\s*(.*)$/);
    if (kv) meta[kv[1]] = kv[2].trim().replace(/^["']|["']$/g, "");
  }
  const id = meta.id || path.basename(file, ".md");
  return { id, to: (meta.to || "").toLowerCase(), from: meta.from || "", subject: meta.subject || "(无主题)", file };
}
function collectMail() {
  let names = [];
  try { names = fs.readdirSync(MAIL).filter((n) => /^\d{8}-\d{4}-\d+\.md$/.test(n)); } catch { return []; }
  const out = [];
  for (const n of names.sort()) {
    const it = parseMail(path.join(MAIL, n));
    if (!it) continue;
    const to = it.to.split(/[,\s]+/);
    // 排除自发信（from == 本端）：to: all 的广播否则会自己叫醒自己
    if ((it.from || "").toLowerCase() === AS.toLowerCase()) continue;
    if (to.includes(AS.toLowerCase()) || to.includes("all")) out.push(it);
  }
  return out;
}
function collectTasks() {
  const file = path.join(BUS, "state.json");
  let raw;
  try { raw = fs.readFileSync(file, "utf8"); } catch (e) {
    if (e.code === "ENOENT") return { status: "missing", tasks: [] };
    return { status: "unreadable", tasks: [] };
  }
  if (!raw.trim()) return { status: "missing", tasks: [] };
  let st;
  try { st = JSON.parse(raw); } catch { return { status: "corrupt", tasks: [] }; }
  const tasks = (st.tasks || []).filter((t) => t.status === "pending" && (t.assignee || "").toLowerCase() === AS.toLowerCase());
  return { status: "ok", tasks };
}

const st = loadState();
if (has("reset")) { saveState({ mailSeen: null, tasksSeen: [] }); if (!QUIET) console.log("[wake] 游标已清空"); process.exit(0); }
if (has("init")) {
  const all = collectMail();
  const maxMail = all.length ? all[all.length - 1].id : null;
  saveState({ mailSeen: maxMail, tasksSeen: [] });
  if (!QUIET) console.log("[wake] 基线已建：mailSeen=" + (maxMail || "(无)") + "，待办任务下次仍会叫一遍");
  process.exit(0);
}

const mails = collectMail().filter((m) => !st.mailSeen || m.id > st.mailSeen);
const bus = collectTasks();
if (bus.status === "corrupt") { console.error("[wake] 任务板损坏：" + path.join(BUS, "state.json") + "（已拒绝操作，不做任何写入）"); process.exit(6); }
const tasks = bus.tasks.filter((t) => !st.tasksSeen.includes(t.id));
// 读侧共享账本：已经叫过的 id 不再重复注入（防止「先催办后门铃」二次打扰）
const klg = loadLedger(ROOT);
if (klg.status === "corrupt") console.error(corruptionNote(klg));
const known = new Set(klg.ids);
const items = [...tasks.map((t) => ({ kind: "task", id: t.id, subject: t.title || "(无标题)", from: "dsh-lead", to: AS })),
               ...mails.map((m) => ({ kind: "mail", id: m.id, subject: m.subject, from: m.from, to: m.to }))]
  .filter((it) => !known.has(it.id));

if (!items.length) { if (!QUIET) console.log("[wake] 无欠件（" + AS + " 没有新任务、没有新信）"); process.exit(0); }

const head = items.slice(0, 4).map((i) => "[" + i.kind + "] " + i.id + " " + i.subject).join("；");
if (has("verbose") || DRY) for (const it of items) console.log("[wake] " + it.kind + " " + it.id + "  " + it.from + " → " + it.to + "  " + it.subject);
// 命令一律给绝对路径：TRAE 的 cwd 往往不是本工作区，相对路径会让它读自己的 bus/ 或 mailbox/。
const BUS_CLI = path.join(HERE, "bus-cli.mjs");
const MBOX = path.join(HERE, "mailbox.mjs");
const WAKE_DSH = path.join(HERE, "wake-dsh.mjs");
const text = "【DSH 叫醒】新到 " + items.length + " 件：" + head + (items.length > 4 ? " 等" : "") +
  "。工作区：\"" + ROOT + "\"。" +
  "领取：node \"" + BUS_CLI + "\" poll --as trae-ide --claim --bus \"" + path.join(ROOT, "bus") + "\"；" +
  "读信：node \"" + MBOX + "\" inbox --as trae-ide --advance --dir \"" + path.join(ROOT, "mailbox") + "\"。" +
  "**请以这些绝对路径为准，不要用你自己 cwd 下的 bus/ 或 mailbox/** —— cwd 错了读的是别人的板/信箱，而且不会报错，你会以为没活。" +
  "交付/回信后必须回唤 DSH：node \"" + WAKE_DSH + "\" send --text-file <你写的摘要.txt>（CDP 9223；不叫醒 DSH 就不知道你完工）。";

if (DRY) { console.log("[wake] --dry，将注入：\n" + text); process.exit(0); }

const inject = path.join(HERE, "trae-inject.mjs");
if (!fs.existsSync(inject)) { console.error("[wake] 找不到 " + inject); process.exit(2); }
const r = spawnSync(process.execPath, [inject, "send", "--text", text, "--port", String(PORT)], { encoding: "utf8", timeout: 30000 });
if (r.status !== 0) {
  console.error("[wake] 未送达（exit " + r.status + "）：" + ((r.stderr || "").trim().split("\n")[0] || "未知错误"));
  console.error("[wake] 文件已就位，TRAE 下一轮仍能读到；检查 TRAE 是否以 --remote-debugging-port 启动（或 DevToolsActivePort 是否存在）。游标未推进。");
  process.exit(r.status === 3 ? 3 : 1);
}
const maxMail = mails.length ? mails[mails.length - 1].id : st.mailSeen;
saveState({ mailSeen: maxMail, tasksSeen: [...st.tasksSeen, ...tasks.map((t) => t.id)] });
{
  // 记入门铃账本：让 nudge 知道这些 id 刚敲过，避免同一轮二次注入
  const lg = loadLedger(ROOT);
  if (lg.status === "corrupt") console.error(corruptionNote(lg));
  else for (const it of items) markKnocked(ROOT, it.id);
}
if (!QUIET) console.log("[wake] 已通过 CDP 叫醒 " + AS + "（" + items.length + " 件）");
process.exit(0);
