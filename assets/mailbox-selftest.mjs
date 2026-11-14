#!/usr/bin/env node
/**
 * mailbox-selftest.mjs — 信箱自检（临时 MAILBOX_DIR，不碰正式信箱）
 *
 *   node tools/mailbox-selftest.mjs            # 15 项，全 PASS 即协议可用
 *   node tools/mailbox-selftest.mjs --keep     # 保留临时目录看现场
 *
 * 覆盖协议 v0.2 的硬保证：正文不可为空 / id 并发唯一（wx 独占创建）/ 游标推进 / --after 增量 /
 * 读命令信箱不存在时不建目录（exit 5）/ 信箱路径是文件时读与写都干净 exit 5。
 * 退出码：0 全通过，1 有失败。
 */
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MB = path.join(HERE, "mailbox.mjs");
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), "mailbox-selftest-"));
const env = { ...process.env, MAILBOX_DIR: DIR };
const results = [];
const ok = (n, d = "") => { results.push(true); console.log("PASS  " + n + (d ? "  — " + d : "")); };
const bad = (n, d = "") => { results.push(false); console.log("FAIL  " + n + (d ? "  — " + d : "")); };
const run = (args) => new Promise((resolve) => {
  execFile(process.execPath, [MB, ...args], { env, timeout: 20000 },
    (e, so, se) => resolve({ code: e ? (e.code ?? 1) : 0, out: String(so || ""), err: String(se || "") }));
});
const letters = () => fs.readdirSync(DIR).filter((f) => /^\d{8}-\d{4}-\d{3}\.md$/.test(f));

// 1. --help 不执行 post
const h = await run(["--help"]);
h.code === 0 && /mailbox\.mjs/.test(h.out) && letters().length === 0 ? ok("--help 只看帮助", "未产生信件") : bad("--help", "code " + h.code + " letters " + letters().length);

// 2. --body-file 正文落地
const bodyFile = path.join(DIR, "body.md");
fs.writeFileSync(bodyFile, "第一段中文正文 → 引号「测试」\n\n第二段\n", "utf8");
const p1 = await run(["post", "--from", "dsh-lead", "--to", "trae-ide", "--subject", "hello", "--body-file", bodyFile]);
let bodyChars = 0;
try { bodyChars = fs.readFileSync(path.join(DIR, p1.out.trim() + ".md"), "utf8").split(/^---$/m).slice(2).join("---").trim().length; } catch {}
p1.code === 0 && bodyChars > 20 ? ok("post --body-file 正文非空", bodyChars + " 字符") : bad("post --body-file", "code " + p1.code + " chars " + bodyChars);

// 3. 空正文必须 exit 4
const e1 = await run(["post", "--from", "dsh-lead", "--to", "trae-ide", "--subject", "empty"]);
e1.code === 4 && letters().length === 1 ? ok("空正文 exit 4 拒绝写入") : bad("空正文 exit 4", "code " + e1.code + " letters " + letters().length);

// 4. 并发 8 封：id 唯一、文件数一致、正文都在
const jobs = Array.from({ length: 8 }, (_, i) =>
  run(["post", "--from", "dsh-lead", "--to", "trae-ide", "--subject", "race" + i, "--body", "并发正文第 " + i + " 封，用于验证 wx 独占创建"]));
const rs = await Promise.all(jobs);
const ids = rs.map((r) => r.out.trim()).filter(Boolean);
const allNonEmpty = ids.every((id) => {
  try { return fs.readFileSync(path.join(DIR, id + ".md"), "utf8").split(/^---$/m).slice(2).join("---").trim().length > 10; } catch { return false; }
});
rs.every((r) => r.code === 0) && ids.length === 8 && new Set(ids).size === 8 && letters().length === 9 && allNonEmpty
  ? ok("并发 8 封 id 唯一", "9 个文件，正文全在")
  : bad("并发 8 封", "codes " + rs.map((r) => r.code).join(",") + " ids " + ids.length + "/" + new Set(ids).size + " files " + letters().length);

// 5. 游标推进：第二轮只出现新信
const d2 = fs.mkdtempSync(path.join(os.tmpdir(), "mailbox-cursor-"));
const env2 = { ...process.env, MAILBOX_DIR: d2 };
const run2 = (args) => new Promise((resolve) => {
  execFile(process.execPath, [MB, ...args], { env: env2, timeout: 20000 },
    (e, so, se) => resolve({ code: e ? (e.code ?? 1) : 0, out: String(so || ""), err: String(se || "") }));
});
await run2(["post", "--from", "dsh-lead", "--to", "trae-ide", "--subject", "a", "--body", "第一封正文，够长以通过校验"]);
await run2(["post", "--from", "dsh-lead", "--to", "trae-ide", "--subject", "b", "--body", "第二封正文，够长以通过校验"]);
const i1 = await run2(["inbox", "--as", "trae-ide", "--advance"]);
await run2(["post", "--from", "dsh-lead", "--to", "trae-ide", "--subject", "c", "--body", "第三封正文，够长以通过校验"]);
const i2 = await run2(["inbox", "--as", "trae-ide", "--advance"]);
const n1 = i1.out.trim().split("\n").filter(Boolean).length, n2 = i2.out.trim().split("\n").filter(Boolean).length;
n1 === 2 && n2 === 1 ? ok("游标 --advance 增量", "首轮 2 封 / 次轮 1 封") : bad("游标 --advance", "n1=" + n1 + " n2=" + n2);

