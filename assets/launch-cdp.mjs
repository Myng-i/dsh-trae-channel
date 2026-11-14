#!/usr/bin/env node
/**
 * launch-cdp.mjs — 一键带 CDP 调试端口启动 DSH 桌面端 + TRAE CN，并等到两端都能被注入。
 *
 * CDP 注入（wake-dsh / wake-trae / trae-inject）要求应用「启动时」带 --remote-debugging-port，
 * 事后补不了。本脚本负责：状态体检 → 需要时带端口启动 → 等端口/页面目标就绪 → 写 cdp/state.json。
 *
 * 用法（双击用根目录 start-cdp.cmd / restart-cdp.cmd）：
 *   node tools/launch-cdp.mjs                  # 两个都起；已在跑且带 CDP 的只体检
 *   node tools/launch-cdp.mjs --check          # 只体检（全就绪才 exit 0），不启动
 *   node tools/launch-cdp.mjs --dry            # 只打印可执行文件、当前状态、将执行的命令
 *   node tools/launch-cdp.mjs --restart        # 在跑但没开 CDP 的，关掉重开（会结束 DSH 会话，慎用）
 *   node tools/launch-cdp.mjs --ask            # 同上，但先逐个问 y/N（双击 start-cdp.cmd 默认带）
 *   node tools/launch-cdp.mjs --only trae      # 只处理一个（dsh|trae|both）
 *   node tools/launch-cdp.mjs --dsh-port 9223 --trae-port 9222 --timeout 60
 *   node tools/launch-cdp.mjs --dsh-user-data-dir <目录>   # 独立 profile 起第二套（不动主实例）
 *
 * 退出码：0 就绪 / 2 参数错 / 3 在跑但没开 CDP（或端口被别人占）/ 4 找不到可执行文件
 *         5 启动后端口没起来（超时）/ 6 CDP 探针失败 / 7 端口被其它程序占用
 */
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { spawn, execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const STATE_DIR = path.join(ROOT, "cdp");
const STATE_FILE = path.join(STATE_DIR, "state.json");
const APPDATA = process.env.APPDATA || (process.env.USERPROFILE ? path.join(process.env.USERPROFILE, "AppData", "Roaming") : "");
const LOCALAPPDATA = process.env.LOCALAPPDATA || (process.env.USERPROFILE ? path.join(process.env.USERPROFILE, "AppData", "Local") : "");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const APPS = {
  dsh: {
    key: "dsh", label: "DSH", exeName: "DeepSeek Harness.exe", env: "DSH_EXE",
    uddName: "@deepseek-ai\\dsh-desktop",
    cands: [
      path.join(LOCALAPPDATA, "Programs", "DeepSeek Harness", "DeepSeek Harness.exe"),
      path.join(process.env.ProgramFiles || "C:\\Program Files", "DeepSeek Harness", "DeepSeek Harness.exe"),
    ],
    ua: /dsh-desktop|DeepSeek Harness/i,
  },
  trae: {
    key: "trae", label: "TRAE", exeName: "Trae CN.exe", env: "TRAE_EXE",
    uddName: "Trae CN",
    cands: [
      path.join(LOCALAPPDATA, "Programs", "Trae CN", "Trae CN.exe"),
      path.join(process.env.ProgramFiles || "C:\\Program Files", "Trae CN", "Trae CN.exe"),
      path.join(process.env.ProgramFiles || "C:\\Program Files", "Trae", "Trae.exe"),
    ],
    ua: /TraeCN|Trae CN/i,
  },
};

// ---------------- 参数 ----------------
const KNOWN_FLAGS = new Set(["--check", "--dry", "--restart", "--ask", "--json", "--help", "-h"]);
const KNOWN_VALUED = new Set(["--only", "--dsh-port", "--trae-port", "--timeout", "--dsh-exe", "--trae-exe", "--dsh-user-data-dir", "--trae-user-data-dir"]);

function parseArgs() {
  const a = { check: false, dry: false, restart: false, ask: false, json: false, help: false,
    only: "both", dshPort: 9223, traePort: 9222, timeout: 60, exes: {}, udds: {} };
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (t === "--help" || t === "-h") { a.help = true; continue; }
    if (KNOWN_FLAGS.has(t)) { a[t.slice(2)] = true; continue; }
    if (KNOWN_VALUED.has(t)) {
      const v = argv[i + 1];
      if (v === undefined || v.startsWith("--")) { console.error("[cdp] 参数 " + t + " 缺少取值"); process.exit(2); }
      i++;
      if (t === "--only") a.only = v.toLowerCase();
      else if (t === "--dsh-port") a.dshPort = Number(v);
      else if (t === "--trae-port") a.traePort = Number(v);
      else if (t === "--timeout") a.timeout = Number(v);
      else if (t === "--dsh-exe") a.exes.dsh = v;
      else if (t === "--trae-exe") a.exes.trae = v;
      else if (t === "--dsh-user-data-dir") a.udds.dsh = v;
      else if (t === "--trae-user-data-dir") a.udds.trae = v;
      continue;
    }
    console.error("[cdp] 未知参数：" + t);
    process.exit(2);
  }
  return a;
}

