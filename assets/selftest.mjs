#!/usr/bin/env node
/**
 * selftest.mjs — 一把梭自检：在临时 BUS_DIR 上验证整条协作链路，不碰真实任务板。
 *
 *   node tools/selftest.mjs          # 全绿 = 这台机器上三种接法都通
 *   node tools/selftest.mjs --keep   # 保留临时目录，便于看现场
 *
 * 覆盖：存储原子性 / CLI 全流程 / CAS 抢锁 / MCP stdio / MCP HTTP / MCP legacy SSE。
 * 退出码：0 全通过，1 有失败。
 */
import { spawn, execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(HERE, "bus-cli.mjs");
const MAIL = path.join(HERE, "mailbox.mjs");
const SERVER = path.join(HERE, "mcp-bus-server.mjs");
const BUS = fs.mkdtempSync(path.join(os.tmpdir(), "bus-selftest-"));
process.env.BUS_DIR = BUS;   // 父进程也指向临时目录，避免自检污染真实任务板
const env = { ...process.env, BUS_DIR: BUS };
const results = [];
const CASE_NAMES = []; // 用例名快照：断言总数守恒不代表用例没丢（TRAE 建议）
const ok = (name, detail = "") => { CASE_NAMES.push(name); results.push(true); console.log("PASS  " + name + (detail ? "  — " + detail : "")); };
const bad = (name, detail = "") => { CASE_NAMES.push(name); results.push(false); console.log("FAIL  " + name + (detail ? "  — " + detail : "")); };

function run(script, args, extraEnv = {}) {
  return new Promise((resolve) => {
    execFile(process.execPath, [script, ...args], { env: { ...env, ...extraEnv }, timeout: 20000 }, (e, stdout, stderr) => {
      resolve({ code: e ? (e.code ?? 1) : 0, out: String(stdout || ""), err: String(stderr || "") });
    });
  });
}
const freePort = () => new Promise((resolve) => {
  const s = net.createServer();
  s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => resolve(p)); });
});

// 1. 存储层（先 init：未初始化的板必须拒绝服务，不再静默建空板）
const init = await run(CLI, ["init"]);
init.code === 0 && fs.existsSync(path.join(BUS, "state.json"))
  ? ok("init 建板", init.out.trim())
  : bad("init 建板", init.err.trim() || "exit " + init.code);

// 1a2. note 缺 key：必须 exit 2，绝不能写出 undefined 这种幽灵条目（实测过）
const noteNoKey = await run(CLI, ["note", "write", "--text", "x"]);
const notesNow = await run(CLI, ["note", "read", "--key", "undefined", "--json"]);
noteNoKey.code === 2 && /--key/.test(noteNoKey.err) && !/"undefined"\s*:/.test(notesNow.out)
  ? ok("note 缺 key 守卫", "exit 2 且不产生 undefined 说明")
  : bad("note 缺 key 守卫", "code=" + noteNoKey.code + " err=" + noteNoKey.err.slice(0, 80));

// 1b. 参数守卫：--help 不能建任务、空标题必须 exit 2（这两个洞曾静默建出空任务）
const helpPost = await run(CLI, ["post", "--help"]);
const noTitle = await run(CLI, ["post", "--as", "tester"]);
const boardAfter = await run(CLI, ["list", "--json"]);
let cnt = -1;
try { cnt = JSON.parse(boardAfter.out).tasks.length; } catch {}
helpPost.code === 0 && /用法/.test(helpPost.out) && noTitle.code === 2 && cnt === 0
  ? ok("参数守卫", "--help exit 0 不建任务；空标题 exit 2")
  : bad("参数守卫", "help=" + helpPost.code + " noTitle=" + noTitle.code + " tasks=" + cnt);

// 2. CLI 全流程 + CAS
const post = await run(CLI, ["post", "--title", "selftest", "--as", "tester", "--json"]);
let id = null;
try { id = JSON.parse(post.out).id; } catch {}
id ? ok("CLI post", id) : bad("CLI post", post.err.trim());

const c1 = await run(CLI, ["claim", id, "--as", "a"], {});
const c2 = await run(CLI, ["claim", id, "--as", "b"], {});
c1.code === 0 && c2.code === 1 && /not claimable/.test(c2.err) ? ok("CAS 抢占", "第二个被拒") : bad("CAS 抢占", "codes " + c1.code + "/" + c2.code);

const done = await run(CLI, ["done", id, "--as", "a", "--result", "ok"]);
done.code === 0 ? ok("CLI done") : bad("CLI done", done.err.trim());

const board = await run(CLI, ["board"]);
/done/.test(board.out) ? ok("CLI board") : bad("CLI board", board.out.slice(0, 80));

// 2b. 严格状态：未初始化 / 0 字节 / 损坏
const envNoBus = { ...process.env };
delete envNoBus.BUS_DIR;   // 必须彻底没有 BUS_DIR，才是"空目录 + 无显式板"
const empty = fs.mkdtempSync(path.join(os.tmpdir(), "bus-empty-"));
const e2 = await new Promise((resolve) => execFile(process.execPath, [CLI, "post", "--title", "x"], { cwd: empty, env: envNoBus },
  (e, so, se) => resolve({ code: e ? e.code : 0, err: String(se) })));
e2.code === 5 && !fs.existsSync(path.join(empty, "bus")) ? ok("未初始化拒绝写入 exit 5", "不建目录") : bad("未初始化拒绝写入 exit 5", "code " + e2.code);
const zero = fs.mkdtempSync(path.join(os.tmpdir(), "bus-zero-"));
fs.writeFileSync(path.join(zero, "state.json"), "");
const z1 = await run(CLI, ["board"], { BUS_DIR: zero });
z1.code === 5 && fs.statSync(path.join(zero, "state.json")).size === 0 ? ok("0 字节按未初始化 exit 5", "不写入") : bad("0 字节 exit 5", "code " + z1.code);
const corrupt = fs.mkdtempSync(path.join(os.tmpdir(), "bus-corrupt-"));
fs.writeFileSync(path.join(corrupt, "state.json"), "{ broken,", "utf8");
const before = fs.readFileSync(path.join(corrupt, "state.json"));
const c1x = await run(CLI, ["post", "--title", "x"], { BUS_DIR: corrupt });
const c2x = await run(CLI, ["board"], { BUS_DIR: corrupt });
const sameBytes = fs.readFileSync(path.join(corrupt, "state.json")).equals(before);
const baks = fs.readdirSync(corrupt).filter((f) => f.startsWith("state.json.corrupt-"));
const roWording = /已拒绝操作（不做任何写入）/.test(c2x.err);
c1x.code === 6 && c2x.code === 6 && sameBytes && baks.length === 1 && !/0 tasks/.test(c2x.out) && roWording
  ? ok("损坏 exit 6 + 备份 + 不覆盖 + 文案不谎称写入", baks[0])
  : bad("损坏 exit 6", [c1x.code, c2x.code, sameBytes, baks.length, roWording].join("/"));