// 6. --after 只列更大 id
const a1 = await run2(["inbox", "--as", "trae-ide", "--after", i1.out.trim().split("\n")[0].split(" ")[0]]);
a1.out.trim().split("\n").filter(Boolean).length === 2 ? ok("--after 增量过滤") : bad("--after", a1.out.slice(0, 100));

// 7+8. 游标只推进到"本轮列出来的"最大 id，且空轮不推进
const d3 = fs.mkdtempSync(path.join(os.tmpdir(), "mailbox-cursor2-"));
const env3 = { ...process.env, MAILBOX_DIR: d3 };
const run3 = (args) => new Promise((resolve) => {
  execFile(process.execPath, [MB, ...args], { env: env3, timeout: 20000 },
    (e, so, se) => resolve({ code: e ? (e.code ?? 1) : 0, out: String(so || ""), err: String(se || "") }));
});
const mine = await run3(["post", "--from", "dsh-lead", "--to", "trae-ide", "--subject", "mine", "--body", "写给我的第一封，正文足够长"]); 
await run3(["post", "--from", "dsh-lead", "--to", "someone-else", "--subject", "o1", "--body", "写给别人的高序号信，正文够长"]);
await run3(["post", "--from", "dsh-lead", "--to", "someone-else", "--subject", "o2", "--body", "写给别人的更高序号信，正文够长"]);
const boxMax = fs.readdirSync(d3).filter((f) => /^\d{8}-\d{4}-\d{3}\.md$/.test(f)).sort().at(-1).slice(0, -3);
const myId = mine.out.trim();
const a7 = await run3(["inbox", "--as", "trae-ide", "--advance"]);
const cp = path.join(d3, ".cursor-trae-ide");
const cur1 = fs.existsSync(cp) ? fs.readFileSync(cp, "utf8").trim() : "";
cur1 === myId && cur1 !== boxMax
  ? ok("游标 = 本轮列出的最大 id", cur1 + "（全箱最大 " + boxMax + " 未采用）")
  : bad("游标 = 本轮列出的最大 id", "cursor=" + cur1 + " mine=" + myId + " boxMax=" + boxMax);

const a8 = await run3(["inbox", "--as", "trae-ide", "--advance"]);
const cur2 = fs.existsSync(cp) ? fs.readFileSync(cp, "utf8").trim() : "";
cur2 === cur1 && /不推进/.test(a8.err)
  ? ok("空轮不推进游标", "cursor 保持 " + cur2)
  : bad("空轮不推进游标", "cursor=" + cur2 + " err=" + a8.err.trim().slice(0, 60));

// 9. Re: 前缀不重复拼接（连回两封仍只有一个 Re:）
const d4 = fs.mkdtempSync(path.join(os.tmpdir(), "mailbox-re-"));
const env4 = { ...process.env, MAILBOX_DIR: d4 };
const run4 = (args) => new Promise((resolve) => {
  execFile(process.execPath, [MB, ...args], { env: env4, timeout: 20000 },
    (e, so, se) => resolve({ code: e ? (e.code ?? 1) : 0, out: String(so || ""), err: String(se || "") }));
});
const r0 = await run4(["post", "--from", "dsh-lead", "--to", "trae-ide", "--subject", "协议草案", "--body", "原始信件正文，长度足够通过校验"]);
const r1 = await run4(["reply", r0.out.trim(), "--from", "trae-ide", "--body", "第一封回信正文，长度足够通过校验"]);
const r2 = await run4(["reply", r1.out.trim(), "--from", "dsh-lead", "--body", "第二封回信正文，长度足够通过校验"]);
const subj2 = (() => { try { return fs.readFileSync(path.join(d4, r2.out.trim() + ".md"), "utf8").match(/^subject:\s*(.*)$/m)[1]; } catch { return ""; } })();
subj2 === "Re: 协议草案"
  ? ok("Re: 前缀不重复", subj2)
  : bad("Re: 前缀", JSON.stringify(subj2));

