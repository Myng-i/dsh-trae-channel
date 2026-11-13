# dsh-trae-channel

DSH ⇄ TRAE 的**零成本双通道协作**：`bus/` 任务板派活，`mailbox/` 信箱谈事。纯 Node（零依赖），跨 Windows / macOS / Linux。

- 不需要 TRAE 企业版（`traex` CLI 是付费墙，本方案绕开它）
- 不需要 MCP（需要时 `assets/mcp-bus-server.mjs` 提供 stdio / Streamable HTTP / legacy SSE）
- 不需要窗口自动化（不点鼠标、不依赖前台窗口）
- 后台叫醒走 CDP：**不移动鼠标、不抢焦点、窗口最小化也能投递**（2026-11-13 实测）
- 不会「悄悄停下」：`nudge` 按时间发现停滞的活并催办，催满转人工，而不是安静地烂尾

## 安装

```bash
node assets/init-workspace.mjs --root /path/to/workspace     # 幂等，已存在即 skip
cd /path/to/workspace
node tools/watchdog.mjs --init && node tools/watchdog.mjs --once --toast   # 可选：只读看门狗
node tools/selfwake.mjs status                                                  # 可选：自唤醒（默认 OFF，需用户要求才 enable）
node tools/selftest.mjs && node tools/mailbox-selftest.mjs    # 39/39 与 12/12 全绿才算就绪
node tools/wake-trae.mjs --init                               # 可选：建出站叫醒基线（派活后主动叫醒 TRAE）
node tools/wake-dsh.mjs status                                # 可选：反向叫醒检查（需 DSH 带 --remote-debugging-port=9223 启动）
```

作为 DSH skill 使用时，把本目录放到 `~/.dsh/skills/dsh-trae-channel/`。

## 两条通道

| | 任务板 `bus/` | 信箱 `mailbox/` |
|---|---|---|
| 装什么 | 可执行、有验收标准的事 | 要谈拢的方案与分歧 |
| 命令 | `bus-cli.mjs post/poll/claim/done` | `mailbox.mjs post/inbox/reply` |
| 真相 | `bus/state.json`（原子写 + 文件锁） | 只增不改的 `.md` 信件 |

判断口诀：**有验收标准 → 任务板；还在谈 → 信箱。**

## 回信是回信，唤醒是唤醒

`mailbox post` / `bus-cli done` 只落盘，不会叫醒对方。每轮收尾三步：写文件 → 更新任务 → 跑一次 `wake-dsh send --text "【TRAE 完工】T-000024 done，报告 docs/复核-xxx.md"`（只发 id + 一行标题）。`status` 不是 READY（DSH 未带 `--remote-debugging-port=9223`）就在信里写「未唤醒，请用户转达」。 **敲门 ≠ 已读**：凭据仍是任务 `done` 状态与文件。详见 `references/TRAE侧-接入卡.md`。

## 一条规则：单入口（内容只走文件，CDP 只发引用 id）

叫醒和投递是两条路：**内容只写在 `mailbox/` 或 `bus/`**（有 id、有游标、可追溯），CDP 注入的文本只允许「有新信 <id>，去读」这类引用式提醒。派活/发信时直接加 `--wake`（**先落盘、再敲门**）：

    node tools/mailbox.mjs post --from dsh-lead --to trae-ide --subject "…" --body-file b.md --wake
    node tools/bus-cli.mjs post --title "…" --accept "…" --to trae-ide --wake
    MAILBOX_WAKE_DRY=1 node tools/mailbox.mjs post … --wake   # 只打印将注入什么

不要用 `trae-inject send` 承载正文：2026-11-13 01:19 因此出现过「注入了、对方查信箱为空」。自发信/自己派给自己的任务不会触发敲门（方向过滤）。

## 退出码

`0` 成功 · `1` 业务失败 · `2` 参数错 · `4` 空正文 · `5` 未初始化（读命令不建板） · `6` state 损坏（拒绝写入）

## 已验证 / 未验证

已验证：见 [references/实测证据.md](references/实测证据.md)（含被否决路线与原因）。

未验证、不做承诺：`type:"sse"` 是否强制只走 SSE；跨操作系统混合（本方案在 Windows 实测，macOS/Linux 仅代码层面无平台依赖）。

## 协议与接入

- 协议：[references/邮政协议-v0.2.md](references/邮政协议-v0.2.md)（已冻结）
- 执行端接入：[references/TRAE侧-接入卡.md](references/TRAE侧-接入卡.md)

- `trae-inject.mjs` — 可选：CDP 后台叫醒（`send`/`read`/`status`），需 TRAE 带 `--remote-debugging-port` 启动（端口也支持自动发现）；叫醒本身用 `wake-trae`（见下）。
- `wake-trae.mjs` — 可选：**出站**叫醒。派完活跑一条，把「指派给对方的 pending 任务 + 新信」合成一条【DSH 叫醒】注入它的聊天框；成功才推进 `watch/traeWake.json`。`selfwake notify on`（默认）让「自唤醒 → 看门狗扫描 → wake-trae」成链；出站口只有这一个。
- `nudge.mjs` — 可选：**催办**。两边都没有后台守护，任务做到一半停下时没人发现；它按时间判停滞（默认 10min），给 `pending/claimed` 的活喂一条【DSH 催办】，同一项最多 3 次，催满就报「需人工介入」。只读任务板、不 claim、不改状态。注意 `selfwake enable` 会顺带开启自动催办（`notify off` 可关）；门铃账本读写两侧共享（wake-trae 读、nudge 写，2 分钟内不重复注入）；账本损坏时 `knock` 以 exit 6 拒绝敲门，原文件不动。
- `wake-dsh.mjs` — 可选：**反向**叫醒。TRAE 侧跑一条命令即可往 DSH 聊天框注入【TRAE 叫醒】并回车；端口没开 exit 3。

## 发布（字节可复现）

发布包由 `release/build-zip.mjs` 确定性生成：条目按路径排序、DOS 时间戳固定 1980-01-01、deflate 级别固定，因此**同样的输入必然得到逐字节相同的 zip**（同机两次构建、以及从 tag 重建，sha256 均相同）。

```bash
# 从 tag 重建（推荐：取 git blob，不受工作树换行影响）
node release/build-zip.mjs --ref v0.3.1 --out ../dist/dsh-trae-channel-v0.3.1.zip
# 从当前工作树构建（开发自查）
node release/build-zip.mjs --worktree --out ../dist/dev.zip
```

包内只放技能负载（`SKILL.md`、`README.md`、`LICENSE`、`.gitignore`、`assets/**`、`references/**`，共 22 个文件）；`.gitattributes` 与 `release/` 是仓库工具，**不入包**。仓库已设 `.gitattributes: * -text`，git 不做换行转换，避免「发布包 CRLF / tag blob LF」这类字节漂移。

### License

MIT — 见 [LICENSE](LICENSE)。随便用、随便改，保留版权与许可声明即可。
