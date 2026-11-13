#!/usr/bin/env node
/**
 * bus-store.mjs — 共享总线存储层（零依赖）
 * 唯一真相：<BUS_DIR>/state.json（原子写 + 文件锁），审计：<BUS_DIR>/events.jsonl
 * 被 mcp-bus-server.mjs（MCP 传输）与 bus-cli.mjs（终端 CLI）共用。
 */
import fs from "node:fs";
import path from "node:path";

const PROTOCOL = "2025-06-18";
const SERVER_INFO = { name: "dsh-trae-bus", version: "1.0.0" };
export const BUS_DIR = process.env.BUS_DIR || path.join(process.cwd(), "bus");
export const STATE = path.join(BUS_DIR, "state.json");
export const EVENTS = path.join(BUS_DIR, "events.jsonl");
const LOCK = path.join(BUS_DIR, "state.lock");

// 注意：**不在导入时建目录**。导入即建目录是"cwd 错静默新建空板"的根因：
// 任何一次误入空目录的调用都会造出一个看似合法的空板，然后一切"成功"。
const EMPTY = { seq: 0, tasks: [], notes: {} };

export class BusError extends Error {
  constructor(code, message) { super(message); this.name = "BusError"; this.code = code; }
}

/** 只读探测：ok | missing | empty | corrupt。不建目录、不写任何东西。 */
export function stateStatus() {
  let buf;
  try { buf = fs.readFileSync(STATE); }
  catch (e) {
    if (e.code === "ENOENT") return { status: "missing", path: STATE };
    if (e.code === "EISDIR") return { status: "corrupt", path: STATE, error: "state.json 是目录" };
    throw e;
  }
  if (!buf.length) return { status: "empty", path: STATE, bytes: 0 };
  try {
    const st = JSON.parse(buf.toString("utf8").replace(/^\uFEFF/, ""));
    if (!st || !Array.isArray(st.tasks)) throw new Error("缺少 tasks 数组");
    st.notes = st.notes || {};
    return { status: "ok", state: st, bytes: buf.length };
  } catch (e) {
    return { status: "corrupt", path: STATE, bytes: buf.length, error: e.message, buf };
  }
}

/** 损坏取证：内容相同的备份只留一份，绝不"修复"原文件。 */
function backupCorrupt(buf) {
  const dir = path.dirname(STATE);
  fs.mkdirSync(dir, { recursive: true });
  try {
    for (const f of fs.readdirSync(dir)) {
      if (!f.startsWith("state.json.corrupt-")) continue;
      try { if (fs.readFileSync(path.join(dir, f)).equals(buf)) return path.join(dir, f); } catch {}
    }
  } catch {}
  const p = path.join(dir, "state.json.corrupt-" + new Date().toISOString().replace(/[:.]/g, "-"));
  fs.writeFileSync(p, buf);
  return p;
}

/** 严格读取：缺失/空/损坏一律抛 BusError（5=未初始化，6=损坏），绝不返回空板。 */
export function readStateStrict() {
  const s = stateStatus();
  if (s.status === "ok") return s.state;
  if (s.status === "missing") throw new BusError(5, "未初始化：找不到 " + STATE + "\n先跑：node tools/bus-cli.mjs init   （或把 BUS_DIR 指到已有任务板）");
  if (s.status === "empty") throw new BusError(5, "state.json 是 0 字节（未初始化）：" + STATE + "\n先跑：node tools/bus-cli.mjs init --force");
  const backup = backupCorrupt(s.buf);
  throw new BusError(6, "state.json 解析失败，已拒绝操作（不做任何写入）；原文件未改动，坏内容备份在 " + backup + "\n" + STATE + "\n错误：" + s.error + "\n恢复：人工修好，或 init --force 重建（会丢现有任务）");
}

/** 宽松读取（仅 MCP resource 等展示场景；CLI 不要用）。 */
export function readState() {
  try { return readStateStrict(); } catch { return { ...EMPTY }; }
}