// 2b2. 数据优先：init 不带 --force 时绝不能把损坏的板清空（T-000008 验收差异 2/3）
const ci = await run(CLI, ["init"], { BUS_DIR: corrupt });
const sameBytes2 = fs.readFileSync(path.join(corrupt, "state.json")).equals(before);
ci.code === 6 && sameBytes2
  ? ok("损坏时 init 拒绝重建 exit 6", "原文件字节未变")
  : bad("损坏时 init 拒绝重建", "code " + ci.code + " same=" + sameBytes2);
const cf = await run(CLI, ["init", "--force"], { BUS_DIR: corrupt });
const rebuilt = fs.readFileSync(path.join(corrupt, "state.json"), "utf8");
const bakKeep = fs.readdirSync(corrupt).filter((f) => f.startsWith("state.json.corrupt-")).length >= 1;
cf.code === 0 && JSON.parse(rebuilt).tasks.length === 0 && bakKeep
  ? ok("init --force 才重建", "备份仍保留")
  : bad("init --force 重建", [cf.code, rebuilt.slice(0, 40), bakKeep].join("/"));

// 2b3. 命令行 --assignee：单独用生效，与 --to 冲突 exit 2
const aOnly = await run(CLI, ["post", "--title", "assignee-flag", "--as", "t", "--assignee", "b", "--json"]);
let aOk = false;
try { aOk = JSON.parse(aOnly.out).assignee === "b"; } catch {}
const aConflict = await run(CLI, ["post", "--title", "assignee-conflict", "--as", "t", "--to", "a", "--assignee", "b"]);
aOnly.code === 0 && aOk && aConflict.code === 2
  ? ok("--assignee 生效 / 冲突 exit 2", "a=" + aOnly.code + " conflict=" + aConflict.code)
  : bad("--assignee", "codes " + aOnly.code + "/" + aConflict.code + " assignee=" + aOk);

// 2f. D3 前置：缺验收标准只警告不阻断，点名缺哪一项
const noAccept = await run(CLI, ["post", "--title", "no-accept", "--as", "t"]);
const withAccept = await run(CLI, ["post", "--title", "with-accept", "--as", "t", "--accept", "npm test 全绿，产出 src/a.ts"]);
const warnMissingAccept = /缺少「验收标准」/.test(noAccept.err) && noAccept.code === 0;
const noWarnWithAccept = !/缺少「验收标准」/.test(withAccept.err) && withAccept.code === 0;
warnMissingAccept && noWarnWithAccept
  ? ok("缺验收标准只警告 exit 0", "点名「验收标准」/「产出路径」")
  : bad("缺验收标准警告", "codes " + noAccept.code + "/" + withAccept.code + " warns " + warnMissingAccept + "/" + noWarnWithAccept);

// 2c. to / assignee 冲突与兼容
const cliStdin = (json, envx) => new Promise((resolve) => {
  const ch = execFile(process.execPath, [CLI, "post", "--stdin", "--as", "t", "--json"], { env: { ...env, ...envx } }, (e, so, se) => resolve({ code: e ? e.code : 0, out: String(so), err: String(se) }));
  ch.stdin.write(json); ch.stdin.end();
});
const p1 = await cliStdin(JSON.stringify({ title: "assignee", assignee: "trae-ide" }));
const p2 = await cliStdin(JSON.stringify({ title: "conflict", to: "a", assignee: "b" }));
const p3 = await cliStdin(JSON.stringify({ title: "unknown", supervisor: "x" }));
const p1ok = JSON.parse(p1.out).assignee === "trae-ide";
p1ok && p2.code === 2 && /to/.test(p2.err) && /assignee/.test(p2.err) && p3.code === 0 && /警告/.test(p3.err)
  ? ok("assignee/to 兼容与冲突 exit 2", "未知键只警告")
  : bad("assignee/to 兼容", [p1ok, p2.code, p3.code].join("/"));

// 2d. 只读命令永不落盘（显式 BUS_DIR 指到不存在的目录）
const roRoot = fs.mkdtempSync(path.join(os.tmpdir(), "bus-ro-"));
const ghost = path.join(roRoot, "ghost");
const roBoard = await run(CLI, ["board"], { BUS_DIR: ghost });
const roList = await run(CLI, ["list"], { BUS_DIR: ghost });
const roPoll = await run(CLI, ["poll", "--as", "x"], { BUS_DIR: ghost });
const roStats = await run(CLI, ["stats"], { BUS_DIR: ghost });
const ghostTouched = fs.existsSync(ghost);
const allReadOnly5 = [roBoard, roList, roPoll, roStats].every((r) => r.code === 5);
allReadOnly5 && !ghostTouched
  ? ok("只读命令不建板 exit 5", "board/list/poll/stats 均未落盘")
  : bad("只读命令不建板", "codes " + [roBoard, roList, roPoll, roStats].map((r) => r.code).join("/") + " created=" + ghostTouched);

// 2e. 同一个目录，写命令才按显式 BUS_DIR 建板
const rwPost = await run(CLI, ["post", "--title", "explicit-dir", "--as", "t"], { BUS_DIR: ghost });
rwPost.code === 0 && fs.existsSync(path.join(ghost, "state.json"))
  ? ok("写命令按显式 BUS_DIR 建板", "stderr 有提示")
  : bad("写命令按显式 BUS_DIR 建板", "code " + rwPost.code);

// 3. MCP stdio
const stdioOk = await new Promise((resolve) => {
  const ch = spawn(process.execPath, [SERVER], { env });
  let buf = "", err = "";
  ch.stdout.on("data", (d) => (buf += d));
  ch.stderr.on("data", (d) => (err += d));
  const send = (o) => ch.stdin.write(JSON.stringify(o) + "\n");
  send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "selftest", version: "1" } } });
  send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
  setTimeout(() => {
    ch.kill();
    const rs = buf.trim().split("\n").map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
    const init = rs.find((r) => r.id === 1), tl = rs.find((r) => r.id === 2);
    resolve(init?.result?.serverInfo && tl?.result?.tools?.length === 8 ? { ok: true, n: tl.result.tools.length } : { ok: false, err: err.trim() || "no reply" });
  }, 1500);
});
stdioOk.ok ? ok("MCP stdio", "8 tools") : bad("MCP stdio", stdioOk.err);