const args = parseArgs();

if (args.help) {
  console.log([
    "launch-cdp.mjs — 带 CDP 调试端口启动 DSH + TRAE",
    "",
    "  node tools/launch-cdp.mjs [--only dsh|trae|both] [--check] [--dry] [--restart|--ask] [--json]",
    "      [--dsh-port 9223] [--trae-port 9222] [--timeout 60]",
    "      [--dsh-exe <路径>] [--trae-exe <路径>]",
    "      [--dsh-user-data-dir <目录>] [--trae-user-data-dir <目录>]",
    "",
    "退出码：0 就绪 / 2 参数错 / 3 在跑但没开 CDP / 4 找不到可执行文件 / 5 超时 / 6 探针失败 / 7 端口被占",
  ].join("\n"));
  process.exit(0);
}

if (!["both", "dsh", "trae"].includes(args.only)) { console.error("[cdp] --only 只能是 dsh / trae / both"); process.exit(2); }
if (!Number.isInteger(args.dshPort) || args.dshPort < 1 || args.dshPort > 65535) { console.error("[cdp] --dsh-port 非法"); process.exit(2); }
if (!Number.isInteger(args.traePort) || args.traePort < 1 || args.traePort > 65535) { console.error("[cdp] --trae-port 非法"); process.exit(2); }
if (args.dshPort === args.traePort) { console.error("[cdp] 两个端口不能相同"); process.exit(2); }
if (!Number.isFinite(args.timeout) || args.timeout <= 0) { console.error("[cdp] --timeout 非法"); process.exit(2); }

const powershell = path.join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");

function psLines(script) {
  try {
    const out = execFileSync(powershell, ["-NoProfile", "-NonInteractive", "-Command", script], { encoding: "utf8", timeout: 20000, windowsHide: true });
    return out.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  } catch {
    return [];
  }
}

function scanProcs(app) {
  const q = "$ErrorActionPreference='SilentlyContinue'; Get-CimInstance Win32_Process -Filter \"Name='" + app.exeName + "'\" | ForEach-Object { '{0}|{1}' -f $_.ProcessId, $_.CommandLine }";
  return psLines(q)
    .map((line) => { const i = line.indexOf("|"); return i < 0 ? null : { ProcessId: Number(line.slice(0, i)), CommandLine: line.slice(i + 1) }; })
    .filter(Boolean)
    .filter((p) => Number.isFinite(p.ProcessId))
    .filter((p) => !/--type=/.test(p.CommandLine || ""))
    .filter((p) => !/subprocess-local|runner\.js|--max-old-space-size/.test(p.CommandLine || ""));
}

function portOpen(port) {
  return new Promise((resolve) => {
    const s = net.connect({ host: "127.0.0.1", port, timeout: 700 });
    s.once("connect", () => { s.destroy(); resolve(true); });
    s.once("timeout", () => { s.destroy(); resolve(false); });
    s.once("error", () => { s.destroy(); resolve(false); });
  });
}