// 显式 BUS_DIR = 调用方点名了任务板位置（并发压测/临时板都用它）：
// 只有"缺失"才按显式意图建板；0 字节与损坏仍然拒绝（见 b4/b5 验收）。
function autoInitIfExplicit() {
  if (!process.env.BUS_DIR) return;
  if (stateStatus().status !== "missing") return;
  fs.mkdirSync(BUS_DIR, { recursive: true });
  saveState({ ...EMPTY });
  process.stderr.write("[bus] BUS_DIR 显式指定且未初始化，已按显式意图建板：" + STATE + "\n");
  appendEvent({ event: "init", reason: "explicit BUS_DIR" });
}

/** 写命令集合：只有它们允许把"显式 BUS_DIR + 空目录"解读为"建板"。只读命令永不落盘。 */
const WRITE_TOOLS = new Set([
  "bus_post_task", "bus_claim_task", "bus_progress", "bus_complete_task", "bus_note_write"
]);

/** 初始化：ok 且无 force → 什么都不做；corrupt 且无 force → 拒绝重建（exit 6，数据优先）；force → 备份后重建空板。 */
export function initState(force) {
  const s = stateStatus();
  if (s.status === "ok" && !force) return { created: false, path: STATE, tasks: s.state.tasks.length };
  // 数据优先：损坏的板可能是"有人手滑改坏"，绝不能因为再跑一次 init 就清空。
  // 重建必须显式 --force（先备份），或者人工把 JSON 修好。
  if (s.status === "corrupt" && !force) {
    const bak = backupCorrupt(s.buf);
    throw new BusError(6, "state.json 损坏，拒绝重建（会丢现有任务）：" + STATE +
      "\n原文件未改动，坏内容备份在 " + bak +
      "\n错误：" + (s.error || "未知") +
      "\n要重建请显式加 --force（先备份再清空），或人工修好后再 init。");
  }
  fs.mkdirSync(BUS_DIR, { recursive: true });
  if (s.status === "corrupt") backupCorrupt(s.buf);
  saveState({ ...EMPTY });
  appendEvent({ event: "init", forced: !!force, from: s.status });
  return { created: true, path: STATE, tasks: 0 };
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// 所有写操作前先做一次严格检查：未初始化/损坏时快速失败，且不留下任何文件。
async function withLock(fn) {
  const t0 = Date.now();
  for (;;) {
    try {
      const fd = fs.openSync(LOCK, "wx");
      try { return fn(); } finally { fs.closeSync(fd); try { fs.unlinkSync(LOCK); } catch {} }
    } catch (e) {
      if (e.code !== "EEXIST") throw e;
      if (Date.now() - t0 > 5000) { try { fs.unlinkSync(LOCK); } catch {} }
      await sleep(15);
    }
  }
}
function saveState(st) {
  const tmp = STATE + "." + process.pid + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(st, null, 2), "utf8");
  fs.renameSync(tmp, STATE);
}
export function appendEvent(ev) {
  try { fs.appendFileSync(EVENTS, JSON.stringify({ ts: new Date().toISOString(), ...ev }) + "\n", "utf8"); } catch {}
}
function nowIso() { return new Date().toISOString(); }

