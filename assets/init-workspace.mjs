#!/usr/bin/env node
// init-workspace.mjs — 在目标工作区搭起 DSH ⇄ TRAE 两条通道（任务板 + 信箱）
// 用法: node init-workspace.mjs [--root <dir>] [--force] [--quiet]
// 幂等：已存在的文件默认 skip；--force 才覆盖工具与文档（不会覆盖 bus/ 与 mailbox/ 数据）

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url)); // <skill>/assets
const argv = process.argv.slice(2);
const opt = (name, def = null) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : def;
};
const ROOT = path.resolve(opt("--root", process.cwd()));
const FORCE = argv.includes("--force");
const QUIET = argv.includes("--quiet");

const log = (...a) => { if (!QUIET) console.log(...a); };
let copied = 0, skipped = 0, created = 0;

const ensureDir = (rel) => {
  const p = path.join(ROOT, rel);
  if (!fs.existsSync(p)) { fs.mkdirSync(p, { recursive: true }); created++; log("  mkdir  " + rel); }
  return p;
};
const copyIfMissing = (srcRel, dstRel) => {
  const src = path.join(HERE, srcRel);
  const dst = path.join(ROOT, dstRel);
  if (fs.existsSync(dst) && !FORCE) { skipped++; log("  skip   " + dstRel); return; }
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.copyFileSync(src, dst);
  copied++; log("  copy   " + dstRel);
};

if (!fs.existsSync(ROOT)) {
  // 早期版本直接报错退出（TRAE 复验时踩过）；目标目录只是想装东西，自动创建更省事
  try { fs.mkdirSync(ROOT, { recursive: true }); } catch (e) {
    console.error("无法创建 root：" + ROOT + " — " + e.message);
    process.exit(1);
  }
  log("[init] 创建 root");
}
log("[init] root = " + ROOT);

for (const d of ["tools", "bus", "mailbox", "docs"]) ensureDir(d);

const TOOLS = ["bus-store.mjs", "bus-cli.mjs", "knock-ledger.mjs", "mailbox.mjs",
  "mcp-bus-server.mjs", "mcp-bus-client.mjs",
  "selftest.mjs", "mailbox-selftest.mjs", "init-workspace.mjs", "watchdog.mjs", "selfwake.mjs",
  "trae-inject.mjs", "wake-trae.mjs", "wake-dsh.mjs",
  "nudge.mjs"];
for (const t of TOOLS) copyIfMissing(t, "tools/" + t);

// 参考文档的来源随布局变化：
//   package/assets/init-workspace.mjs → ../references/*.md
//   已安装工作区/tools/init-workspace.mjs → 优先 ../docs/*.md（首次装出来的那份），否则 ../references
const DOC_DIRS = [
  path.join(HERE, "..", "references"),
  path.join(HERE, "references"),
  path.join(HERE, "..", "docs"),
  path.join(HERE, "docs"),
];
const findDoc = (name) => {
  for (const d of DOC_DIRS) {
    const c = path.join(d, name);
    if (fs.existsSync(c)) return c;
  }
  return null;
};
for (const name of ["邮政协议-v0.2.md", "TRAE侧-接入卡.md"]) {
  const dst = path.join(ROOT, "docs", name);
  if (fs.existsSync(dst) && !FORCE) { skipped++; log("  skip   docs/" + name); continue; }
  const src = findDoc(name);
  if (!src) {
    // 装完的工具链本身可用；缺文档不该让整个安装失败（曾因 ../references 不存在 exit 1 留下半成品）
    console.warn("[init] 警告：找不到参考文档 " + name + "（已装工具不受影响；未复制的文档可在仓库 references/ 里取）");
    continue;
  }
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.copyFileSync(src, dst);
  copied++; log("  copy   docs/" + name);
}

// .gitignore：本地运行产物不入库（信箱与任务板默认不共享到 git）
// 模板只有一份：包内的 .gitignore（这里不再内联写死，否则新装工作区与仓库会各有一份真相）
const GI_TEMPLATE_DIRS = [path.join(HERE, ".."), HERE];
const GI_FALLBACK = "# 运行期数据（本地才生成，不入库）\nbus/\nmailbox/\nwatch/\n.trae-link/\ndist/\n.tmp/\n*.log\n*.corrupt-*\nnode_modules/\n";
const gi = path.join(ROOT, ".gitignore");
if (!fs.existsSync(gi) || FORCE) {
  let content = GI_FALLBACK, from = "(内嵌)";
  for (const d of GI_TEMPLATE_DIRS) {
    const c = path.join(d, ".gitignore");
    if (fs.existsSync(c)) { content = fs.readFileSync(c, "utf8"); from = c; break; }
  }
  fs.writeFileSync(gi, content, "utf8");
  copied++; log("  write  .gitignore" + (from === "(内嵌)" ? "" : "  (模板 " + from + ")"));
}

// 任务板初始化：state.json 只由显式 init 创建（读命令永不落盘）
process.env.BUS_DIR = path.join(ROOT, "bus");
const store = await import(pathToFileURL(path.join(ROOT, "tools", "bus-store.mjs")).href);
let boardNote, boardCode = 0;
try {
  const st = store.initState(false);
  boardNote = (st.created ? "initialized " : "already initialized ") + st.path +
              (st.created ? "" : "  (" + st.tasks + " tasks)");
} catch (e) {
  // 数据优先：损坏的任务板绝不因"再跑一次安装器"被清空。文件照装，退出码非 0 提醒有人处理。
  boardNote = (e.code === 6 ? "corrupt（拒绝重建，原文件与备份都保留）" : "error " + (e.code || 1)) +
              " → " + String(e.message || e).split("\n")[0];
  boardCode = e.code === 6 ? 6 : 1;
}
log("");
log("[init] board: " + boardNote);

log("[init] done: created=" + created + " copied=" + copied + " skipped=" + skipped);
log("next:");
log("  node tools/selftest.mjs              # 39/39");
log("  node tools/mailbox-selftest.mjs      # 12/12");
log("  node tools/bus-cli.mjs board");
if (boardCode) {
  log("");
  log("[init] ⚠ 任务板未就绪（exit " + boardCode + "）。工具与文档已装好；修好 state.json 后重跑本命令，或用 --force 重建（会丢现有任务）。");
  process.exitCode = boardCode;
}