async function waitPortFree(port, ms) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (!(await portOpen(port))) return true;
    await sleep(200);
  }
  return !(await portOpen(port));
}

async function devtoolsVersion(port, ms = 2000) {
  try {
    const r = await fetch("http://127.0.0.1:" + port + "/json/version", { signal: AbortSignal.timeout(ms) });
    if (!r.ok) return null;
    const j = await r.json();
    return { ua: j["User-Agent"] || "", ws: j.webSocketDebuggerUrl || "" };
  } catch {
    return null;
  }
}

async function devtoolsTargets(port, ms = 2000) {
  try {
    const r = await fetch("http://127.0.0.1:" + port + "/json/list", { signal: AbortSignal.timeout(ms) });
    if (!r.ok) return [];
    const list = await r.json();
    return (Array.isArray(list) ? list : []).filter((t) => t && (t.type === "page" || t.type === "webview"));
  } catch {
    return [];
  }
}

function devtoolsPortFile(app, udd) {
  const base = udd ? path.resolve(udd) : path.join(APPDATA, app.uddName);
  for (const p of [path.join(base, "DevToolsActivePort"), path.join(base, "DevToolsActivePort.txt")]) {
    try { const first = fs.readFileSync(p, "utf8").split(/\r?\n/)[0].trim(); if (/^\d+$/.test(first)) return Number(first); } catch {}
  }
  return null;
}

// 机器相关的可执行文件路径不写包内：放 <root>/cdp/launch.config.json（cdp/ 默认 gitignore）
// {"dshExe":"D:\\TOOL\\...\\DeepSeek Harness.exe","traeExe":"D:\\software\\Trae CN\\Trae CN.exe"}
let CONFIG = null;
function loadConfig() {
  if (CONFIG !== null) return CONFIG;
  CONFIG = {};
  for (const f of [path.join(STATE_DIR, "launch.config.json"), path.join(ROOT, "launch.config.json")]) {
    try {
      const raw = JSON.parse(fs.readFileSync(f, "utf8"));
      const dsh = raw.dshExe || (raw.dsh && raw.dsh.exe);
      const trae = raw.traeExe || (raw.trae && raw.trae.exe);
      if (dsh) CONFIG.dsh = dsh;
      if (trae) CONFIG.trae = trae;
      if (dsh || trae) return CONFIG;
    } catch {}
  }
  return CONFIG;
}