export const TOOLS = [
  {
    name: "bus_post_task",
    description: "投递一个任务到共享总线。返回任务 id（T-000123）。任何 agent 都可以投。",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string", description: "一句话任务标题" },
        body: { type: "string", description: "详细说明、验收标准、上下文文件路径" },
        agent: { type: "string", description: "投递者自称（如 dsh-lead / trae-ide）" },
        assignee: { type: "string", description: "指定执行者（可选，留空=谁都能领）" },
        priority: { type: "string", enum: ["low", "normal", "high", "urgent"], description: "优先级，默认 normal" },
        tags: { type: "array", items: { type: "string" }, description: "标签" },
        parent: { type: "string", description: "父任务 id（可选）" }
      },
      required: ["title"],
      additionalProperties: false
    }
  },
  {
    name: "bus_list_tasks",
    description: "列出任务。可按状态/执行者过滤，按优先级与创建时间排序。",
    inputSchema: {
      type: "object",
      properties: {
        status: { type: "string", description: "pending|claimed|in_progress|done|failed（逗号分隔可多选）" },
        assignee: { type: "string" },
        limit: { type: "number", description: "默认 20，最大 200" }
      },
      additionalProperties: false
    }
  },
  {
    name: "bus_claim_task",
    description: "领取任务（CAS 原子操作：只有 pending 且未被他人领取才能成功）。",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string" }, agent: { type: "string" } },
      required: ["id", "agent"],
      additionalProperties: false
    }
  },
  {
    name: "bus_progress",
    description: "给任务追加一条进度（不改变状态）。",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string" }, agent: { type: "string" }, note: { type: "string" } },
      required: ["id", "agent", "note"],
      additionalProperties: false
    }
  },
  {
    name: "bus_complete_task",
    description: "完成任务：写回结果与产出文件路径，状态改 done/failed。",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string" },
        agent: { type: "string" },
        result: { type: "string", description: "结论/摘要/改动说明" },
        artifacts: { type: "array", items: { type: "string" }, description: "产出文件绝对路径" },
        status: { type: "string", enum: ["done", "failed"], description: "默认 done" }
      },
      required: ["id", "agent", "result"],
      additionalProperties: false
    }
  },
  {
    name: "bus_note_write",
    description: "写一条共享笔记（键值对，同 key 覆盖，保留历史在 events.jsonl）。用于跨 agent 传递决策/结论。",
    inputSchema: {
      type: "object",
      properties: { key: { type: "string" }, text: { type: "string" }, agent: { type: "string" } },
      required: ["key", "text"],
      additionalProperties: false
    }
  },
  {
    name: "bus_note_read",
    description: "读共享笔记：给 key 读一条，不给 key 列全部。",
    inputSchema: {
      type: "object",
      properties: { key: { type: "string" } },
      additionalProperties: false
    }
  },
  {
    name: "bus_stats",
    description: "总线概览：各状态任务数、最近事件、锁/文件位置。",
    inputSchema: { type: "object", properties: {}, additionalProperties: false }
  }
];

function text(t) { return { content: [{ type: "text", text: typeof t === "string" ? t : JSON.stringify(t, null, 2) }] }; }
const PRIO = { urgent: 0, high: 1, normal: 2, low: 3 };

export async function callTool(name, args) {
  const a = args || {};
  // 只读工具永不落盘：显式 BUS_DIR 指到空目录时，读命令必须 exit 5（不能凭空建板）。
  if (WRITE_TOOLS.has(name)) autoInitIfExplicit();
  // 写/读前统一前置检查：未初始化 exit 5、损坏 exit 6，绝不建目录、绝不写。
  try { readStateStrict(); } catch (e) {
    if (e instanceof BusError) return { content: [{ type: "text", text: e.message }], isError: true, code: e.code };
    throw e;
  }
  try { return await dispatch(name, a); } catch (e) {
    if (e instanceof BusError) return { content: [{ type: "text", text: e.message }], isError: true, code: e.code };
    throw e;
  }
}

