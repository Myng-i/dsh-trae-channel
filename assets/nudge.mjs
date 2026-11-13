#!/usr/bin/env node
/**
 * nudge.mjs — 催办器：把「领了但停住 / 待领超时」的活重新敲门一次。
 *
 * 解决的问题：两边都没有后台守护，TRAE 一轮结束后如果任务做到一半就停，
 * 看门狗只报"有新件"，不会发现"旧件没动"。nudge 按时间判停滞，重复敲门
 * 最多 --max 次，催满就报"需人工介入"，不无限骚扰、也不假装完成。
 *
 * 只读任务板 + 只发一条 CDP 提醒；不 claim、不改状态、不碰信件。
 *
 *   node tools/nudge.mjs                 # 扫一次，有停滞就敲门
 *   node tools/nudge.mjs --dry           # 只打印将要说的话
 *   node tools/nudge.mjs --stale 10 --max 3
 *   node tools/nudge.mjs --reset         # 清空催办记录（不碰任务板）
 *
 * 退出码：0 正常（含"无需催办"）/ 2 参数 / 3 端口不通 / 6 任务板损坏
 */
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { loadLedger, markKnocked, knockedWithin, corruptionNote } from "./knock-ledger.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);

function opt(name, dflt) {
  const i = argv.indexOf("--" + name);
  if (i < 0) return dflt;
  const v = argv[i + 1];
  return v === undefined || v.startsWith("--") ? true : v;
}
const has = (n) => argv.includes("--" + n);

if (has("help") || argv.includes("-h")) {
  console.log([
    "nudge.mjs — 催办停滞的任务（只读板 + 发一条 CDP 提醒）",
    "",
    "  --stale <分钟>   多久算停滞（默认 10）",
    "  --max <次数>     同一项最多催几次（默认 3，之后报需人工介入）",
    "  --as <身份>      看谁的任务（默认 trae-ide；未指派任务也算）",
    "  --port <端口>    CDP 端口（默认 auto，读 DevToolsActivePort）",
    "  --dry            只打印将要说的话，不注入、不记账",
    "  --reset          清空 watch/nudge.json",
    "  --json           机器可读输出",
    "  --quiet          成功时不打印摘要",
    "  --root/--bus/--state  覆盖路径",
    "",
    "退出码：0 正常 / 2 参数 / 3 端口不通 / 6 任务板损坏"
  ].join("\n"));
  process.exit(0);
}

const ROOT = path.resolve(String(opt("root", process.cwd())));
const BUS_DIR = path.resolve(String(opt("bus", process.env.BUS_DIR || path.join(ROOT, "bus"))));
const LEDGER = path.resolve(String(opt("state", path.join(ROOT, "watch", "nudge.json"))));
const AS = String(opt("as", "trae-ide")).toLowerCase();
const STALE_MIN = Math.max(1, Number(opt("stale", 10)) || 10);
const STALE_MS = STALE_MIN * 60000;
const MAX = Math.max(1, Number(opt("max", 3)) || 3);
const PORT = String(opt("port", "auto"));
const DRY = has("dry");
const AS_JSON = has("json");
const QUIET = has("quiet");
const INJECT = path.join(HERE, "trae-inject.mjs");

function loadNudgeLedger() {
  try {
    const j = JSON.parse(fs.readFileSync(LEDGER, "utf8"));
    return j && typeof j === "object" && j.items && typeof j.items === "object" ? j : { items: {} };
  } catch { return { items: {} }; }
}
function saveNudgeLedger(o) {
  fs.mkdirSync(path.dirname(LEDGER), { recursive: true });
  const tmp = LEDGER + ".tmp-" + process.pid;
  fs.writeFileSync(tmp, JSON.stringify(o, null, 2) + "\n");
  fs.renameSync(tmp, LEDGER);
}

if (has("reset")) {
  if (DRY) { console.log("[nudge] --dry 模式不写文件，--reset 未执行"); process.exit(0); }
  saveNudgeLedger({ items: {} });
  console.log("[nudge] 已清空催办记录：" + LEDGER + "（任务板未改动）");
  process.exit(0);
}

process.env.BUS_DIR = BUS_DIR; // bus-store 在模块求值时读 env，必须先设再动态导入
const { stateStatus } = await import(pathToFileURL(path.join(HERE, "bus-store.mjs")).href);