function onPath(name) {
  try {
    const cmd = process.platform === "win32" ? "where" : "which";
    const out = execFileSync(cmd, [name], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    const first = String(out).split(/\r?\n/).map((l) => l.trim()).find((l) => l && fs.existsSync(l));
    return first || null;
  } catch { return null; }
}

function discoverExe(app) {
  const explicit = args.exes[app.key] || process.env[app.env];
  if (explicit) {
    if (fs.existsSync(explicit)) return { exe: path.resolve(explicit), from: args.exes[app.key] ? "参数" : app.env };
    return null;
  }
  const cfg = loadConfig()[app.key];
  if (cfg && fs.existsSync(cfg)) return { exe: path.resolve(cfg), from: "cdp/launch.config.json" };
  const procs = scanProcs(app);
  if (procs.length) {
    const out = psLines("$ErrorActionPreference='SilentlyContinue'; (Get-Process -Id " + procs[0].ProcessId + ").Path");
    if (out[0] && fs.existsSync(out[0])) return { exe: out[0], from: "运行中的进程" };
  }
  for (const c of app.cands) if (c && fs.existsSync(c)) return { exe: c, from: "常见安装路径" };
  const inPath = onPath(app.exeName);
  if (inPath) return { exe: inPath, from: "PATH" };
  return null;
}

async function inspect(app, udd) {
  const resolvedUdd = udd ? path.resolve(udd) : null;
  let procs = scanProcs(app);
  if (resolvedUdd) procs = procs.filter((p) => (p.CommandLine || "").toLowerCase().includes(resolvedUdd.toLowerCase()));
  const ports = [];
  if (!resolvedUdd) {
    for (const p of procs) {
      const m = /--remote-debugging-port=(\d+)/.exec(p.CommandLine || "");
      if (m && !ports.includes(Number(m[1]))) ports.push(Number(m[1]));
    }
  }
  if (!ports.includes(app.port)) ports.push(app.port);
  const filePort = resolvedUdd ? null : devtoolsPortFile(app, null);
  if (filePort && !ports.includes(filePort)) ports.push(filePort);

  for (const port of ports) {
    if (!(await portOpen(port))) continue;
    const v = await devtoolsVersion(port);
    if (!v) continue;
    if (app.ua.test(v.ua)) return { state: "ready", port, version: v, procs };
    return { state: "foreign", foreignPort: port, foreignUA: v.ua, procs };
  }
  if (procs.length) return { state: "needs_restart", procs };
  return { state: "stopped", procs: [] };
}

function taskkill(pid, force) {
  try { execFileSync("taskkill", ["/PID", String(pid), "/T"].concat(force ? ["/F"] : []), { stdio: "ignore", timeout: 15000, windowsHide: true }); } catch {}
}

async function stopApp(app, udd) {
  const scope = () => {
    const all = scanProcs(app);
    if (!udd) return all;
    // 命令行里的路径可能是正斜杠也可能是反斜杠，统一后再比，否则 --user-data-dir 传正斜杠时会匹配不到
    const norm = (v) => String(v || "").replace(/\\/g, "/").toLowerCase();
    const want = norm(path.resolve(udd));
    return all.filter((p) => norm(p.CommandLine).includes(want));
  };
  const procs = scope();
  if (!procs.length) return { forced: false };
  for (const p of procs) taskkill(p.ProcessId, false);
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) { if (!scope().length) return { forced: false }; await sleep(300); }
  for (const p of scope()) taskkill(p.ProcessId, true);
  const dl2 = Date.now() + 6000;
  while (Date.now() < dl2) { if (!scope().length) return { forced: true }; await sleep(300); }
  return { forced: true };
}

function spawnApp(app, exe) {
  const argv = ["--remote-debugging-port=" + app.port, "--remote-allow-origins=*"];
  if (args.udds[app.key]) argv.push("--user-data-dir=" + path.resolve(args.udds[app.key]));
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(exe, argv, { detached: true, stdio: "ignore", cwd: path.dirname(exe), env });
  child.unref();
  return { pid: child.pid, argv, exe };
}

async function startAndWait(app, exe, timeoutMs) {
  let last = null;
  for (let attempt = 1; attempt <= 2; attempt++) {
    if (attempt > 1) {
      // 应用起来了却没监听端口：多半是旧实例 socket 还没释放。杀掉这次拉起的，排空端口，再试一次。
      await stopApp(app, args.udds[app.key]);
      await waitPortFree(app.port, 8000);
    }
    const sp = spawnApp(app, exe);
    const ready = await waitReady(app, timeoutMs);
    last = { ready, sp, attempt };
    if (ready.ok) return last;
    if (!scanProcs(app).length) return last; // 进程没起来，重试也没用
  }
  return last;
}

async function waitReady(app, timeoutMs) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (await portOpen(app.port)) {
      const v = await devtoolsVersion(app.port);
      if (v && app.ua.test(v.ua)) return { ok: true, version: v, ms: Date.now() - t0 };
    }
    await sleep(400);
  }
  return { ok: false, ms: Date.now() - t0 };
}

async function waitTargets(port, timeoutMs) {
  const t0 = Date.now();
  let last = [];
  while (Date.now() - t0 < timeoutMs) {
    last = await devtoolsTargets(port);
    if (last.length) return last;
    await sleep(400);
  }
  return last;
}

function fmtTargets(targets) {
  if (!targets.length) return "(暂无 page target)";
  return targets.map((t) => t.title || t.url).map((s) => String(s).slice(0, 120)).join(" / ");
}

