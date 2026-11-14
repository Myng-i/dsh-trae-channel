# TRAE 侧接入卡（5 分钟）

> 给 TRAE 的 agent 看。工作区 `<工作区>`。
> 设计假设：**你没有后台常驻能力**——所以全部按「一次一查」来用，不要长阻塞。

两条通道，各管一件事：

| 通道 | 用途 | 命令入口 |
|---|---|---|
| 信箱 `mailbox/` | 谈方案、定口径、交接背景（**不执行**） | `tools/mailbox.mjs` |
| 任务板 `bus/` | 可执行、可验收的任务 | `tools/bus-cli.mjs` |

## 0. 先确认 node

```bat
node -v
```

没输出/报错就用绝对路径（本机已知可用）：

```bat
"<node 可执行文件路径>" -v
```

下文命令里的 `node` 都替换成这个路径即可。

> **单入口**：正文只在 `mailbox/` 与 `bus/`；你收到的 CDP 文本只是「有新信 <id>」的提醒，必须回文件里读。
> 你回信时同理：`mailbox post --wake` 先落盘再叫我，别只在聊天框里说。

## 1. 每轮开场两条命令（推荐节奏）

```bat
node tools/bus-cli.mjs poll --as trae-ide --claim --json
node tools/mailbox.mjs inbox --as trae-ide --advance
```

- `--advance` 走游标 `mailbox/.cursor-trae-ide`：列完自动写回最大 id，**不用手填上一次的 id**；首次无游标时全量列一次并提示
- 也可显式给起点：`--after <id>`；只看最近几封：`--limit 3`
- **子代理读信只用 `--after`，不要用 `--advance`**：游标 `.cursor-<agent>` 只允许主会话推进，多写者会互相踩。
- 空轮不推进游标（本轮没新信时游标不动），因此不会「漏过」任何信。
- `poll` 有活返回任务 JSON 并已领；没活：`{"task":null,"reason":"no_task"}`，**exit 0**（空转不算失败）
- 读某封：`node tools/mailbox.mjs read <id>`；回信：`node tools/mailbox.mjs reply <id> --from trae-ide --body-file reply.md`

### 1.1 命令必须指向「对方那一份」目录（v0.3.11 起叫醒文案已给绝对路径，v0.3.12 起读命令不建目录）

上面两条默认按**你当前目录**找 `bus/` 与 `mailbox/`。如果你的 cwd 不是派活方的工作区，就必须显式传目录，否则会读到**你自己 cwd 下的另一块板/另一个信箱**，表现就是「对方说发了信，你说没有」。

```bat
node "<工作区>/tools/bus-cli.mjs" poll  --as trae-ide --claim --bus "<工作区>/bus"
node "<工作区>/tools/mailbox.mjs" inbox --as trae-ide --advance --dir "<工作区>/mailbox"
```

- 被 CDP 叫醒时，**文案里写的绝对路径就是权威**，照抄执行即可；别改回相对路径。
- `--bus <dir>`：解析参数前 re-exec 一次把 `BUS_DIR` 注入子进程（环境已指向同一块板时只剥掉参数）；`--dir <dir>`：覆盖 `MAILBOX_DIR`，再退到 `<cwd>/mailbox`。
- 真实事故（2026-11-14）：叫醒文案只写 `inbox --advance`，TRAE 在自己 cwd 下跑，读到了 DSH-TRAE 工作区的信箱，回「没有这封」。
- 读命令（`inbox` / `read` / `threads` / `knock`）与 `reply` 遇到不存在的信箱一律 **exit 5** 并打印路径与 `--dir` 示例，**不会就地建空信箱**——所以「exit 5」几乎总是意味着你 cwd 不对或 `--dir` 指错了，不是「没有信」。

## 2. 短轮询（仅在你愿意让这一轮最多等 30s 时）

```bat
node tools/bus-cli.mjs wait --as trae-ide --claim --json --timeout 30
```

- 默认空转 **exit 0**；只有 `--strict` 才 exit 1
- 不要用 `--timeout 300`：会占住你整轮，这是已知代价，我们不这么用
- **优先 `poll`**：进程内轮询不吃上下文

## 2.5 任务板首次使用（重要）

任务板**不会**在空目录里自动出现；以下情况一律 exit 5 并拒绝写入：

```bat
node tools/bus-cli.mjs init      # 只在确认这是新板时跑；已有 state.json 时无事发生
node tools/bus-cli.mjs board     # 未初始化 -> exit 5；损坏 -> exit 6（已备份 state.json.corrupt-<ts>）
```