// 10. --wake 干跑：只打印引用 id 的提醒，不真正敲 TRAE
const d5 = fs.mkdtempSync(path.join(os.tmpdir(), "mailbox-wake-"));
const env5 = { ...process.env, MAILBOX_DIR: d5, MAILBOX_WAKE_DRY: "1" };
const run5 = (args) => new Promise((resolve) => {
  execFile(process.execPath, [MB, ...args], { env: env5, timeout: 20000 },
    (e, so, se) => resolve({ code: e ? (e.code ?? 1) : 0, out: String(so || ""), err: String(se || "") }));
});
const w1 = await run5(["post", "--from", "dsh-lead", "--to", "trae-ide", "--subject", "敲门测试", "--body", "这是测试正文，长度足够通过校验", "--wake", "--wake-force"]);
const wid = w1.out.split("\n")[0].trim();
w1.code === 0 && /\[wake\] would knock: 【DSH 叫醒】新信 /.test(w1.out) && w1.out.includes(wid) && w1.out.includes("正文只在文件里")
  ? ok("--wake 干跑只发引用 id", wid)
  : bad("--wake 干跑", JSON.stringify(w1.out.slice(0, 120)) + " code=" + w1.code);

// 11. 自发信不敲门：from=trae-ide 且 to=dsh-lead 时 --wake 必须跳过（TRAE T-000021 抓到的自叫醒）
const d6 = fs.mkdtempSync(path.join(os.tmpdir(), "mailbox-selfwake-"));
const env6 = { ...process.env, MAILBOX_DIR: d6, MAILBOX_WAKE_DRY: "1" };
const run6 = (args) => new Promise((resolve) => {
  execFile(process.execPath, [MB, ...args], { env: env6, timeout: 20000 },
    (e, so, se) => resolve({ code: e ? (e.code ?? 1) : 0, out: String(so || ""), err: String(se || "") }));
});
const s1 = await run6(["post", "--from", "trae-ide", "--to", "dsh-lead", "--subject", "自发", "--body", "这是自发信正文，长度足够通过校验", "--wake"]);
const s2 = await run6(["post", "--from", "dsh-lead", "--to", "trae-ide", "--subject", "正常", "--body", "这是外发信正文，长度足够通过校验", "--wake", "--wake-force"]);
s1.code === 0 && !/would knock/.test(s1.out) && /跳过敲门/.test(s1.err) && /would knock/.test(s2.out)
  ? ok("自发信不敲门", "from=trae-ide 跳过；外发仍敲门")
  : bad("自发信不敲门", "self=" + JSON.stringify(s1.out.slice(-80)) + " err=" + s1.err.trim().slice(0, 60) + " normal=" + /would knock/.test(s2.out));

// 12. 幽灵 id 守卫 + 已通知去重（TRAE T-000022 挂账）：隔离信箱默认不敲、ledger 命中跳过
const d7 = fs.mkdtempSync(path.join(os.tmpdir(), "mailbox-knock-"));
const env7 = { ...process.env, MAILBOX_DIR: d7, MAILBOX_WAKE_DRY: "1" };
const run7 = (args) => new Promise((resolve) => {
  execFile(process.execPath, [MB, ...args], { env: env7, timeout: 20000 },
    (e, so, se) => resolve({ code: e ? (e.code ?? 1) : 0, out: String(so || ""), err: String(se || "") }));
});
const k1 = await run7(["post", "--from", "dsh-lead", "--to", "trae-ide", "--subject", "隔离不敲", "--body", "这是隔离信箱正文，长度足够通过校验", "--wake"]);
const k1id = k1.out.split("\n")[0].trim();
const k2 = await run7(["knock", k1id]);
const k3 = await run7(["knock", k1id, "--wake-force"]);
const kLedger = path.join(d7, "watch", "knock-notified.json"); // 自定义目录不是 .../mailbox 时，它自己就是工作区根
fs.mkdirSync(path.dirname(kLedger), { recursive: true });
fs.writeFileSync(kLedger, JSON.stringify({ ids: [k1id] }));
const k4 = await run7(["knock", k1id, "--wake-force"]);
k1.code === 0 && /隔离信箱/.test(k1.err) && !/would knock/.test(k1.out) && /隔离信箱/.test(k2.err) && /would knock/.test(k3.out) && /已通知过/.test(k4.err) && !/would knock/.test(k4.out)
  ? ok("幽灵 id 守卫 + 去重", "隔离默认不敲 / --wake-force 干跑 / ledger 命中跳过")
  : bad("幽灵 id 守卫 + 去重", JSON.stringify({ post: k1.err.trim().slice(0, 50), force: /would knock/.test(k3.out), dup: k4.err.trim().slice(0, 50) }));
try { fs.rmSync(d7, { recursive: true, force: true }); } catch {}