function writeState(results, selectedKeys) {
  try {
    let old = {};
    try { old = JSON.parse(fs.readFileSync(STATE_FILE, "utf8")); } catch {}
    const apps = { ...(old.apps || {}) };
    for (const r of results) {
      apps[r.key] = { label: r.label, port: r.port, pid: r.pid, exe: r.exe, ws: r.version ? r.version.ws : "",
        targets: r.targets.map((t) => ({ id: t.id, title: t.title || "", url: t.url || "", ws: t.webSocketDebuggerUrl || "" })) };
    }
    fs.mkdirSync(STATE_DIR, { recursive: true });
    const tmp = STATE_FILE + ".tmp-" + process.pid;
    fs.writeFileSync(tmp, JSON.stringify({ updatedAt: new Date().toISOString(), generator: "tools/launch-cdp.mjs", apps }, null, 2) + "\n", "utf8");
    fs.renameSync(tmp, STATE_FILE);
    return STATE_FILE;
  } catch (e) {
    console.error("[cdp] 写状态文件失败：" + e.message);
    return null;
  }
}

async function askYes(question) {
  const { createInterface } = await import("node:readline/promises");
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const a = (await rl.question(question)).trim().toLowerCase();
    return a === "y" || a === "yes";
  } catch { return false; } finally { rl.close(); }
}

// ---------------- 主流程 ----------------
const selected = args.only === "both" ? ["dsh", "trae"] : [args.only];
const results = [];
const failures = [];
const plan = [];

for (const key of selected) {
  const app = APPS[key];
  app.port = key === "dsh" ? args.dshPort : args.traePort;
  const found = discoverExe(app);
  const st = await inspect(app, args.udds[app.key] ? path.resolve(args.udds[app.key]) : null);
  plan.push({ app, found, st });
}

if (args.dry) {
  for (const { app, found, st } of plan) {
    console.log("[cdp] " + app.label + "：可执行文件 " + (found ? found.exe + "（" + found.from + "）" : "未找到"));
    console.log("[cdp] " + app.label + "：当前状态 " + st.state + (st.port ? "（端口 " + st.port + "）" : "") + (st.procs.length ? "，进程 " + st.procs.map((p) => p.ProcessId).join(",") : "，未运行"));
    if (found) {
      const argv = ["--remote-debugging-port=" + app.port, "--remote-allow-origins=*"];
      if (args.udds[app.key]) argv.push("--user-data-dir=" + path.resolve(args.udds[app.key]));
      console.log("[cdp] " + app.label + "：启动命令 " + "\"" + found.exe + "\" " + argv.join(" "));
    }
  }
  process.exit(0);
}