// 4. MCP HTTP + legacy SSE
const port = await freePort();
const srv = spawn(process.execPath, [SERVER, "--http", String(port)], { env });
let srvErr = "";
srv.stderr.on("data", (d) => (srvErr += d));
await new Promise((r) => setTimeout(r, 900));
const base = "http://127.0.0.1:" + port;

try {
  const r = await fetch(base + "/", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "bus_stats", arguments: {} } }) });
  const j = await r.json();
  j.result?.content?.[0]?.text ? ok("MCP HTTP 单发", r.status + " in " + base) : bad("MCP HTTP 单发", JSON.stringify(j).slice(0, 120));
} catch (e) { bad("MCP HTTP 单发", e.message); }

try {
  const res = await fetch(base + "/sse", { headers: { accept: "text/event-stream" } });
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "", endpoint = null, gotInit = false;
  const t0 = Date.now();
  while (Date.now() - t0 < 5000 && !gotInit) {
    const { value } = await reader.read();
    if (!value) continue;
    buf += dec.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf("\n\n")) >= 0) {
      const ev = buf.slice(0, i); buf = buf.slice(i + 2);
      const ep = ev.match(/data: (\S+)/);
      if (!endpoint && ep) endpoint = ep[1];
      if (ev.startsWith("event: message") && ev.includes('"id":1')) gotInit = true;
    }
    if (endpoint && !gotInit) {
      await fetch(base + endpoint, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "selftest", version: "1" } } }) });
    }
  }
  gotInit && endpoint ? ok("MCP legacy SSE", endpoint) : bad("MCP legacy SSE", "endpoint=" + endpoint + " reply=" + gotInit);
  try { reader.cancel(); } catch {}
} catch (e) { bad("MCP legacy SSE", e.message); }

// 5. selfwake 熔断：默认 OFF、连 5 次失败自动关闭、第 5 次 exit 7
const SW = path.join(HERE, "selfwake.mjs");
const WDT = path.join(HERE, "watchdog.mjs");
const INJ = path.join(HERE, "trae-inject.mjs");
const WDSH = path.join(HERE, "wake-dsh.mjs");
const WAKE = path.join(HERE, "wake-trae.mjs");
const swRoot = fs.mkdtempSync(path.join(os.tmpdir(), "selfwake-selftest-"));
fs.mkdirSync(path.join(swRoot, "tools"), { recursive: true });
fs.copyFileSync(WDT, path.join(swRoot, "tools", "watchdog.mjs"));
for (const d of ["bus", "mailbox"]) fs.mkdirSync(path.join(swRoot, d), { recursive: true });
fs.writeFileSync(path.join(swRoot, "bus", "state.json"), JSON.stringify({ tasks: [{ id: "T-1", title: "t", status: "pending" }] }));
const sw = (args) => new Promise((res) => execFile(process.execPath, [SW, "--root", swRoot, ...args], { env }, (e, so, se) => res({ code: e ? (typeof e.code === "number" ? e.code : 1) : 0, out: String(so) + String(se) })));
const swOff = await sw(["tick"]);
const swEn = await sw(["enable", "--every", "15"]);
fs.writeFileSync(path.join(swRoot, "bus", "state.json"), '{"tasks":[');
let swLast = null, swFired = 0;
for (let i = 0; i < 5; i++) { swLast = await sw(["tick"]); if (/SELFWAKE_DISABLED/.test(swLast.out)) swFired = i + 1; }
const swState = JSON.parse(fs.readFileSync(path.join(swRoot, "watch", "selfwake.json"), "utf8"));
swOff.code === 0 && /OFF/.test(swOff.out) && swEn.code === 0 && swFired === 5 && swLast.code === 7 && swState.enabled === false && swState.failStreak === 5
  ? ok("selfwake 熔断", "默认 OFF、第 5 次 exit 7、自动关闭")
  : bad("selfwake 熔断", `off=${swOff.code} en=${swEn.code} fired=${swFired} last=${swLast.code} enabled=${swState.enabled} streak=${swState.failStreak}`);
// drill 隔离：OFF 下也能演练，但不能碰真实状态；--real 在 OFF 时拒绝
const sw2Root = fs.mkdtempSync(path.join(os.tmpdir(), "selfwake-drill-selftest-"));
for (const d of ["tools", "mailbox", "bus"]) fs.mkdirSync(path.join(sw2Root, d), { recursive: true });
fs.copyFileSync(WDT, path.join(sw2Root, "tools", "watchdog.mjs"));
fs.copyFileSync(SW, path.join(sw2Root, "tools", "selfwake.mjs"));
fs.writeFileSync(path.join(sw2Root, "bus", "state.json"), JSON.stringify({ tasks: [] }));
const sw2 = (args) => new Promise((res) => execFile(process.execPath, [SW, "--root", sw2Root, ...args], { env }, (e, so, se) => res({ code: e ? (typeof e.code === "number" ? e.code : 1) : 0, out: String(so) + String(se) })));
const swDrill = await sw2(["drill", "--n", "5"]);
const swDrill3 = await sw2(["drill", "--n", "3"]);
const swReal = await sw2(["drill", "--real", "--n", "5"]);
const swLeak = fs.existsSync(path.join(sw2Root, "watch", "selfwake.json"));
const swDrill3Ok = swDrill3.code === 0 && /failStreak=3\/3/.test(swDrill3.out) && /drill 3\/3\] exit=7/.test(swDrill3.out);
swDrill.code === 0 && /已熔断/.test(swDrill.out) && swDrill3Ok && !swLeak && swReal.code === 2
  ? ok("drill 隔离与 --real 守卫", "OFF 下 --n 5 与 --n 3 都按阈值熔断（3/3 即 exit 7），不碰真实状态；--real 在 OFF 时 exit 2")
  : bad("drill 隔离与 --real 守卫", "drill=" + swDrill.code + " drill3=" + swDrill3.code + "/" + swDrill3Ok + " leak=" + swLeak + " real=" + swReal.code);
try { fs.rmSync(sw2Root, { recursive: true, force: true }); } catch {}


