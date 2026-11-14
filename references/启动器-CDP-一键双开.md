# 启动器：一键带 CDP 唤起 DSH + TRAE

> 跨平台说明：本启动器是 **Windows** 工具（进程枚举走 PowerShell CIM、双击入口是 .cmd）。
> macOS/Linux 上手动带 `--remote-debugging-port` 启动即可，其余脚本（任务板/信箱/注入）都是纯 Node。

## 为什么要启动器

CDP 注入（`wake-dsh.mjs` / `wake-trae.mjs` / `trae-inject.mjs`）要求应用**在启动时**就带
`--remote-debugging-port=<port>`——事后补不了，只能退出重开。启动器把「体检 → 需要时带端口启动 →
等端口/页面目标就绪 → 写状态文件」串成一步。

## 一键用法

```bat
start-cdp.cmd            :: 双击也行：没在跑就带端口启动（DSH 9223 / TRAE 9222），启动后自动验 CDP
start-cdp.cmd --check    :: 只体检，不启动（全就绪 exit 0）
start-cdp.cmd --dry      :: 只打印可执行文件、当前状态、将执行的命令
restart-cdp.cmd          :: 已开着但没端口：确认后关掉重开（会中断 DSH 会话，聊天记录在磁盘）
```

直接调 Node 也可以：

```bash
node tools/launch-cdp.mjs --only trae --check
node tools/launch-cdp.mjs --only dsh --restart --timeout 60
node tools/launch-cdp.mjs --dsh-port 9333 --trae-port 9332 --dsh-user-data-dir .tmp/udd
```

## 端口约定

| 应用 | 默认端口 | 身份判定（/json/version 的 UA） |
|---|---|---|
| DSH | 9223 | `/dsh-desktop|DeepSeek Harness/i` |
| TRAE | 9222 | `/TraeCN|Trae CN/i` |

端口号要和 `wake-dsh.mjs`（默认 9223）、`trae-inject.mjs`（默认读 `DevToolsActivePort` 再回 9222）一致。

## 找到可执行文件（按顺序）

1. 命令行 `--dsh-exe` / `--trae-exe`
2. 环境变量 `DSH_EXE` / `TRAE_EXE`
3. **`<工作区>/cdp/launch.config.json`**（推荐，`cdp/` 默认 gitignore，机器相关路径不进包）
   ```json
   { "dshExe": "D:/TOOL/deepseek-harness/DeepSeek Harness.exe",
     "traeExe": "D:/software/Trae CN/Trae CN.exe" }
   ```
4. 正在运行的进程路径（Windows）
5. 常见安装路径（`%LOCALAPPDATA%\Programs\…`、`%ProgramFiles%\…`）
6. `PATH`

都没有就 exit 4，并在输出里给出四条提示（参数 / 环境变量 / 配置文件 / 常见路径）。

## 三种状态怎么判

- **ready**：进程在跑、端口通、UA 对上 → 只体检，不重启
- **needs_restart**：进程在跑但没开端口（或端口被别的程序占）→ 默认**绝不杀进程**，exit 3；`--restart` 才关掉重开
- **not running**：带 `--remote-debugging-port` 启动并等到就绪

## 退出码

| 码 | 含义 |
|---|---|
| 0 | 就绪（或 `--check` 全就绪） |
| 2 | 参数错（未知参数、缺取值） |
| 3 | 在跑但没开 CDP / 端口被占；`--check` 下即「不可注入」 |
| 4 | 找不到可执行文件 |
| 5 | 启动后端口没在超时内就绪 |
| 6 | CDP 探针失败 |
| 7 | 端口被其它程序占用 |

## 加固点（都来自真实事故）

| 保险 | 做法 |
|---|---|
| 排空端口 | 关掉旧实例后 `waitPortFree(port, 8000)`，端口不释放就不 spawn。否则新实例 bind 失败会被 Electron 静默忽略（表现为「命令行明明带了端口，netstat 却没有」） |
| 限定杀进程 | 带 `--user-data-dir` 时只杀命令行含该路径的进程（正/反斜杠统一后比较），**不会误杀主实例** |
| 自动再试一次 | 应用起来了却没监听 → 杀掉这次拉起的、等端口、重开一次；进程根本没起来则不重试 |
| 就绪判据 | 不只看端口 open，还验 `/json/version` 的 UA 身份 + 至少一个 page target |

## 排错

- **端口没开**：先看是否被旧实例占着，再看应用是否崩溃后自己 relaunch；对比 `DevToolsActivePort` 的 mtime 与崩溃日志（`%APPDATA%\…\logs\crash-*.log`）。
- **探端口得到 502**：本机 `HTTP_PROXY` 把 127.0.0.1 也代理了；判断端口必须用直连 TCP（`node -e` 或启动器自己的探针），别信 `Invoke-WebRequest` 的 502。
- **中文乱码**：`.cmd` 里已 `chcp 65001`；旧控制台仍乱码就换 Windows Terminal。
- **必须清 `ELECTRON_RUN_AS_NODE`**：DSH 的 shell 环境带着它，Electron 会当 node 跑并报 `bad option`，两个 `.cmd` 已处理。

## 和叫醒链路的关系

```
start-cdp.cmd  →  DSH:9223 + TRAE:9222 就绪
                     ↓
watchdog / selfwake  →  wake-trae.mjs（注入【DSH 叫醒】）/ wake-dsh.mjs
                     ↓
              cdp/state.json 提供 pid / ws / targets
```

启动器只管「把端口打开并证明身份」，不负责注入；注入仍走 `trae-inject.mjs` / `wake-trae.mjs`。
状态文件是「最近一次成功启动记录」，**不代表进程当前存活**——判存活永远重新探端口。

## 实测（2026-11-14，Windows 11）

- 真机 `restart-cdp.cmd` → DSH 9223 就绪（pid 17808，0.4 s，target `dsh-app://app/`）+ TRAE 9222 已在跑（targets 2）
- 隔离 profile 启动：`--only dsh --dsh-user-data-dir <tmp> --dsh-port 9339` → 0.4 s 就绪，主实例不受影响
- 端口被占时：重试 1 次后 exit 5，文案区分「尝试 N 次 / 端口没释放 / 起来没监听」
- 两侧注入实测：`trae-inject send` 后 TRAE 回「注入链路通」；`wake-dsh send` 的文本出现在 DSH 对话里
