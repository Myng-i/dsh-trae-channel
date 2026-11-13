#!/usr/bin/env node
// release/build-zip.mjs — 确定性打 zip：同样输入 → 逐字节相同的产物。
// 用法:
//   node release/build-zip.mjs --ref v0.3.1 --out ../dist/dsh-trae-channel-v0.3.1.zip
//   node release/build-zip.mjs --worktree --out ../dist/x.zip
// 约定: 包内只放技能负载(SKILL.md/README.md/LICENSE/.gitignore/assets/**,references/**)；
//       .gitattributes 与 release/ 属仓库工具，不入包(保持 22 文件口径)。
"use strict";
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const REPO = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const GIT = process.env.GIT || "git";
const SKIP_TOP = new Set([".git", "release", ".gitattributes"]);

function parseArgs(argv) {
  const out = { ref: null, worktree: false, out: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--ref") out.ref = argv[++i];
    else if (a === "--worktree") out.worktree = true;
    else if (a === "--out") out.out = argv[++i];
    else if (a === "--help" || a === "-h") out.help = true;
    else throw new Error("unknown arg: " + a);
  }
  return out;
}

function gitEnv() {
  const env = Object.assign({}, process.env);
  env.GIT_TERMINAL_PROMPT = "0";
  return env;
}

function listFromRef(ref) {
  const raw = execFileSync(GIT, ["-C", REPO, "ls-tree", "-r", "-z", "--name-only", ref], {
    encoding: "utf8", env: gitEnv(), maxBuffer: 64 * 1024 * 1024,
  });
  return raw.split("\0").filter(Boolean).map((p) => p.replace(/\\/g, "/")).sort();
}

function readFromRef(ref, p) {
  return execFileSync(GIT, ["-C", REPO, "cat-file", "blob", ref + ":" + p], {
    env: gitEnv(), maxBuffer: 256 * 1024 * 1024,
  });
}

function listFromWorktree() {
  const acc = [];
  const walk = (dir, rel) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const r = rel ? rel + "/" + e.name : e.name;
      if (!rel && SKIP_TOP.has(e.name)) continue;
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) walk(abs, r);
      else acc.push(r);
    }
  };
  walk(REPO, "");
  return acc.sort();
}

function keep(files) {
  return files.filter((p) => {
    const top = p.split("/")[0];
    return !SKIP_TOP.has(top) && p !== ".gitattributes";
  });
}

// --- CRC32 ---
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();
function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

// 固定时间戳 1980-01-01 00:00:00 (DOS: date=0x0021, time=0)
const DOS_TIME = 0;
const DOS_DATE = 0x0021;

function buildZip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const { name, data } of entries) {
    const nameBuf = Buffer.from(name, "utf8");
    const ascii = /^[\x20-\x7e]*$/.test(name);
    const flags = ascii ? 0 : 0x0800; // bit 11 = UTF-8 names
    const deflated = zlib.deflateRawSync(data, { level: 9 });
    const store = deflated.length >= data.length;
    const body = store ? data : deflated;
    const method = store ? 0 : 8;
    const crc = crc32(data);

    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);        // version needed
    lh.writeUInt16LE(flags, 6);
    lh.writeUInt16LE(method, 8);
    lh.writeUInt16LE(DOS_TIME, 10);
    lh.writeUInt16LE(DOS_DATE, 12);
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(body.length, 18);
    lh.writeUInt32LE(data.length, 22);
    lh.writeUInt16LE(nameBuf.length, 26);
    lh.writeUInt16LE(0, 28);        // extra len
    locals.push(lh, nameBuf, body);

    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(0x031e, 4);    // made by: unix, spec 3.0
    ch.writeUInt16LE(20, 6);
    ch.writeUInt16LE(flags, 8);
    ch.writeUInt16LE(method, 10);
    ch.writeUInt16LE(DOS_TIME, 12);
    ch.writeUInt16LE(DOS_DATE, 14);
    ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(body.length, 20);
    ch.writeUInt32LE(data.length, 24);
    ch.writeUInt16LE(nameBuf.length, 28);
    ch.writeUInt16LE(0, 30);        // extra
    ch.writeUInt16LE(0, 32);        // comment
    ch.writeUInt16LE(0, 34);        // disk
    ch.writeUInt16LE(0, 36);        // internal attrs
    ch.writeUInt32LE((0o100644 << 16) >>> 0, 38); // external attrs = rw-r--r--
    ch.writeUInt32LE(offset, 42);
    centrals.push(ch, nameBuf);

    offset += lh.length + nameBuf.length + body.length;
  }
  const cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);
  return Buffer.concat([...locals, cd, eocd]);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log("node release/build-zip.mjs --ref <tag|commit> --out <file>   # 从 git blob 打包");
    console.log("node release/build-zip.mjs --worktree --out <file>          # 从工作树打包");
    return 0;
  }
  if (!args.out) throw new Error("--out is required");
  let names, readOne, label;
  if (args.worktree) {
    names = keep(listFromWorktree());
    readOne = (p) => fs.readFileSync(path.join(REPO, p));
    label = "worktree";
  } else {
    const ref = args.ref || "HEAD";
    names = keep(listFromRef(ref));
    readOne = (p) => readFromRef(ref, p);
    label = ref;
  }
  if (names.length === 0) throw new Error("no files");
  const entries = names.map((name) => ({ name, data: readOne(name) }));
  const zip = buildZip(entries);
  fs.mkdirSync(path.dirname(path.resolve(args.out)), { recursive: true });
  fs.writeFileSync(args.out, zip);
  console.log(JSON.stringify({
    ref: label,
    out: args.out,
    files: entries.length,
    bytes: zip.length,
    sha256: crypto.createHash("sha256").update(zip).digest("hex"),
  }, null, 2));
  return 0;
}

try {
  process.exitCode = main();
} catch (e) {
  console.error("[build-zip] " + (e && e.message ? e.message : String(e)));
  process.exitCode = 1;
}