// 20b. 出站叫醒统一走 wake-trae：看门狗不再收 --notify-trae；notify on 时 tick 会调 wake-trae，off 时不调
const fakeWd = path.join(sw2Root, "tools", "fake-wd.mjs");
const argvFile = path.join(sw2Root, "fake-argv.txt");
const fakeWt = path.join(sw2Root, "tools", "fake-wt.mjs");
const wtFile = path.join(sw2Root, "fake-wt-argv.txt");
fs.mkdirSync(path.dirname(fakeWd), { recursive: true });
fs.writeFileSync(fakeWd, "import f from \"node:fs\"; f.writeFileSync(process.env.FAKE_ARGV, JSON.stringify(process.argv.slice(2)));\n", "utf8");
fs.writeFileSync(fakeWt, "import f from \"node:fs\"; f.writeFileSync(process.env.FAKE_WT, JSON.stringify(process.argv.slice(2)));\n", "utf8");
const sw2n = (args) => new Promise((res) => execFile(process.execPath, [SW, "--root", sw2Root, "--watchdog", fakeWd, "--wake-trae", fakeWt, ...args], { env: { ...env, FAKE_ARGV: argvFile, FAKE_WT: wtFile } }, (e, so, se) => res({ code: e ? (typeof e.code === "number" ? e.code : 1) : 0, out: String(so) + String(se) })));
const readIf = (p) => { try { return fs.readFileSync(p, "utf8"); } catch { return ""; } };
const del = (p) => { try { fs.rmSync(p, { force: true }); } catch {} };
await sw2n(["enable", "--every", "30"]);
del(wtFile);
const onRun = await sw2n(["tick"]);
const onArgvText = readIf(argvFile), onWtText = readIf(wtFile);
await sw2n(["notify", "off"]);
del(wtFile);
const offRun = await sw2n(["tick"]);
const offArgvText = readIf(argvFile), offWtText = readIf(wtFile);
const onOk = onRun.code === 0 && !/--notify-trae/.test(onArgvText) && /--port/.test(onWtText) && /auto/.test(onWtText);
const offOk = offRun.code === 0 && !/--notify-trae/.test(offArgvText) && offWtText === "";
onOk && offOk
  ? ok("出站叫醒只走 wake-trae", "watchdog 无 --notify-trae；notify on 时调 wake-trae(--port auto)，off 时不调")
  : bad("出站叫醒只走 wake-trae", "onWt=" + onWtText.trim() + " offWt=" + offWtText.trim() + " onArgv=" + onArgvText.trim());

// 20b2. watchdog 已移除 --notify-trae：必须 exit 2 且指向 wake-trae（不能静默忽略）
const wdNotify = await run(WDT, ["--notify-trae"]);
wdNotify.code === 2 && /wake-trae/.test(wdNotify.err)
  ? ok("watchdog 移除 --notify-trae", "exit 2 并提示改用 wake-trae")
  : bad("watchdog 移除 --notify-trae", "code=" + wdNotify.code + " err=" + wdNotify.err.trim().slice(0, 120));

// 20c. trae-inject 端口自动发现：DevToolsActivePort 写 1 → 必须去连 127.0.0.1:1 并 exit 3
const fakeApp = fs.mkdtempSync(path.join(os.tmpdir(), "trae-appdata-"));
fs.mkdirSync(path.join(fakeApp, "Trae CN"), { recursive: true });
fs.writeFileSync(path.join(fakeApp, "Trae CN", "DevToolsActivePort"), "1\n/devtools/browser/x\n");
const autoPortRun = await run(INJ, ["status", "--port", "auto"], { APPDATA: fakeApp, USERPROFILE: fakeApp });
autoPortRun.code === 3 && /127\.0\.0\.1:1\b/.test(autoPortRun.err)
  ? ok("trae-inject 端口自动发现", "DevToolsActivePort=1 → 连 127.0.0.1:1，exit 3")
  : bad("trae-inject 端口自动发现", "code=" + autoPortRun.code + " err=" + autoPortRun.err.slice(0, 120));
try { fs.rmSync(fakeApp, { recursive: true, force: true }); } catch {}

// 20d. wake-trae 出站叫醒：--dry 拼出待办、--init 建基线后不再叫旧信、无端口只影响发送
const TMPROOT = fs.mkdtempSync(path.join(os.tmpdir(), "wake-parent-"));
const wkRoot = path.join(TMPROOT, "wake-selftest");
fs.rmSync(wkRoot, { recursive: true, force: true });
fs.mkdirSync(path.join(wkRoot, "mailbox"), { recursive: true });
fs.mkdirSync(path.join(wkRoot, "bus"), { recursive: true });
fs.writeFileSync(path.join(wkRoot, "bus", "state.json"), JSON.stringify({ tasks: [{ id: "T-1", title: "待办任务", status: "pending", assignee: "trae-ide" }] }), "utf8");
fs.writeFileSync(path.join(wkRoot, "mailbox", "20260101-0000-001.md"), "---\nid: 20260101-0000-001\nfrom: dsh-lead\nto: trae-ide\nsubject: 测试信\n---\n正文\n", "utf8");
const wk = (args) => new Promise((res) => execFile(process.execPath, [WAKE, "--root", wkRoot, ...args], { env }, (e, so, se) => res({ code: e ? (typeof e.code === "number" ? e.code : 1) : 0, out: String(so) + String(se) })));
const d1 = await wk(["--dry"]);
const d2 = await wk(["--dry", "--port", "1"]);
const wkInit = await wk(["--init"]);
const d3 = await wk(["--dry"]);
fs.mkdirSync(path.join(wkRoot, "watch"), { recursive: true });
fs.writeFileSync(path.join(wkRoot, "watch", "knock-notified.json"), JSON.stringify({ ids: ["T-1"], at: {} }));
const d4 = await wk(["--dry"]);
d1.code === 0 && /【DSH 叫醒】/.test(d1.out) && /T-1/.test(d1.out) && /20260101-0000-001/.test(d1.out) && d2.code === 0 && wkInit.code === 0 && /T-1/.test(d3.out) && !/20260101-0000-001/.test(d3.out) && d4.code === 0 && /无欠件/.test(d4.out)
  ? ok("wake-trae 出站叫醒", "--dry 列出任务+信件；--init 只压旧信、待办任务仍叫；账本里已叫过的不再叫")
  : bad("wake-trae 出站叫醒", "d1=" + d1.code + " d3=" + d3.out.slice(0, 80));
try { fs.rmSync(wkRoot, { recursive: true, force: true }); } catch {}
try { fs.rmSync(TMPROOT, { recursive: true, force: true }); } catch {}