for (const { app, found, st } of plan) {
  const base = { key: app.key, label: app.label, port: app.port, procs: st.procs, exe: found ? found.exe : null };
  if (!found) {
    failures.push({ ...base, ok: false, code: 4, reason: "找不到可执行文件（用 --" + app.key + "-exe 或环境变量 " + app.env + " 指定）" });
    continue;
  }
  if (st.state === "ready") {
    const targets = await waitTargets(st.port, args.check ? 3000 : 8000);
    results.push({ ...base, ok: true, port: st.port, version: st.version, targets, action: "already", pid: st.procs[0] ? st.procs[0].ProcessId : null });
    continue;
  }
  if (st.state === "foreign") {
    failures.push({ ...base, ok: false, code: 7, reason: "端口 " + st.foreignPort + " 被其它程序占用" + (st.foreignUA ? "（" + st.foreignUA.slice(0, 80) + "）" : "") });
    continue;
  }
  if (st.state === "needs_restart") {
    let doRestart = args.restart;
    if (!doRestart && args.ask && !args.check) {
      doRestart = await askYes("[cdp] " + app.label + " 正在运行（pid " + st.procs.map((p) => p.ProcessId).join(",") + "）但没有 CDP。关闭并重开？" + (app.key === "dsh" ? "（会中断 DSH 当前会话，" : "（") + "y/N） ");
    }
    if (!doRestart) {
      failures.push({ ...base, ok: false, code: 3, reason: app.label + " 正在运行（pid " + st.procs.map((p) => p.ProcessId).join(",") + "）但没开 --remote-debugging-port；先完全退出它再跑本脚本，或加 --restart 让脚本关掉重开" + (app.key === "dsh" ? "（注意：会结束 DSH 里正在进行的会话）" : "") });
      continue;
    }
    const stop = await stopApp(app, args.udds[app.key]);
    // 旧实例退出后 socket 可能还占着端口；不等它释放就 spawn，Electron 会静默跳过 devtools 监听
    const freed = await waitPortFree(app.port, 8000);
    const { ready, sp, attempt } = await startAndWait(app, found.exe, args.timeout * 1000);
    if (!ready.ok) {
      const alive = scanProcs(app).length > 0;
      failures.push({ ...base, ok: false, code: 5, reason: "已关闭旧实例并重启（尝试 " + attempt + " 次），但 " + args.timeout + " 秒内端口 " + app.port + " 没就绪" + (stop.forced ? "（旧进程最后被强杀）" : "") + (!freed ? "；端口在 8 秒内一直没有释放" : "") + (alive ? "；应用已起来但没监听调试端口" : "；应用没起来") });
      continue;
    }
    const targets = await waitTargets(app.port, 25000);
    results.push({ ...base, ok: true, port: app.port, version: ready.version, targets, action: "restarted", pid: sp.pid, ms: ready.ms });
    continue;
  }
  if (args.check) {
    failures.push({ ...base, ok: false, code: 3, reason: app.label + " 未运行（--check 不启动）" });
    continue;
  }
  const { ready, sp, attempt } = await startAndWait(app, found.exe, args.timeout * 1000);
  if (!ready.ok) {
    const alive = scanProcs(app).length > 0;
    failures.push({ ...base, ok: false, code: 5, reason: "已启动（尝试 " + attempt + " 次），但 " + args.timeout + " 秒内端口 " + app.port + " 没就绪" + (alive ? "；应用已起来但没监听调试端口（单实例锁把参数吞了，或端口刚被旧实例占着）" : "；应用没起来") + "；稍后 --check 复查", pid: sp.pid });
    continue;
  }
  const targets = await waitTargets(app.port, 25000);
  results.push({ ...base, ok: true, port: app.port, version: ready.version, targets, action: "started", pid: sp.pid, ms: ready.ms });
}

// 没有任何就绪结果（全失败 / --check 时没在跑）就不落盘：不留下空 state.json 和 cdp/ 目录
const stateFile = results.length ? writeState(results, selected) : null;
const exitCode = failures.length ? failures[0].code : 0;

if (args.json) {
  console.log(JSON.stringify({ ok: exitCode === 0, exit: exitCode, apps: [...results, ...failures], stateFile }, null, 2));
} else {
  for (const r of results) {
    const act = r.action === "already" ? "已在跑" : r.action === "started" ? "已启动" : "已重启";
    console.log("[cdp] " + r.label.padEnd(4) + " 就绪  " + act + "  http://127.0.0.1:" + r.port + (r.pid ? "  pid " + r.pid : "") + "  targets " + r.targets.length + "  " + (r.ms ? "(" + Math.round(r.ms / 100) / 10 + " s)" : ""));
    console.log("[cdp]      ws " + (r.version ? r.version.ws : "-"));
    console.log("[cdp]      pages " + fmtTargets(r.targets));
  }
  for (const f of failures) console.error("[cdp] " + f.label.padEnd(4) + " 失败  " + f.reason);
  if (stateFile) console.log("[cdp] 状态文件：" + stateFile);
  if (!failures.length) console.log("[cdp] OK：" + results.map((r) => r.label).join(" + ") + " 的 CDP 可注入（wake-dsh / trae-inject / wake-trae 可直接用）");
  else if (failures.some((f) => f.code === 3)) console.log("[cdp] 提示：调试端口只能启动时给；退出对应应用后重跑，或加 --restart 由脚本关掉重开。");
}
process.exit(exitCode);
