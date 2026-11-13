#!/usr/bin/env node
/**
 * knock-ledger.mjs — 门铃幂等账本（共享模块）
 *
 * <workspace>/watch/knock-notified.json:
 *   { "ids": ["20261113-0152-001", "T-000023"], "at": { "<id>": 1762... } }
 *
 * 解决两件事：
 *   1) 同一 id 不要重复敲门（§已通知去重）；
 *   2) nudge 前检查「刚刚是不是已经敲过」——避免 wake-trae 与 nudge 在同一轮各注入一次。
 *
 * 损坏策略：备份 + 大声警告 + 本次不敲（宁可不叫，也不刷屏）；绝不静默当成空集合。
 */
import fs from "node:fs";
import path from "node:path";

const MAX_IDS = 500;

/** 从 mailbox/ 或 bus/ 目录反推工作区根：只有末段是 mailbox/bus 才上一级，否则按给定目录当作工作区（避免同父目录互相污染）。 */
export function resolveWorkspace(dir) {
  const abs = path.resolve(String(dir || "."));
  const base = path.basename(abs).toLowerCase();
  return base === "mailbox" || base === "bus" ? path.dirname(abs) : abs;
}

export function ledgerFile(workspaceRoot) {
  return path.join(path.resolve(String(workspaceRoot || ".")), "watch", "knock-notified.json");
}

export function loadLedger(workspaceRoot) {
  const p = ledgerFile(workspaceRoot);
  try {
    const j = JSON.parse(fs.readFileSync(p, "utf8"));
    const ids = Array.isArray(j && j.ids) ? j.ids.filter((x) => typeof x === "string") : [];
    const at = j && j.at && typeof j.at === "object" ? j.at : {};
    return { status: "ok", path: p, ids, at };
  } catch (e) {
    if (e.code === "ENOENT") return { status: "missing", path: p, ids: [], at: {} };
    return { status: "corrupt", path: p, ids: [], at: {}, error: e.message };
  }
}

export function backupCorrupt(l) {
  const bak = l.path + ".corrupt-" + Date.now();
  try { fs.mkdirSync(path.dirname(l.path), { recursive: true }); fs.copyFileSync(l.path, bak); } catch {}
  return bak;
}

export function markKnocked(workspaceRoot, id) {
  const l = loadLedger(workspaceRoot);
  const ids = [...l.ids];
  if (!ids.includes(id)) ids.push(id);
  const keep = ids.slice(-MAX_IDS);
  const at = {};
  for (const k of keep) if (l.at[k]) at[k] = l.at[k];
  at[id] = Date.now();
  const p = ledgerFile(workspaceRoot);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = p + ".tmp-" + process.pid + "-" + Date.now();
  fs.writeFileSync(tmp, JSON.stringify({ ids: keep, at }, null, 2) + "\n");
  fs.renameSync(tmp, p);
}

export function alreadyKnocked(workspaceRoot, id) {
  return loadLedger(workspaceRoot).ids.includes(id);
}

export function knockedWithin(workspaceRoot, id, ms) {
  const at = loadLedger(workspaceRoot).at[id];
  return typeof at === "number" && Date.now() - at < ms;
}

export function corruptionNote(l) {
  const bak = backupCorrupt(l);
  return "[knock] 门铃账本损坏（" + l.path + "）：" + (l.error || "") +
    "；已备份到 " + bak + "。本次不敲门，避免重复刷屏；修好或删掉账本后重试。";
}