// 20e. 安装器产出可运行：全新 root 装一遍 → 每个 tools/*.mjs 语法过关 → wake-trae 必须在
const insRoot = path.join(TMPROOT, "install-selftest");
fs.mkdirSync(insRoot, { recursive: true });
const insRun = await new Promise((res) => execFile(process.execPath, [path.join(HERE, "init-workspace.mjs"), "--root", insRoot], { env }, (e, so, se) => res({ code: e ? (typeof e.code === "number" ? e.code : 1) : 0, out: String(so) + String(se) })));
let badSyntax = [];
let toolNames = [];
try { toolNames = fs.readdirSync(path.join(insRoot, "tools")).filter((n) => n.endsWith(".mjs")); } catch {}
for (const n of toolNames) {
  const c = await new Promise((res) => execFile(process.execPath, ["--check", path.join(insRoot, "tools", n)], { env }, (e) => res(e ? 1 : 0)));
  if (c !== 0) badSyntax.push(n);
}
const hasWake = toolNames.includes("wake-trae.mjs");
insRun.code === 0 && badSyntax.length === 0 && hasWake
  ? ok("安装器产出可运行", toolNames.length + " 个工具语法全过，含 wake-trae")
  : bad("安装器产出可运行", "install=" + insRun.code + " syntax=" + badSyntax.join(",") + " wake=" + hasWake);

// 20e2. 已装布局再装一次：<ws>/tools/init-workspace.mjs 必须能装第二个 root，且带 2 份参考文档
// （TRAE 在 a8f2a83 上踩到：旧版写死 ../references，从已装工作区再装直接 ENOENT 半成品）
const ins2 = path.join(TMPROOT, "install-selftest-2");
const ins2Run = await new Promise((res) => execFile(process.execPath, [path.join(insRoot, "tools", "init-workspace.mjs"), "--root", ins2], { env }, (e, so, se) => res({ code: e ? (typeof e.code === "number" ? e.code : 1) : 0, out: String(so) + String(se) })));
const docs2 = fs.existsSync(path.join(ins2, "docs")) ? fs.readdirSync(path.join(ins2, "docs")).filter((n) => n.endsWith(".md")).length : 0;
const board2 = fs.existsSync(path.join(ins2, "bus", "state.json"));
const gi2 = fs.existsSync(path.join(ins2, ".gitignore")) ? fs.readFileSync(path.join(ins2, ".gitignore"), "utf8") : "";
const giTpl = [path.join(HERE, "..", ".gitignore"), path.join(HERE, ".gitignore")].find((x) => fs.existsSync(x));
const giOk = [".tmp/", "node_modules/", "*.corrupt-*"].every((k) => gi2.includes(k)) && (!giTpl || fs.readFileSync(giTpl, "utf8") === gi2);
const refDir = [path.join(HERE, "references"), path.join(HERE, "..", "references")].find((d) => fs.existsSync(d));
const docsExpect = refDir ? fs.readdirSync(refDir).filter((n) => n.endsWith(".md")).length : docs2;
ins2Run.code === 0 && docs2 === docsExpect && board2 && giOk
  ? ok("已装布局二次安装", "tools/init-workspace.mjs → 第二个 root：exit 0、docs=" + docsExpect + "（与 references 一致）、板已 init、.gitignore 与包内模板逐字节相同")
  : bad("已装布局二次安装", "exit=" + ins2Run.code + " docs=" + docs2 + "/" + docsExpect + " board=" + board2 + " gi=" + giOk + " tpl=" + (giTpl || "none") + " out=" + ins2Run.out.slice(-160));

// 20f. wake-trae 不自叫：from=self 的 to: all 广播不得被自己叫醒
const echoRoot = path.join(TMPROOT, "echo-selftest");
fs.mkdirSync(path.join(echoRoot, "mailbox"), { recursive: true });
fs.mkdirSync(path.join(echoRoot, "bus"), { recursive: true });
fs.writeFileSync(path.join(echoRoot, "bus", "state.json"), JSON.stringify({ tasks: [] }), "utf8");
fs.writeFileSync(path.join(echoRoot, "mailbox", "20260102-0000-001.md"), "---\nid: 20260102-0000-001\nfrom: trae-ide\nto: all\nsubject: 自发广播\n---\n正文\n", "utf8");
const echoDry = await new Promise((res) => execFile(process.execPath, [WAKE, "--root", echoRoot, "--dry"], { env }, (e, so, se) => res({ code: e ? (typeof e.code === "number" ? e.code : 1) : 0, out: String(so) + String(se) })));
echoDry.code === 0 && /无欠件/.test(echoDry.out)
  ? ok("wake-trae 不自叫", "from=trae-ide 的 to: all 广播被过滤")
  : bad("wake-trae 不自叫", "out=" + echoDry.out.slice(0, 100));

// 21) trae-inject：没有 CDP 时必须是干净的 exit 3（不是崩溃、不是静默成功）
const injHelp = await run(INJ, ["--help"]);
const injDead = await run(INJ, ["status", "--port", "1"]);
injHelp.code === 0 && /probe/.test(injHelp.out) && injDead.code === 3 && /remote-debugging-port/.test(injDead.err)
  ? ok("trae-inject 守卫", "help exit 0；端口不通 exit 3 且提示重启命令")
  : bad("trae-inject 守卫", `help=${injHelp.code} dead=${injDead.code}`);

// 21b) wake-dsh：反向叫醒同样必须是干净的 exit 3，并提示带调试端口启动
const wdshHelp = await run(WDSH, ["--help"]);
const wdshDead = await run(WDSH, ["status", "--port", "1"]);
wdshHelp.code === 0 && /probe/.test(wdshHelp.out) && wdshDead.code === 3 && /remote-debugging-port/.test(wdshDead.err)
  ? ok("wake-dsh 守卫", "help exit 0；端口不通 exit 3 且提示重启命令")
  : bad("wake-dsh 守卫", `help=${wdshHelp.code} dead=${wdshDead.code}`);

// 21c) bus-cli post --wake 干跑必须引用真实任务号（callTool 返回 MCP 形状，容易取成 undefined）
const wakeBusDir = fs.mkdtempSync(path.join(os.tmpdir(), "bus-wake-"));
const wakePost = await new Promise((res) => execFile(process.execPath, [CLI, "post", "--title", "id 引用测试", "--accept", "产出 docs/a.md", "--to", "trae-ide", "--wake", "--wake-force"],
  { env: { ...env, BUS_DIR: wakeBusDir, BUS_WAKE_DRY: "1" }, timeout: 20000 }, (e, so, se) => res({ code: e ? (e.code ?? 1) : 0, out: String(so || "") + String(se || "") })));