- 在错的 cwd 跑 `post`/`board` 现在会**报错**（以前会静默建一块空板，让你以为板是空的）；
- **只读命令永不落盘**：`board`/`list`/`show`/`poll`/`stats` 在「显式 BUS_DIR + 空目录」时也是 exit 5，不会凭空建板（路径拼错立刻暴露）；
- 显式 `BUS_DIR` 指向某目录且其中无 state.json 时：**写命令**（post/claim/progress/done/fail/note write）按显式意图建板（stderr 有一行提示），**读命令不建**；
- D3 前置：`post` 缺「验收标准」或「产出路径」时 **只打 stderr 警告、exit 0**（不阻断派活），但会点名缺哪一项；补上就不吵。
- ⚠ 身份参数别混：**任务板用 `--as`**（自己的名字），**信箱用 `--from`**（发件人）；bus-cli 不认 `--from`，mailbox 不认 `--as`。
- 退出码：`5` 未初始化 / 0 字节；`6` state.json 损坏（拒绝写入）；`2` 参数错误（含 `to`/`assignee` 冲突）。

## 3. 领活之后

```bat
node tools/bus-cli.mjs progress T-000123 --as trae-ide --note "改到一半，测试中"
node tools/bus-cli.mjs done T-000123 --as trae-ide --result "改了 a.ts/b.ts，npm test 通过" --artifact src/a.ts
node tools/bus-cli.mjs fail T-000123 --as trae-ide --result "卡在权限，需要 dsh 给 token"
```

## 4. 投任务/发信给 DSH

中文引号、长正文别跟命令行搏斗，**一律走文件或 stdin**：

> D3 前置：`post` 缺「验收标准」/「产出路径」只打**警告 + exit 0**（不阻断），但会点名缺哪项。

```bat
node tools/bus-cli.mjs post --stdin --as trae-ide < task.json
node tools/mailbox.mjs post --from trae-ide --to dsh-lead --subject "..." --thread design-comm --body-file letter.md
```

`task.json`：

```json
{
  "title": "需要 DSH 决策：接口超时改 3s 还是 5s",
  "body": "现状 5s，压测 P99 4.2s；建议 3s 但会影响批量导入",
  "to": "dsh-lead",
  "accept": "改完跑 npm test 全绿，产出 src/config.ts",
  "priority": "high"
}
```

> 2026-11-12 起：`mailbox.mjs post` 支持 `--body-file`；正文为空会 **exit 4 拒绝写入**（以前会静默写出空信，别再踩）。id 由 `wx` 独占创建，并发发信不会互相覆盖。

## 5. 编码（中文乱码的唯一常见原因）

- PowerShell 5.1：先 `chcp 65001`，或改用 `cmd.exe`；
- 任何情况下 `--json` 输出都更适合被程序读；
- 写文件用 UTF-8（无 BOM），两个 CLI 都会吃掉 BOM。

## 6. 谁来驱动你（三选一，都不需要常驻）

| 方式 | 做法 |
|---|---|
| 用户触发（推荐） | 每轮开头跑第 1 节两条命令，没活就结束 |
| 计划任务 | `schtasks /create /tn dsh-bus-poll /tr "node <工作区>\tools\bus-cli.mjs poll --as trae-ide --claim --bus <工作区>\bus" /sc minute /mo 5` |
| DSH 侧驱动 | 由 DSH 或 cron 调，TRAE 只在被需要时响应 |

## 7. 约定（避免互相踩）

- 一次只领一个任务；领了就交，交不了就 `fail` 写清卡点；
- **信里说「请执行 X」不算派活**，必须以 bus task 为准；
- 不删别人的任务，不改 `bus/state.json`（CLI 有文件锁，手改会绕开锁）；
- 有疑问写 `note`，别在任务体里堆长讨论：

```bat
node tools/bus-cli.mjs note write --key decision-timeout --text "定 3s，批量导入单独加开关" --as dsh-lead
node tools/bus-cli.mjs note read --key decision-timeout
```

## 8. 自检（只读，不碰真实任务板）

```bat
node tools/selftest.mjs            :: 41 项：init/CAS/严格状态/MCP 三传输/只读不落盘/损坏拒绝/熔断/drill 阈值/CDP 端口/安装器/出站与反向叫醒
node tools/mailbox-selftest.mjs    :: 15 项：空正文、并发 id、游标、--after、Re: 去重、--wake 干跑、自发信不敲门等
```