const ss = stateStatus();
if (ss.status === "missing" || ss.status === "empty") {
  if (AS_JSON) console.log(JSON.stringify({ ok: true, boardStatus: ss.status, knocked: [], exhausted: [] }));
  else if (!QUIET) console.log("[nudge] 任务板未初始化，无需催办。");
  process.exit(0);
}
if (ss.status !== "ok") {
  console.error("[nudge] 任务板损坏（" + ss.status + "）：" + ss.path + " — " + (ss.error || "") + "；先修好再催办。");
  process.exit(6);
}

const now = Date.now();
const parseTs = (v) => {
  const t = Date.parse(String(v || ""));
  return Number.isFinite(t) ? t : 0;
};
const ledger = loadNudgeLedger();
const WS_ROOT = path.dirname(BUS_DIR);
const glg = loadLedger(WS_ROOT);
if (glg.status === "corrupt") console.error(corruptionNote(glg));
const stalled = [];
const exhausted = [];

for (const t of ss.state.tasks || []) {
  if (!t || !t.id) continue;
  const assignee = String(t.assignee || "").toLowerCase();
  if (assignee && assignee !== AS) continue;
  const status = String(t.status || "");
  if (!["pending", "claimed", "in_progress"].includes(status)) continue;
  const base = status === "pending" ? (parseTs(t.created_at) || parseTs(t.updated_at)) : parseTs(t.updated_at);
  if (!base) continue;
  const age = now - base;
  if (age < STALE_MS) continue;
  const rec = ledger.items[t.id] || { count: 0, lastAt: 0 };
  if (rec.count >= MAX) { exhausted.push({ id: t.id, title: t.title, status, count: rec.count, ageMin: Math.round(age / 60000) }); continue; }
  if (rec.lastAt && now - rec.lastAt < STALE_MS) continue; // 刚催过，别刷屏
  if (knockedWithin(WS_ROOT, t.id, 2 * 60000)) continue; // 门铃 2 分钟内刚敲过（wake-trae/knock），同一轮不重复注入
  stalled.push({ id: t.id, title: String(t.title || "").slice(0, 24), status, ageMin: Math.round(age / 60000), count: rec.count });
}

stalled.sort((a, b) => b.ageMin - a.ageMin);

if (!stalled.length) {
  if (AS_JSON) console.log(JSON.stringify({ ok: true, boardStatus: "ok", knocked: [], exhausted }));
  else if (!QUIET) console.log("[nudge] 无停滞（阈值 " + STALE_MIN + "min，已催满 " + exhausted.length + " 项）。");
  process.exit(0);
}

const parts = stalled.slice(0, 4).map((x) => x.id + "(" + x.status + " " + x.ageMin + "min)");
const text = "【DSH 催办】" + stalled.length + " 项停在原地：" + parts.join("、") +
  "。请继续推进，或回信说明卡点；做不动就把任务退回 pending 并在 note 里写原因。";

if (AS_JSON) {
  console.log(JSON.stringify({ ok: true, boardStatus: "ok", message: text, knocked: stalled, exhausted, dry: DRY }));
  if (!DRY) {
    for (const x of stalled) {
      const r = ledger.items[x.id] || (ledger.items[x.id] = { count: 0, lastAt: 0 });
      r.count += 1; r.lastAt = now; r.lastStatus = x.status;
    }
    saveNudgeLedger(ledger);
  }
  process.exit(0);
}

if (DRY) {
  console.log("[nudge] would knock: " + text);
  process.exit(0);
}

if (!fs.existsSync(INJECT)) {
  console.error("[nudge] 未找到 trae-inject.mjs，跳过催办（任务板未改动）");
  process.exit(0);
}
const r = spawnSync(process.execPath, [INJECT, "send", "--text", text, "--port", PORT], { encoding: "utf8", timeout: 60000 });
if (r.status !== 0) {
  console.error("[nudge] 催促未送达（exit " + r.status + "）：" + String(r.stderr || "").trim().split("\n")[0]);
  process.exit(3);
}
for (const x of stalled) {
  const rec = ledger.items[x.id] || (ledger.items[x.id] = { count: 0, lastAt: 0 });
  rec.count += 1; rec.lastAt = now; rec.lastStatus = x.status;
}
saveNudgeLedger(ledger);
for (const x of stalled) markKnocked(WS_ROOT, x.id); // 写侧共享：让下一轮 wake-trae 知道这些 id 刚催过
if (!QUIET) console.log("[nudge] 已催 " + stalled.length + " 项（" + stalled.map((x) => x.id + "=" + (x.count + 1) + "/" + MAX).join("、") + "）");
if (exhausted.length) console.error("[nudge] 另有 " + exhausted.length + " 项已催满 " + MAX + " 次仍未动，需人工介入：" + exhausted.map((x) => x.id).join("、"));
process.exit(0);