const wakeIdOk = wakePost.code === 0 && /T-000001/.test(wakePost.out) && !/见板/.test(wakePost.out) && /would knock/.test(wakePost.out);
wakeIdOk
  ? ok("bus post --wake 引用任务 id", "干跑文案含 T-000001，未退化为占位")
  : bad("bus post --wake 引用任务 id", "code=" + wakePost.code + " out=" + wakePost.out.trim().slice(0, 160));
try { fs.rmSync(wakeBusDir, { recursive: true, force: true }); } catch {}

// 21d) bus-cli post --wake 派给自己的任务不敲门（TRAE 抓到的自叫醒）
const selfBusDir = fs.mkdtempSync(path.join(os.tmpdir(), "bus-selfwake-"));
const selfPost = await new Promise((res) => execFile(process.execPath, [CLI, "post", "--title", "自派", "--accept", "产出 docs/a.md", "--as", "trae-ide", "--to", "trae-ide", "--wake"],
  { env: { ...env, BUS_DIR: selfBusDir, BUS_WAKE_DRY: "1" }, timeout: 20000 }, (e, so, se) => res({ code: e ? (e.code ?? 1) : 0, out: String(so || ""), err: String(se || "") })));
selfPost.code === 0 && !/would knock/.test(selfPost.out) && /跳过敲门/.test(selfPost.err)
  ? ok("bus 自派任务不敲门", "trae-ide → trae-ide 跳过，任务仍落盘")
  : bad("bus 自派任务不敲门", "code=" + selfPost.code + " out=" + selfPost.out.trim().slice(0, 100) + " err=" + selfPost.err.trim().slice(0, 100));
try { fs.rmSync(selfBusDir, { recursive: true, force: true }); } catch {}

// 21e) 幽灵 id 守卫 + 已通知去重：隔离板默认不敲门；ledger 有记录就跳过（TRAE T-000022 挂账两项）
const knockBusDir = fs.mkdtempSync(path.join(os.tmpdir(), "bus-knock-"));
const runKnock = (args) => new Promise((res) => execFile(process.execPath, [CLI, ...args],
  { env: { ...env, BUS_DIR: knockBusDir, BUS_WAKE_DRY: "1" }, timeout: 20000 }, (e, so, se) => res({ code: e ? (e.code ?? 1) : 0, out: String(so || ""), err: String(se || "") })));
const kPost = await runKnock(["post", "--title", "敲门守卫", "--accept", "产出 docs/a.md", "--to", "trae-ide"]);
const kIso = await runKnock(["knock", "T-000001"]);
const kForce = await runKnock(["knock", "T-000001", "--wake-force"]);
const kN = path.join(knockBusDir, "watch", "knock-notified.json"); // 自定义目录不是 .../bus 时，它自己就是工作区根
fs.mkdirSync(path.dirname(kN), { recursive: true });
fs.writeFileSync(kN, JSON.stringify({ ids: ["T-000001"] }));
const kDup = await runKnock(["knock", "T-000001", "--wake-force"]);
kPost.code === 0 && /隔离任务板/.test(kIso.err) && !/would knock/.test(kIso.out) && /would knock/.test(kForce.out) && /已通知过/.test(kDup.err) && !/would knock/.test(kDup.out)
  ? ok("bus knock 隔离与去重", "隔离板默认不敲 / --wake-force 可干跑 / ledger 命中跳过")
  : bad("bus knock 隔离与去重", JSON.stringify({ iso: kIso.err.trim().slice(0, 60), force: /would knock/.test(kForce.out), dup: kDup.err.trim().slice(0, 60) }));
try { fs.rmSync(knockBusDir, { recursive: true, force: true }); } catch {}

// 21f) nudge：停滞任务才催，催满 max 次转为「需人工介入」；只读、dry 不记账
const nudgeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "nudge-root-"));
const nudgeBus = path.join(nudgeRoot, "bus");
fs.mkdirSync(nudgeBus, { recursive: true });
const oldTs = new Date(Date.now() - 30 * 60000).toISOString();
fs.writeFileSync(path.join(nudgeBus, "state.json"), JSON.stringify({
  next_id: 4,
  tasks: [
    { id: "T-000001", title: "停在 claimed", status: "claimed", assignee: "trae-ide", created_at: oldTs, updated_at: oldTs },
    { id: "T-000002", title: "待领超时", status: "pending", assignee: "trae-ide", created_at: oldTs, updated_at: oldTs },
    { id: "T-000003", title: "已完成", status: "done", assignee: "trae-ide", created_at: oldTs, updated_at: oldTs }
  ],
  notes: {}
}, null, 2));
const NUDGE = path.join(HERE, "nudge.mjs");
const runNudge = (args) => new Promise((res) => execFile(process.execPath, [NUDGE, "--root", nudgeRoot, "--bus", nudgeBus, ...args],
  { env, timeout: 20000 }, (e, so, se) => res({ code: e ? (e.code ?? 1) : 0, out: String(so || ""), err: String(se || "") })));
const nd1 = await runNudge(["--dry"]);
const ndLedger = path.join(nudgeRoot, "watch", "nudge.json");
const ndDryNoWrite = !fs.existsSync(ndLedger);
fs.mkdirSync(path.dirname(ndLedger), { recursive: true });
fs.writeFileSync(ndLedger, JSON.stringify({ items: { "T-000001": { count: 3, lastAt: 0 }, "T-000002": { count: 3, lastAt: 0 } } }));
const nd2 = await runNudge(["--dry"]);
fs.writeFileSync(ndLedger, JSON.stringify({ items: {} }));
const knockLg = path.join(nudgeRoot, "watch", "knock-notified.json");
fs.mkdirSync(path.dirname(knockLg), { recursive: true });
fs.writeFileSync(knockLg, JSON.stringify({ ids: ["T-000001"], at: { "T-000001": Date.now() } }));
const nd3 = await runNudge(["--dry"]);
nd1.code === 0 && nd1.out.includes("T-000001(claimed 30min)") && nd1.out.includes("T-000002(pending 30min)") && !/T-000003/.test(nd1.out) && ndDryNoWrite
  && nd2.code === 0 && !/would knock/.test(nd2.out) && /已催满 2 项/.test(nd2.out)
  && nd3.code === 0 && nd3.out.includes("T-000002") && !nd3.out.includes("T-000001")
  ? ok("nudge 停滞催办", "只催停滞项 / dry 不记账 / 催满转人工")
  : bad("nudge 停滞催办", JSON.stringify({ c1: nd1.code, o1: nd1.out.slice(0, 120), write: !ndDryNoWrite, o2: nd2.out.slice(0, 100) }));