全 PASS 说明本机链路完整；有 FAIL 把输出原样贴回给 DSH。

## 9. 本轮不做的事（双方已定）

- **不接 MCP**：CLI 已闭环（自检全绿、单次约 120ms），stdio 只是同一份 state.json 的另一入口，不增能力却多一层配置面。需要「不经过 shell 的工具直连」时再单开 bus task，届时 stdio + `mcpServers` + `command/args/env`，不起 HTTP 端口。

## 10. 待修（已确认，修好前按此规避）

### 10.1 回声唤醒：自发回信被当成新件

- 现象：2026-11-12 23:31 的 `20261112-2331-001`（`from: trae-ide`、`to: dsh-lead`，就是本端刚发的复验回信）触发了新一轮叫醒。
- 根因（DSH 侧，不在 mailbox/bus 代码里）：唤醒扫描只按「有新文件/新 id」判断，**不区分收发方向**，把本端去信计成了新到件。
- 最小改法（二选一）：
  1. 过滤条件收紧为 `to ∈ {trae-ide, all}` **且** `from != trae-ide`；
  2. 或按方向分目录（`inbox/`、`outbox/`），扫描只看 `inbox/`。
- 规避：修好前，TRAE 侧不对这封信回信；发现叫醒源是本端发出的 id 时，直接忽略、不发新件，避免「回信 → 唤醒 → 回信」循环。
- 建议附带：唤醒日志里打印命中信件的 `from/to/id`，便于一眼认出回声。
- **复发记录（2026-11-13 00:3x）**：回声再次发生，一次命中三封本端去信（`20261113-0001-001`、`0004-001`、`0012-001`，全部 `from: trae-ide`）。说明上轮修的 `from != trae-ide` 只覆盖了 `wake-trae` 那条链路，**DSH 侧入站扫描这条路径没有生效**。
- 处理口径：两边统一用同一套判定 —— `to ∈ {trae-ide, all}` **且** `from != trae-ide`；唤醒文案/日志打印 `from/to`。在确认 DSH 入站扫描也过滤前，收到「本端去信 id」触发的叫醒一律忽略、不回信。

### 10.2 `mailbox.mjs` 没有 `show` 子命令

- 实测：`node tools/mailbox.mjs show` → **exit 2**，`usage: mailbox.mjs post|inbox|read|reply|threads|index`。
- 现状：接入卡、SKILL.md、references 里均未出现 `mailbox.mjs show`，**没有误写**；按 id 看单封用 `read <id>`，按线程用 `threads` + `read`。
- 若后续要加 `show`（对齐 `bus-cli show`），需同时更新 usage、SKILL.md 与自检。

### 10.3 本文档第 8 节自检条目数已过期

- 第 8 节写 `selftest 12 项`、`mailbox-selftest 6 项`；**当前实际为 41/41 与 15/15**（含自唤醒熔断、drill 隔离、游标语义、`Re:` 去重、安装器产出、出站叫醒等）。已于 2026-11-13 校齐。

### 10.4 唤醒对「已通知过的 id」没有去重（2026-11-13 01:4x 观测）

- 现象：主会话两次叫醒分别命中 `20261113-0124-001` 与 `20261113-0126-001`，**这两封我已读过、也已在 `20261113-0128-001` 回过信**，仍被当成新件再次通知。
- 与 10.1 的回声不同，也**不是**幽灵 id：幽灵 id 是「通知了不存在的件」，本条是「通知了已经通知过的件」。两者合起来意味着：**被叫醒 ≠ 有新件待处理**。
- 建议：去重放在唤醒/`watch` 侧——把已通知 id 集合落在本地状态文件（如 `watch/notified.json`），每轮只对不在集合里的 id 叫醒并追加；不要靠每轮全量扫。
- 规避（修好前）：收到叫醒先按 id 与自己发出的回信列表比对，命中本人的去信或已回过的 id 直接忽略，不重复回信（回信本身会再生成一封去信，扩大噪音）。
- **2026-11-13 01:5x 反例（出口修好之后仍复发）**：叫醒命中 `20261113-0132-001` 与 `20261113-0152-001`，两封分别已在 `20261113-0134-001`、`20261113-0155-001` 回过信，仍被再次通知。
- 原因：`watch/knock-notified.json` 是**本端出口账本**（我往外敲时记「敲过谁」），而这次叫醒来自外部注入，走对方入站扫描，本端 ledger 不在那条链路上 → 第 ④ 条只修了出口、**没修入口**，两套账本的问题由此实证。
- 可执行结论：**去重必须落在「收到即记」的那一侧（DSH 侧入站扫描）**；本端账本只能防自己重复敲，防不住被别人重复叫。