async function dispatch(name, a) {
  switch (name) {
    case "bus_post_task":
      return withLock(() => {
        const st = readStateStrict();
        const n = (st.tasks.at(-1)?.num || 0) + 1;
        const task = {
          id: "T-" + String(n).padStart(6, "0"),
          num: n,
          title: a.title,
          body: a.body || "",
          agent: a.agent || "unknown",
          assignee: a.assignee || null,
          accept: a.accept || "",
          priority: a.priority || "normal",
          tags: a.tags || [],
          parent: a.parent || null,
          status: "pending",
          created_at: nowIso(),
          updated_at: nowIso(),
          claimed_by: null,
          progress: [],
          result: null,
          artifacts: []
        };
        st.tasks.push(task);
        saveState(st);
        appendEvent({ event: "post", id: task.id, agent: task.agent, title: task.title });
        return text(task);
      });
    case "bus_list_tasks":
      return withLock(() => {
        const st = readStateStrict();
        const want = a.status ? String(a.status).split(",").map((s) => s.trim()).filter(Boolean) : null;
        let rows = st.tasks.filter((t) => (!want || want.includes(t.status)) && (!a.assignee || t.assignee === a.assignee || t.claimed_by === a.assignee));
        rows = rows.map(({ num, progress, ...rest }) => ({ ...rest, progress_count: (progress || []).length }));
        rows.sort((x, y) => (PRIO[x.priority] ?? 9) - (PRIO[y.priority] ?? 9) || x.created_at.localeCompare(y.created_at));
        const limit = Math.min(Number(a.limit) || 20, 200);
        return text({ total: rows.length, showing: Math.min(limit, rows.length), tasks: rows.slice(0, limit) });
      });
    case "bus_claim_task":
      return withLock(() => {
        const st = readStateStrict();
        const t = st.tasks.find((x) => x.id === a.id);
        if (!t) return { content: [{ type: "text", text: "task not found: " + a.id }], isError: true };
        if (t.assignee && t.assignee !== a.agent) return { content: [{ type: "text", text: "reserved for " + t.assignee }], isError: true };
        if (t.status !== "pending") return { content: [{ type: "text", text: "not claimable (status=" + t.status + ", by=" + (t.claimed_by || "-") + ")" }], isError: true };
        t.status = "claimed"; t.claimed_by = a.agent; t.updated_at = nowIso();
        t.progress.push({ ts: nowIso(), agent: a.agent, note: "claimed" });
        saveState(st); appendEvent({ event: "claim", id: t.id, agent: a.agent });
        return text(t);
      });
    case "bus_progress":
      return withLock(() => {
        const st = readStateStrict();
        const t = st.tasks.find((x) => x.id === a.id);
        if (!t) return { content: [{ type: "text", text: "task not found: " + a.id }], isError: true };
        if (t.claimed_by && t.claimed_by !== a.agent) return { content: [{ type: "text", text: "owned by " + t.claimed_by }], isError: true };
        t.status = t.status === "pending" ? "in_progress" : t.status;
        if (!t.claimed_by) t.claimed_by = a.agent;
        t.progress.push({ ts: nowIso(), agent: a.agent, note: a.note });
        t.updated_at = nowIso();
        saveState(st); appendEvent({ event: "progress", id: t.id, agent: a.agent, note: a.note });
        return text({ id: t.id, status: t.status, progress_count: t.progress.length });
      });
    case "bus_complete_task":
      return withLock(() => {
        const st = readStateStrict();
        const t = st.tasks.find((x) => x.id === a.id);
        if (!t) return { content: [{ type: "text", text: "task not found: " + a.id }], isError: true };
        if (t.claimed_by && t.claimed_by !== a.agent) return { content: [{ type: "text", text: "owned by " + t.claimed_by }], isError: true };
        t.status = a.status === "failed" ? "failed" : "done";
        t.claimed_by = t.claimed_by || a.agent;
        t.result = a.result; t.artifacts = a.artifacts || [];
        t.updated_at = nowIso();
        t.progress.push({ ts: nowIso(), agent: a.agent, note: "completed: " + t.status });
        saveState(st); appendEvent({ event: "complete", id: t.id, agent: a.agent, status: t.status });
        return text({ id: t.id, status: t.status, result: t.result });
      });
    case "bus_note_write":
      return withLock(() => {
        const st = readStateStrict();
        st.notes[a.key] = { key: a.key, text: a.text, agent: a.agent || "unknown", updated_at: nowIso() };
        saveState(st); appendEvent({ event: "note", key: a.key, agent: a.agent, chars: String(a.text).length });
        return text(st.notes[a.key]);
      });
    case "bus_note_read":
      return withLock(() => {
        const st = readStateStrict();
        if (a.key) return st.notes[a.key] ? text(st.notes[a.key]) : { content: [{ type: "text", text: "no such key: " + a.key }], isError: true };
        return text({ count: Object.keys(st.notes).length, notes: st.notes });
      });
    case "bus_stats": {
      const st = readStateStrict();
      const counts = {};
      for (const t of st.tasks) counts[t.status] = (counts[t.status] || 0) + 1;
      let lines = 0;
      try { lines = fs.readFileSync(EVENTS, "utf8").split("\n").filter(Boolean).length; } catch {}
      return text({
        bus_dir: BUS_DIR, state_file: STATE, events_file: EVENTS, events_lines: lines,
        tasks_total: st.tasks.length, by_status: counts,
        notes: Object.keys(st.notes).length,
        last_5: st.tasks.slice(-5).map((t) => ({ id: t.id, status: t.status, title: t.title }))
      });
    }
    default:
      return { content: [{ type: "text", text: "unknown tool: " + name }], isError: true };
  }
}