try { fs.rmSync(nudgeRoot, { recursive: true, force: true }); } catch {}

try { fs.rmSync(swRoot, { recursive: true, force: true }); } catch {}


// 21g) 门铃账本损坏：备份 + 大声警告 + 本次不敲（TRAE 0155 复核抓的「损坏退化为空集合」）
const cRoot = fs.mkdtempSync(path.join(os.tmpdir(), "knock-corrupt-"));
const cBus = path.join(cRoot, "bus");
fs.mkdirSync(cBus, { recursive: true });
fs.writeFileSync(path.join(cBus, "state.json"), JSON.stringify({ tasks: [{ id: "T-000001", title: "损坏账本", status: "pending", assignee: "trae-ide", created_at: oldTs, updated_at: oldTs }], notes: {} }));
const cLg = path.join(cRoot, "watch", "knock-notified.json");
fs.mkdirSync(path.dirname(cLg), { recursive: true });
fs.writeFileSync(cLg, '{"ids":[oops');
const cRun = await new Promise((res) => execFile(process.execPath, [CLI, "knock", "T-000001", "--wake-force"], { env: { ...env, BUS_DIR: cBus, BUS_WAKE_DRY: "1" }, timeout: 20000 }, (e, so, se) => res({ code: e ? (e.code ?? 1) : 0, out: String(so || ""), err: String(se || "") })));
const cBak = fs.readdirSync(path.join(cRoot, "watch")).some((f) => /knock-notified\.json\.corrupt-/.test(f));
const cRoot2 = fs.mkdtempSync(path.join(os.tmpdir(), "knock-corrupt-m-"));
const cMail = path.join(cRoot2, "mailbox");
fs.mkdirSync(cMail, { recursive: true });
fs.writeFileSync(path.join(cMail, "20260101-0000-001.md"), "---\nid: 20260101-0000-001\nfrom: dsh-lead\nto: trae-ide\nsubject: 损坏账本\n---\n正文\n");
const mRun = await new Promise((res) => execFile(process.execPath, [MAIL, "knock", "20260101-0000-001", "--wake-force"], { env: { ...env, MAILBOX_DIR: cMail, MAILBOX_WAKE_DRY: "1" }, timeout: 20000 }, (e, so, se) => res({ code: e ? (e.code ?? 1) : 0, out: String(so || ""), err: String(se || "") })));
const cLg2 = path.join(cRoot2, "watch", "knock-notified.json");
fs.mkdirSync(path.dirname(cLg2), { recursive: true });
fs.writeFileSync(cLg2, '{"ids":[oops');
const mRun2 = await new Promise((res) => execFile(process.execPath, [MAIL, "knock", "20260101-0000-001", "--wake-force"], { env: { ...env, MAILBOX_DIR: cMail, MAILBOX_WAKE_DRY: "1" }, timeout: 20000 }, (e, so, se) => res({ code: e ? (e.code ?? 1) : 0, out: String(so || ""), err: String(se || "") })));
cRun.code === 6 && /门铃账本损坏/.test(cRun.err) && !/would knock/.test(cRun.out) && cBak && fs.readFileSync(cLg, "utf8") === '{"ids":[oops'
  && mRun2.code === 6 && /门铃账本损坏/.test(mRun2.err) && !/would knock/.test(mRun2.out) && fs.readFileSync(cLg2, "utf8") === '{"ids":[oops'
  ? ok("ledger 损坏两条路径 exit 6", "bus/mailbox 均 exit 6、备份存在、原文件未改、无注入")
  : bad("ledger 损坏两条路径 exit 6", JSON.stringify({ bus: cRun.code, mail: mRun2.code, err: mRun2.err.slice(0, 80) }));
try { fs.rmSync(cRoot, { recursive: true, force: true }); } catch {}


// 21h) 账本隔离：同父目录两个工作区互不可见；父目录坏账本不拖累（TRAE 03403 第 3 条）
const pRoot = fs.mkdtempSync(path.join(os.tmpdir(), "knock-iso-"));
const mkWs = (n) => { const w = path.join(pRoot, n); fs.mkdirSync(path.join(w, "mailbox"), { recursive: true }); fs.mkdirSync(path.join(w, "bus"), { recursive: true }); fs.writeFileSync(path.join(w, "mailbox", "20260101-0000-001.md"), "---\nid: 20260101-0000-001\nfrom: dsh-lead\nto: trae-ide\nsubject: 隔离\n---\n正文\n"); fs.writeFileSync(path.join(w, "bus", "state.json"), JSON.stringify({ tasks: [{ id: "T-000001", title: "隔离", status: "pending", assignee: "trae-ide", created_at: oldTs, updated_at: oldTs }], notes: {} })); return w; };
const wsA = mkWs("ws-a"), wsB = mkWs("ws-b");
const pLg = path.join(pRoot, "watch", "knock-notified.json");
fs.mkdirSync(path.dirname(pLg), { recursive: true });
fs.writeFileSync(pLg, '{"ids":[oops');
const iso = (file, args, extraEnv) => new Promise((res) => execFile(process.execPath, [file, ...args], { env: { ...env, ...extraEnv }, timeout: 20000 }, (e, so, se) => res({ code: e ? (e.code ?? 1) : 0, out: String(so || ""), err: String(se || "") })));
const isoA = await iso(MAIL, ["knock", "20260101-0000-001", "--wake-force"], { MAILBOX_DIR: path.join(wsA, "mailbox"), MAILBOX_WAKE_DRY: "1" });
const isoB = await iso(CLI, ["knock", "T-000001", "--wake-force"], { BUS_DIR: path.join(wsB, "bus"), BUS_WAKE_DRY: "1" });
const aLg = path.join(wsA, "watch", "knock-notified.json");
fs.mkdirSync(path.dirname(aLg), { recursive: true });
fs.writeFileSync(aLg, '{"ids":[oops');
const isoA2 = await iso(MAIL, ["knock", "20260101-0000-001", "--wake-force"], { MAILBOX_DIR: path.join(wsA, "mailbox"), MAILBOX_WAKE_DRY: "1" });
const isoB2 = await iso(CLI, ["knock", "T-000001", "--wake-force"], { BUS_DIR: path.join(wsB, "bus"), BUS_WAKE_DRY: "1" });
isoA.code === 0 && /would knock/.test(isoA.out) && isoB.code === 0 && /would knock/.test(isoB.out)
  && isoA2.code === 6 && /门铃账本损坏/.test(isoA2.err) && isoB2.code === 0 && /would knock/.test(isoB2.out)
  ? ok("账本按工作区隔离", "父目录坏账本不影响；ws-a 自己的坏账本只挡 ws-a，ws-b 照常")
  : bad("账本按工作区隔离", JSON.stringify({ a: isoA.code, b: isoB.code, a2: isoA2.code, b2: isoB2.code }));