### 10.5 唤醒相关待修清单（四条并列，别漏）

1. `knockTrae()` 无 `from`/`to` 方向过滤 → 自发信加 `--wake` 也会敲（自叫醒）。**已修（75a2ec3）**
2. knock 文案里的 id 取自临时 `MAILBOX_DIR` → 会对外宣告「幽灵 id」（真实信箱并无该件）。**已修（69fa30b：隔离目录默认不敲 + `knock <id>` 存在性校验）**
3. 单入口规则未进 `README.md`（只在 `SKILL.md:192` 与本文档第 4 行）。**已修（README:34）**
4. 唤醒对已通知 id 无去重 → 已读、已回的信可再次触发叫醒（见 10.4）。**出口已修（`watch/knock-notified.json`）、入口未修**：本端 ledger 只防自己重复敲，01:5x 仍被 `0132-001`/`0152-001` 重复叫醒

## 11. 反向叫醒（TRAE → DSH）：注入通道已验证

### 11.1 已实测（2026-11-13 00:2x）

- `node tools/wake-dsh.mjs status` → `READY cdp=9223ok targets=1 input=div [发消息或创建任务, / 调用指令, @ 文件或对] rect=710x36 85ms`，**exit 0**，耗时 85ms。
- `node tools/wake-dsh.mjs send --text-file <临时文件>` → `[wake-dsh] 已注入 63 字符并回车 → target=DSH-TRAE跨平台通信链路验证 — DeepSeek Harness`，**exit 0**，整条 **330ms**。
- **用户在 DSH 窗口亲眼确认消息出现**；**DSH 侧在 00:08 收到那条 `【TRAE 叫醒·冒烟】` 并据此起了一轮对话**（`20261113-0010-001` 中自述），端到端闭环成立。
- 结论：**TRAE → DSH 的 CDP 注入通道可用，且对方确实会因此被叫醒**。

### 11.2 焦点与干扰：鼠标/前台已否，键盘焦点未验

- **鼠标未被移动/抢占（用户已确认）**：另做过一次受控采样，注入全程（120 次 × 15ms ≈ 1.8s）鼠标坐标恒为 `1776,519`，没有一次变化。注入走的是页面内 JS，不产生系统级鼠标事件。
- **没有抢前台窗口**：故意让 DSH 不在前台（当时前台是 `Agent [管理员]`），注入前后前台窗口均为 `Agent [管理员]`，未切换。
- **键盘焦点是否被抢：未验证**——鼠标不动、前台不变都不等于键盘焦点没变（输入法状态、页面内 focus 均未测），不要把这条和上面两条混为一谈。
- **输入框是否残留文本**：`probe` 只返回 target 列表，读不到输入框内容，**该点未验证**。
- **DSH 是否会处理那条消息：已确认**——`20261113-0010-001` 里 DSH 自述「你那条 `【TRAE 叫醒·冒烟】` 我在 00:08 收到了，而且它真的起了一轮对话」，反向通道端到端成立。注意：确认的是「会被叫醒」，不代表每次注入都必然被处理（端口关闭时注入直接 exit 3，不会有任何投递）。

### 11.3 前提与风险

- 前提：DSH 必须以 `"DeepSeek Harness.exe" --remote-debugging-port=9223` 启动；不带该参数时 `status`/`send` 返回 **exit 3** 并打印重启命令（不是 bug）。
- 风险：端口开着期间，**本机任意进程都能无认证连 CDP、往 DSH 输入框打字并回车**（等同本机可信）。
- 只适合临时验证；用完**重启 DSH 且不带该参数**即关闭端口。
- 操作提醒：PowerShell 里路径带空格/引号时必须用调用运算符 `&`，例如 `& "<DSH 可执行文件路径>\DeepSeek Harness.exe" --remote-debugging-port=9223`（`wake-dsh.mjs status` 探测不到时也只打印占位符，不会打印你机器上的真实路径），否则会报 ParserError。

### 11.4 已启用（2026-11-14 拍板）：每轮末尾必须调一次 wake-dsh

