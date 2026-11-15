#!/usr/bin/env node
// 把 assets/launch-cdp.mjs 打包成「一个 .cmd 文件」：JS 以 base64 嵌在批处理里，
// 首次运行时解码到 %LOCALAPPDATA%\dsh-trae-cdp\，之后哈希没变就跳过解码。
// 目的：单文件可放在任何地方（桌面、U 盘），不依赖同目录的 tools/launch-cdp.mjs。
//
//   node release/build-singlefile.mjs [--src <launch-cdp.mjs>] [--out <file>]
//        [--dsh-exe <path>] [--trae-exe <path>] [--help]
//
//   --dsh-exe/--trae-exe 会把该机器的可执行文件路径写成文件内的默认值（DSH_EXE/TRAE_EXE），
//   适合「本机个人启动器」；对外分发的通用版不要带，改用 launch.config.json 或环境变量。
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PKG = path.resolve(HERE, "..");

function parseArgs(argv) {
  const a = { src: path.join(PKG, "assets", "launch-cdp.mjs"), out: "", dshExe: "", traeExe: "" };
  for (let i = 2; i < argv.length; i++) {
    const k = argv[i];
    if (k === "--help" || k === "-h") a.help = true;
    else if (k === "--src") a.src = argv[++i];
    else if (k === "--out") a.out = argv[++i];
    else if (k === "--dsh-exe") a.dshExe = argv[++i];
    else if (k === "--trae-exe") a.traeExe = argv[++i];
    else { console.error("[single] 未知参数：" + k); process.exit(2); }
  }
  return a;
}

const args = parseArgs(process.argv);
if (args.help) {
  console.log("用法：node release/build-singlefile.mjs [--src <launch-cdp.mjs>] [--out <file>] [--dsh-exe <path>] [--trae-exe <path>]");
  console.log("  默认 --src assets/launch-cdp.mjs，--out dist/launch-cdp-single.cmd");
  process.exit(0);
}
if (!args.src || !fs.existsSync(args.src)) { console.error("[single] 找不到源文件：" + args.src); process.exit(2); }

const srcBuf = fs.readFileSync(args.src);
const b64 = srcBuf.toString("base64");
const hash12 = crypto.createHash("sha256").update(srcBuf).digest("hex").slice(0, 12);
const chunks = [];
for (let i = 0; i < b64.length; i += 400) chunks.push(b64.slice(i, i + 400));

const machineDefaults = [];
if (args.dshExe) machineDefaults.push('set "DSH_EXE=' + args.dshExe.replace(/\//g, "\\") + '"');
if (args.traeExe) machineDefaults.push('set "TRAE_EXE=' + args.traeExe.replace(/\//g, "\\") + '"');

const head = [
  "@echo off",
  "setlocal enableextensions",
  "chcp 65001 >nul 2>&1",
  "rem ==========================================================================",
  "rem  DSH-TRAE CDP launcher - SINGLE FILE build",
  "rem",
  "rem  One file on disk: the launcher JS is embedded below as base64 and",
  "rem  unpacked to %LOCALAPPDATA%\\dsh-trae-cdp\\ on first run (or when the",
  "rem  embedded copy changes). No companion .mjs and no workspace required.",
  "rem",
  "rem  Usage:  <this file>                  launch with CDP ports (asks before restarting)",
  "rem          <this file> --check          health check (exit 0 = both injectable)",
  "rem          <this file> --dry            print what would run",
  "rem          <this file> --restart        close and relaunch (interrupts DSH session)",
  "rem          <this file> --root <ws>      write cdp/state.json into that workspace",
  "rem",
  "rem  Non-standard install paths (optional):",
  "rem    %LOCALAPPDATA%\\dsh-trae-cdp\\launch.config.json  {\"dshExe\":\"...\",\"traeExe\":\"...\"}",
  "rem    or set DSH_EXE / TRAE_EXE (a machine-specific copy may already set them below).",
  "rem ==========================================================================",
  'if not defined LOCALAPPDATA set "LOCALAPPDATA=%TEMP%"',
  'set "HOME_DIR=%LOCALAPPDATA%\\dsh-trae-cdp"',
  'if not exist "%HOME_DIR%" md "%HOME_DIR%" >nul 2>&1',
  "",
];
if (machineDefaults.length) {
  head.push("rem --- machine defaults baked in by build-singlefile.mjs ---");
  head.push(...machineDefaults);
  head.push("");
}
head.push(
  'set "NODE="',
  'if defined DSH_NODE if exist "%DSH_NODE%" set "NODE=%DSH_NODE%"',
  "if not defined NODE for /f \"delims=\" %%n in ('where node 2^>nul') do if not defined NODE set \"NODE=%%n\"",
  'if not defined NODE if exist "%USERPROFILE%\\.dsh\\dsh-runtimes\\dsh-primary-runtime\\dependencies\\node\\bin\\node.exe" set "NODE=%USERPROFILE%\\.dsh\\dsh-runtimes\\dsh-primary-runtime\\dependencies\\node\\bin\\node.exe"',
  'if not defined NODE if exist "%ProgramFiles%\\nodejs\\node.exe" set "NODE=%ProgramFiles%\\nodejs\\node.exe"',
  "if not defined NODE (",
  "  echo [launch-cdp] Node.js not found.",
  "  echo [launch-cdp] Install Node.js 18+, or set DSH_NODE to a node.exe path.",
  "  pause",
  "  exit /b 8",
  ")",
  "",
  'set "JS=%HOME_DIR%\\launch-cdp.mjs"',
  'set "B64=%HOME_DIR%\\launch-cdp.b64"',
  'set "STAMP=%HOME_DIR%\\launch-cdp.hash"',
  'set "WANT=' + hash12 + '"',
  'set "HAVE="',
  'if exist "%STAMP%" set /p HAVE=<"%STAMP%"',
  'if not "%HAVE%"=="%WANT%" (',
  "  (",
);
const body = chunks.map((c) => "    echo " + c).join("\r\n");
const tail = [
  '  ) > "%B64%"',
  '  "%NODE%" -e "const fs=require(\'fs\');const s=fs.readFileSync(process.argv[1],\'utf8\').replace(/[^A-Za-z0-9+\\/=]/g,\'\');fs.writeFileSync(process.argv[2],Buffer.from(s,\'base64\'))" "%B64%" "%JS%"',
  "  if errorlevel 1 (",
  "    echo [launch-cdp] Failed to unpack the embedded launcher.",
  "    pause",
  "    exit /b 8",
  "  )",
  '  > "%STAMP%" echo %WANT%',
  '  del "%B64%" >nul 2>&1',
  ")",
  "",
  'set "ASK="',
  'if "%~1"=="" set "ASK=--ask"',
  '"%NODE%" "%JS%" --root "%HOME_DIR%" %ASK% %*',
  'set "RC=%ERRORLEVEL%"',
  'if "%~1"=="" pause',
  "endlocal & exit /b %RC%",
].join("\r\n");

const out = head.join("\r\n") + "\r\n" + body + "\r\n" + tail + "\r\n";
const outPath = args.out || path.join(PKG, "dist", "launch-cdp-single.cmd");
fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath + ".tmp", out);
fs.renameSync(outPath + ".tmp", outPath);
console.log("[single] " + outPath);
console.log("[single] 源 " + srcBuf.length + " B → 输出 " + Buffer.byteLength(out) + " B，内嵌哈希 " + hash12 + (machineDefaults.length ? "，含机器默认路径 " + machineDefaults.length + " 条" : ""));