try { fs.rmSync(pRoot, { recursive: true, force: true }); } catch {}

// 21i) nudge 注入成功后写门铃账本（TRAE 03403 第 2 条：写侧共享，先催后门铃不二次注入）
const kn = fs.mkdtempSync(path.join(os.tmpdir(), "nudge-mark-"));
for (const f of ["nudge.mjs", "knock-ledger.mjs", "bus-store.mjs"]) fs.copyFileSync(path.join(HERE, f), path.join(kn, f));
fs.writeFileSync(path.join(kn, "trae-inject.mjs"), "process.exit(0);\n");
const knRoot = path.join(kn, "ws");
fs.mkdirSync(path.join(knRoot, "bus"), { recursive: true });
fs.writeFileSync(path.join(knRoot, "bus", "state.json"), JSON.stringify({ tasks: [{ id: "T-000009", title: "催办后记账", status: "claimed", assignee: "trae-ide", created_at: oldTs, updated_at: oldTs }], notes: {} }));
const knRun = await iso(path.join(kn, "nudge.mjs"), ["--root", knRoot, "--bus", path.join(knRoot, "bus"), "--stale", "1"]);
const knLg = path.join(knRoot, "watch", "knock-notified.json");
let knIds = [];
try { knIds = JSON.parse(fs.readFileSync(knLg, "utf8")).ids || []; } catch {}
knRun.code === 0 && knIds.includes("T-000009")
  ? ok("nudge 注入后记门铃账本", "催办成功 → knock-notified.json 含该 id")
  : bad("nudge 注入后记门铃账本", JSON.stringify({ code: knRun.code, ids: knIds, err: knRun.err.slice(0, 80) }));
try { fs.rmSync(kn, { recursive: true, force: true }); } catch {}

// 21j) launch-cdp：--help exit 0、未知参数 exit 2、找不到可执行文件 exit 4，且失败路径不留 cdp/ 空状态
const LCH = path.join(HERE, "launch-cdp.mjs");
const cdpBefore = fs.existsSync(path.join(HERE, "cdp"));
const lchHelp = await run(LCH, ["--help"]);
const lchBad = await run(LCH, ["--bogus"]);
const lchNoExe = await run(LCH, ["--only", "trae", "--trae-exe", "Z:/no/such/Trae.exe", "--check"]);
const lchCdps = fs.existsSync(path.join(HERE, "cdp"));
const lchOk = lchHelp.code === 0 && lchBad.code === 2 && lchNoExe.code === 4 && (cdpBefore || !lchCdps);
lchOk
  ? ok("launcher 守卫", "--help exit 0 不落盘；未知参数 exit 2；找不到 exe exit 4")
  : bad("launcher 守卫", JSON.stringify({ help: lchHelp.code, bad: lchBad.code, noexe: lchNoExe.code, cdp: lchCdps }));

srv.kill();
setTimeout(() => {
  if (!process.argv.includes("--keep")) { try { fs.rmSync(BUS, { recursive: true, force: true }); } catch {} }
  // 用例名快照：新增/删除/改名都在这里露出来，避免「数目持平但用例丢了」
  const EXPECTED_CASE_NAMES = [
    "--assignee 生效 / 冲突 exit 2",
    "0 字节按未初始化 exit 5",
    "CAS 抢占",
    "CLI board",
    "CLI done",
    "CLI post",
    "MCP HTTP 单发",
    "MCP legacy SSE",
    "MCP stdio",
    "assignee/to 兼容与冲突 exit 2",
    "bus post --wake 引用任务 id",
    "bus 自派任务不敲门",
    "bus knock 隔离与去重",
    "nudge 停滞催办",
    "ledger 损坏两条路径 exit 6",
    "账本按工作区隔离",
    "nudge 注入后记门铃账本",
    "drill 隔离与 --real 守卫",
    "init --force 才重建",
    "init 建板",
    "selfwake 熔断",
    "trae-inject 守卫",
    "trae-inject 端口自动发现",
    "wake-dsh 守卫",
    "wake-trae 不自叫",
    "wake-trae 出站叫醒",
    "watchdog 移除 --notify-trae",
    "写命令按显式 BUS_DIR 建板",
    "出站叫醒只走 wake-trae",
    "参数守卫",
    "只读命令不建板 exit 5",
    "安装器产出可运行",
    "已装布局二次安装",
    "损坏 exit 6 + 备份 + 不覆盖 + 文案不谎称写入",
    "损坏时 init 拒绝重建 exit 6",
    "未初始化拒绝写入 exit 5",
    "launcher 守卫",
    "缺验收标准只警告 exit 0",
    "note 缺 key 守卫",
  ];
  const got = CASE_NAMES.slice().sort(), want = EXPECTED_CASE_NAMES.slice().sort();
  const missing = want.filter((n) => !got.includes(n)), extra = got.filter((n) => !want.includes(n));
  if (want.length && (missing.length || extra.length)) {
    results.push(false);
    console.log("FAIL  用例集合与快照不一致  — 缺失: " + (missing.join(" / ") || "无") + "；新增: " + (extra.join(" / ") || "无"));
  } else if (want.length) {
    results.push(true);
    console.log("PASS  用例集合与快照一致  — " + got.length + " 个用例名逐一对齐");
  }
  console.log("CASES: " + got.join("|"));
  const pass = results.filter(Boolean).length, total = results.length;
  console.log("\n" + (pass === total ? "ALL PASS" : "FAILED") + "  " + pass + "/" + total + "   (bus: " + BUS + ")");
  if (srvErr && pass !== total) console.log("server stderr: " + srvErr.trim().slice(0, 300));
  process.exitCode = pass === total ? 0 : 1;
}, 300);