- 背景：DSH 是「用户发话才有 turn」的形态，bus/mailbox 只是文件，TRAE 发 done 后 DSH 不会自动醒来。用户 2026-11-14 22:20 指出这是缺口（m00442）。
- 现状：DSH 桌面端当前**已带** `--remote-debugging-port=9223` 启动（`wake-dsh status` → `READY cdp=9223ok`，exit 0）。
- **硬要求**：TRAE 每轮交付（`bus-cli done` 或 `mailbox reply`）之后、结束本轮之前，必须执行一条：

  ```
  node tools/wake-dsh.mjs send --text-file <临时文件>
  ```

  临时文件内容一行即可，例如：`【TRAE 回信】T-000002 DONE：三条全关闭，0 新问题。`（用 `--text-file` 而不是 `--text`，中文/长文本更稳）
- 判据：exit 0 + 打印「已注入 N 字符并回车」才算唤醒成功；exit 3 = 9223 没开，须在回信里写明「未唤醒 DSH（端口不通）」，不许假装叫过。
- 不这么做，DSH 侧只能等用户手动转发——这正是上一轮的卡点。

## 12. 硬规则：动本机技能目录必须用户逐次确认

- 范围：`~/.dsh/skills/` 下的一切写入——安装、覆盖、解压替换、把临时目录并回规范目录、删目录后重建。
- 规则：**每次动作单独取得用户确认后才能执行**。以下都不构成该次授权：
  - 「用户同意发版」不等于「同意安装」；
  - 「Release/asset 已发布」不等于「可以装到本机」；
  - 「上一轮同意过同类动作」不等于「本轮也同意」。
- 发布（tag / Release / asset）与安装是**两个独立动作**，要分别确认；同理，并回与解压覆盖也各自算一次。
- 未获确认时只做只读核查（列清单、比哈希、解包到临时目录跑自检），不写入目标目录。
- 授权状态（2026-11-13）：用户已在本会话直接确认「发布」与「安装」两项授权；确认渠道是用户直接对话，不是文件哈希或第三方凭据。该历史授权只覆盖已发生的动作，之后的安装/替换仍按本节逐次确认。

## 13. 授权与转述规约（2026-11-13 定）

适用于任何会改动 `~/.dsh/skills/` 或发布物（tag / Release / asset / 并回）的动作。

1. 授权只认**原始文本 + 逐字落盘**。落盘件必须附：id、时间（带时区）、来源。**改写、摘要、合并多句，一律不算授权。**
2. **转述只能进「待确认」队列**，不得作为执行依据；待确认项不得被后续回合自动升级为已授权。
3. 授权**绑定具体版本 + 具体动作**（例：「安装 v0.3.2 到本机技能目录」）。不得复用到下一版，不得外推到打包、推送、并回。
4. 缺失或冲突时默认**未授权**，不做善意推定。
5. 授权件一旦落盘即**只读**：不补标点、不「顺手修正」。

## 14. 转述格式与用户落盘通道

### 14.1 `[authz-pending]` 的固定字段

转述进「待确认」队列时用这个格式，缺字段的转述直接丢回重发：

```
[authz-pending] <用户据称授权了什么>
- 原话：「<逐字引用，不改写、不省略限定词>」
- 时间：<YYYY-MM-DDThh:mm:ss+08:00>
- id：<落盘件 / 信件 id；§13 第 1 条要求的三件套之一，缺了不算完整转述>
- 来源：<会话编号 mNNNNN / 平台+时间>
- 说话方：用户本人 / 中间转述者
- 拟执行动作：<具体版本 + 动作 + 路径 + 备份 + 校验>
- 状态：待确认（原话落盘后仍需用户/接收方明确确认，不自动生效）
```

字段与 §13 第 1、3 条一一对应：`id / 时间 / 来源` 是三件套（缺一不可）；`状态` 那一行是显式拒绝被当成授权的标记，不得省略，且**不得写成「落盘即生效」**——落盘只是取得原文，生效仍要接收方或用户明确确认。

### 14.2 用户原话怎么真正落地

1. 用户在协作方的对话里直接说；
2. 用户本人把原话写进工作区 `mailbox/USER-AUTHZ.md`（该文件只有用户可编辑，双方都不得写入或改写；落盘后只读，增补走新条目）。模板已预置 `id / 时间 / 来源` 三个头部字段，用户只填正文，避免落盘件天生缺字段；
3. 双方都可在 `docs/用户授权转述规约-*.md` 记录历史，但那是记录，不是授权件。

### 14.3 冲突处理

同一动作出现两份互相矛盾的用户原话时，取**时间较晚且带完整字段**的那份，并把冲突写进信件；仍无法判定则默认未授权，等用户裁决。
