#!/usr/bin/env node
// selfwake.mjs — DSH 侧「按需自唤醒」的开关与熔断器。
// 只在用户明确要求时开启；连续 5 次执行失败自动关闭，必须用户重新开启。
// 它不创建 DSH 定时任务（调度在 DSH 的 schedule 里），只负责：记录开关、跑一次巡检、数失败、熔断。
import fs from "node:fs";
import path from "node:path";
import { execFile, spawnSync } from "node:child_process";

const argv = process.argv.slice(2);
const CMDS = ["status", "enable", "disable", "reset", "tick", "drill", "notify"];
const cmd = argv.find((a) => CMDS.includes(a)) || "status";
function opt(name, def) {
  const i = argv.indexOf("--" + name);
  if (i < 0) return def;
  const v = argv[i + 1];
  return v && !v.startsWith("--") ? v : true;
}
const ROOT = path.resolve(String(opt("root", process.cwd())));
const STATE = path.resolve(String(opt("state", path.join(ROOT, "watch", "selfwake.json"))));
const MAX_FAIL = 5;
const DEFAULT_EVERY = 30;

function read() {
  try {
    const s = JSON.parse(fs.readFileSync(STATE, "utf8"));
    return {
      enabled: !!s.enabled,
      intervalMin: Number(s.intervalMin) || DEFAULT_EVERY,
      failStreak: Number(s.failStreak) || 0,
      maxFail: Number(s.maxFail) >= 1 ? Math.floor(Number(s.maxFail)) : MAX_FAIL,
      lastRun: s.lastRun || null,
      lastOk: s.lastOk || null,
      lastError: s.lastError || null,
      disabledReason: s.disabledReason || null,
      notifyTrae: s.notifyTrae !== false,
    };
  } catch {
    return { enabled: false, intervalMin: DEFAULT_EVERY, failStreak: 0, maxFail: MAX_FAIL, lastRun: null, lastOk: null, lastError: null, disabledReason: null, notifyTrae: true };
  }
}
function save(st) {
  fs.mkdirSync(path.dirname(STATE), { recursive: true });
  const tmp = STATE + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify({ ...st, maxFail: st.maxFail || MAX_FAIL }, null, 2) + "\n");
  fs.renameSync(tmp, STATE);
}
const nowIso = () => new Date().toISOString();

function statusText(st) {
  const on = st.enabled ? "ON " : "OFF";
  return [
    "[selfwake] " + on + "  interval=" + st.intervalMin + "min  failStreak=" + st.failStreak + "/" + (st.maxFail || MAX_FAIL),
    "  lastRun=" + (st.lastRun || "-") + "  lastOk=" + (st.lastOk || "-"),
    st.disabledReason ? "  disabledReason=" + st.disabledReason : "",
    "  notifyTrae=" + (st.notifyTrae ? "on" : "off"),
    st.lastError ? "  lastError=" + String(st.lastError).split("\n")[0] : "",
  ].filter(Boolean).join("\n");
}
function runWakeTrae() {
  const wt = path.resolve(String(opt("wake-trae", path.join(ROOT, "tools", "wake-trae.mjs"))));
  if (!st.notifyTrae || !fs.existsSync(wt)) return;
  const r = spawnSync(process.execPath, [wt, "--port", "auto", "--quiet"], { cwd: ROOT, encoding: "utf8", timeout: 60000 });
  const line = ((r.stdout || "").trim().split("\n")[0] || "").trim();
  if (r.status === 0 && line && !/无欠件/.test(line)) console.log("[selfwake] " + line);
  else if (r.status !== 0) console.error("[selfwake] 出站叫醒未成功（exit " + r.status + "），不影响巡检结果");
}

function runNudge() {
  const nd = path.resolve(String(opt("nudge", path.join(ROOT, "tools", "nudge.mjs"))));
  if (!st.notifyTrae || !fs.existsSync(nd)) return;
  const r = spawnSync(process.execPath, [nd, "--root", ROOT, "--port", "auto", "--quiet"], { cwd: ROOT, encoding: "utf8", timeout: 60000 });
  const line = ((r.stdout || "").trim().split("\n").filter(Boolean)[0] || "").trim();
  if (line && !/无停滞/.test(line)) console.log("[selfwake] " + line);
  else if (r.status === 3) console.error("[selfwake] 催办未能送达（TRAE 端口不通），任务板未改动");
}