// 13. 读命令遇到不存在的信箱：exit 5 且不建目录（cwd 错了不能静默造出一个空信箱）
const d8 = fs.mkdtempSync(path.join(os.tmpdir(), "mailbox-nodir-"));
const noBox = path.join(d8, "no-such", "mailbox");
const run8 = (args) => new Promise((resolve) => {
  execFile(process.execPath, [MB, ...args, "--dir", noBox], { env, timeout: 20000 },
    (e, so, se) => resolve({ code: e ? (e.code ?? 1) : 0, out: String(so || ""), err: String(se || "") }));
});
const rd1 = await run8(["inbox", "--as", "trae-ide", "--advance"]);
const rd2 = await run8(["read", "20260101-0000-001"]);
const rd3 = await run8(["threads"]);
const rd4 = await run8(["knock", "20260101-0000-001"]);
const noDirMade = !fs.existsSync(path.dirname(noBox));
[rd1, rd2, rd3, rd4].every((r) => r.code === 5) && /信箱不存在/.test(rd1.err) && /--dir/.test(rd1.err) && noDirMade
  ? ok("读命令信箱不存在 exit 5", "inbox/read/threads/knock 全 5，未建目录")
  : bad("读命令信箱不存在 exit 5", "codes " + [rd1, rd2, rd3, rd4].map((r) => r.code).join(",") + " dirMade=" + !noDirMade + " err=" + rd1.err.trim().slice(0, 60));

// 14. --help 不建目录；写命令仍会建（读严写宽必须是同一个闸门的两侧）
const hp = await run8(["--help"]);
const madeByHelp = fs.existsSync(path.dirname(noBox));   // 必须在 post 之前取，否则测的是 post 建的目录
const wr = await run8(["post", "--from", "dsh-lead", "--to", "trae-ide", "--subject", "建目录", "--body", "写命令应当建出信箱目录，正文长度足够通过校验"]);
hp.code === 0 && !madeByHelp && wr.code === 0 && fs.existsSync(noBox)
  ? ok("--help 不建目录 / post 建目录", "读不落盘，写才落盘")
  : bad("--help 不建目录 / post 建目录", "help=" + hp.code + " helpMade=" + madeByHelp + " post=" + wr.code + " postMade=" + fs.existsSync(noBox));
try { fs.rmSync(d8, { recursive: true, force: true }); } catch {}

// 15. 写命令遇到「信箱路径是个文件」：必须干净 exit 5，不能抛 ENOTDIR 带堆栈 exit 1（TRAE 2320 抓）
const d9 = fs.mkdtempSync(path.join(os.tmpdir(), "mailbox-notdir-"));
const asFile = path.join(d9, "mailbox");
fs.writeFileSync(asFile, "not a directory", "utf8");
const run9 = (args) => new Promise((resolve) => {
  execFile(process.execPath, [MB, ...args, "--dir", asFile], { env, timeout: 20000 },
    (e, so, se) => resolve({ code: e ? (e.code ?? 1) : 0, out: String(so || ""), err: String(se || "") }));
});
const wr1 = await run9(["post", "--from", "dsh-lead", "--to", "trae-ide", "--subject", "文件挡路", "--body", "写命令撞到同名文件时必须干净失败，正文长度足够通过校验"]);
const rd5 = await run9(["inbox", "--as", "trae-ide"]);
const noStack = !/\n\s+at |Error:\s/.test(wr1.err) && !/\n\s+at |Error:\s/.test(rd5.err);
wr1.code === 5 && rd5.code === 5 && /不是目录/.test(wr1.err) && /不是目录/.test(rd5.err) && noStack && fs.statSync(asFile).isFile()
  ? ok("信箱路径是文件时写/读都 exit 5", "无堆栈、原文件未被破坏")
  : bad("信箱路径是文件时写/读都 exit 5", "write=" + wr1.code + " read=" + rd5.code + " stack=" + !noStack + " tail=" + wr1.err.trim().slice(-60));
try { fs.rmSync(d9, { recursive: true, force: true }); } catch {}

setTimeout(() => {
  if (!process.argv.includes("--keep")) { try { fs.rmSync(DIR, { recursive: true, force: true }); fs.rmSync(d2, { recursive: true, force: true }); fs.rmSync(d3, { recursive: true, force: true }); fs.rmSync(d4, { recursive: true, force: true }); fs.rmSync(d5, { recursive: true, force: true }); fs.rmSync(d6, { recursive: true, force: true }); } catch {} }
  const pass = results.filter(Boolean).length, total = results.length;
  console.log("\n" + (pass === total ? "ALL PASS" : "FAILED") + "  " + pass + "/" + total + "   (dir: " + DIR + ")");
  process.exit(pass === total ? 0 : 1);
}, 50);