function runWatchdog(cb) {
  const wd = path.resolve(String(opt("watchdog", path.join(ROOT, "tools", "watchdog.mjs"))));
  const busDir = opt("bus", null);
  const extra = busDir ? ["--bus", path.resolve(String(busDir))] : [];
  // 看门狗只做只读扫描；出站叫醒交给 wake-trae（它自带扫描与游标，有欠件才注入）
  execFile(process.execPath, [wd, "--root", ROOT, "--once", "--json", ...extra], { cwd: ROOT, timeout: 60000 }, (e, so, se) => {
    cb({ code: e ? (typeof e.code === "number" ? e.code : 1) : 0, out: String(so || ""), err: String(se || "") });
  });
}

const st = read();

if (cmd === "status") {
  console.log(statusText(st));
  process.exit(0);
}
if (cmd === "enable") {
  st.enabled = true;
  st.intervalMin = Math.max(5, Number(opt("every", DEFAULT_EVERY)) || DEFAULT_EVERY);
  st.failStreak = 0;
  st.maxFail = Math.max(1, Number(opt("maxfail", MAX_FAIL)) || MAX_FAIL);
  st.disabledReason = null;
  st.lastError = null;
  save(st);
  console.log("[selfwake] 已开启，间隔 " + st.intervalMin + "min；失败 " + st.maxFail + " 次自动关闭。");
  console.log("  提醒：调度由 DSH 的 schedule 提供，请确认定时任务存在并指向 tick。");
  process.exit(0);
}
if (cmd === "notify") {
  const i = argv.indexOf("notify");
  const v = String(argv[i + 1] || "").trim();
  if (!["on", "off"].includes(v)) { console.error("用法: node tools/selfwake.mjs notify on|off"); process.exit(2); }
  st.notifyTrae = v === "on";
  save(st);
  console.log("[selfwake] notifyTrae=" + v + "（tick 时" + (v === "on" ? "会" : "不会") + "顺带跑 wake-trae，只有欠件才注入）");
  process.exit(0);
}
if (cmd === "disable" || cmd === "reset") {
  st.enabled = false;
  st.failStreak = 0;
  st.disabledReason = String(opt("reason", cmd === "reset" ? "手动重置" : "手动关闭"));
  st.lastError = null;
  save(st);
  console.log("[selfwake] 已关闭（" + st.disabledReason + "）。需要时让用户重新开启。");
  process.exit(0);
}
if (cmd === "tick") {
  if (!st.enabled) {
    console.log("[selfwake] OFF：未开启，忽略本次唤醒（用户要求时才开）。");
    process.exit(0);
  }
  runWatchdog((r) => {
    st.lastRun = nowIso();
    if (r.code === 0) {
      st.failStreak = 0;
      st.lastOk = nowIso();
      st.lastError = null;
      let j = null;
      try { j = JSON.parse(r.out); } catch {}
      if (j && j.newCount > 0) {
        console.log("[selfwake] 有新件 " + j.newCount + " 条：");
        for (const m of j.newMail || []) console.log("  - [mail] " + m.id + "  " + m.subject);
        for (const t of j.newTasks || []) console.log("  - [task] " + t.id + "  " + t.title);
      } else {
        console.log("[selfwake] 无新件。");
      }
      runWakeTrae();
      runNudge();
      save(st);
      process.exit(0);
    }
    st.failStreak += 1;
    let detail = String(r.err || "").trim();
    if (!detail) { try { const j = JSON.parse(r.out); detail = (j.busCorrupt ? "任务板损坏：" : "") + (j.busError || j.error || ""); } catch {} }
    if (!detail) detail = "watchdog exit " + r.code;
    st.lastError = detail.split("\n").slice(0, 2).join(" | ");
    const maxFail = st.maxFail || MAX_FAIL;
    if (st.failStreak >= maxFail) {
      st.enabled = false;
      st.disabledReason = "连续 " + maxFail + " 次执行失败，已自动关闭；需用户重新开启";
      save(st);
      console.log("SELFWAKE_DISABLED: " + st.disabledReason);
      console.log("  最后一次错误：" + st.lastError);
      console.log("  请：1) 暂停/删除对应定时任务；2) 把原因告诉用户，等用户说开再开。");
      process.exit(7);
    }
    save(st);
    console.log("[selfwake] 第 " + st.failStreak + "/" + (st.maxFail || MAX_FAIL) + " 次失败（未熔断）：" + st.lastError);
    process.exit(0);
  });
} else if (cmd === "drill") {
  // 演练：默认用独立状态文件（不碰真实 watch/selfwake.json）；--real 才动真实状态。
  const n = Math.max(1, Number(opt("n", MAX_FAIL)) || MAX_FAIL);
  const real = !!opt("real", false);
  const drillState = real ? STATE : path.join(ROOT, ".tmp", "selfwake-drill-state.json");
  const realSt = read();
  if (real && !realSt.enabled) {
    console.error("[drill] 真实状态当前是 OFF，演练会假成功。先 enable，或去掉 --real 用隔离演练。");
    process.exit(2);
  }
  if (real && n < (realSt.maxFail || MAX_FAIL)) {
    console.error("[drill] --real 演练不缩小阈值：当前 maxFail=" + (realSt.maxFail || MAX_FAIL) + "，请 --n >= " + (realSt.maxFail || MAX_FAIL) + "（或用隔离演练指定阈值）。");
    process.exit(2);
  }
  const busDir = path.join(ROOT, ".tmp", "selfwake-drill-bus");
  fs.mkdirSync(busDir, { recursive: true });
  fs.mkdirSync(path.dirname(drillState), { recursive: true });
  fs.writeFileSync(path.join(busDir, "state.json"), '{"tasks":[', "utf8");
  console.log("[drill] 模式：" + (real ? "真实状态（会真的熔断）" : "隔离状态（不影响真实自唤醒）") + "  状态文件：" + drillState);
  console.log("[drill] 演练板：" + path.join(busDir, "state.json") + "（写坏，只用于制造失败）");
  const call = (args) => new Promise((res) => execFile(process.execPath, [process.argv[1], ...args, "--root", ROOT, "--state", drillState], { cwd: ROOT, timeout: 90000 }, (e, so, se) => res({ code: e ? (typeof e.code === "number" ? e.code : 1) : 0, out: String(so) + String(se) })));
  (async () => {
    if (!real) {
      const en = await call(["enable", "--every", String(read().intervalMin || DEFAULT_EVERY), "--maxfail", String(n)]);
      if (en.code !== 0) { console.error("[drill] 隔离状态 enable 失败：" + en.out.trim()); process.exit(1); }
    }
    let fired = false;
    for (let i = 1; i <= n; i++) {
      const r = await call(["tick", "--bus", busDir]);
      console.log("[drill " + i + "/" + n + "] exit=" + r.code + " | " + r.out.trim().split("\n")[0]);
      if (r.code === 7) { fired = true; break; }
    }
    let st2;
    try { st2 = JSON.parse(fs.readFileSync(drillState, "utf8")); } catch { st2 = {}; }
    console.log("\n[drill] 结果：enabled=" + st2.enabled + " failStreak=" + (st2.failStreak || 0) + "/" + (st2.maxFail || n) + (st2.disabledReason ? " reason=" + st2.disabledReason : ""));
    if (!fired) {
      console.error("[drill] 未触发熔断——计数器或开关不符预期，这是失败，不是通过。");
      try { fs.rmSync(busDir, { recursive: true, force: true }); if (!real) fs.rmSync(drillState, { force: true }); } catch {}
      process.exit(1);
    }
    console.log("[drill] 已熔断（exit 7），计数器与自动关闭均生效。");
    if (real) console.log("[drill] 真实自唤醒已关闭。恢复：node tools/selfwake.mjs enable --every " + (st2.intervalMin || DEFAULT_EVERY));
    else console.log("[drill] 隔离演练，真实自唤醒状态未变（status 可核对）。");
    try { fs.rmSync(busDir, { recursive: true, force: true }); if (!real) fs.rmSync(drillState, { force: true }); } catch {}
  })();
} else {
  console.error("用法: node tools/selfwake.mjs [status|enable [--every 30] [--maxfail 5]|notify on|off|disable [--reason 文本]|reset|tick [--bus <板目录>]|drill [--n 5] [--real]] [--root <工作区>]");
  process.exit(2);
}
