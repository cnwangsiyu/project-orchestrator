# mini 值班台 · 第二步

只读：显示待确认事项、项目任务、机器/设备租约、额度、VAK 发布/回归和最近 12 小时事件。采集器每 30 秒生成快照，页面每 15 秒读取；浏览器不向其他站点请求数据。没有改派、归还设备、回答卡片或采样机器的按钮。`/history?at=<ISO>` 仍返回 404，历史回看留到第三步。

## Owner 安装（macOS）

从已合入或由 owner 确认的稳定 checkout 运行，要求 Node.js 22 和现有 `res`/`quota.mjs` 环境。不需要安装 npm 依赖。LaunchAgent 用普通用户运行，不放进系统 LaunchDaemons。以下命令只由 owner 执行：

```sh
BOARD="$HOME/.claude/orchestrator/_shared/board"
umask 077
mkdir -p "$BOARD" "$HOME/Library/LaunchAgents"
# 首次创建，已有口令不要覆盖（覆盖后须重启服务，所有旧 cookie 失效）。
if ! test -e "$BOARD/token"; then
  (set -C; openssl rand -hex 16 > "$BOARD/token") && chmod 600 "$BOARD/token"
fi
```

先在 loopback 验证：

```sh
node /ABS/CHECKOUT/scripts/board/collect.mjs --data "$BOARD"
node /ABS/CHECKOUT/scripts/board/serve.mjs --data "$BOARD" --token-file "$BOARD/token"
```

在本机浏览器手动打开 `http://127.0.0.1:8765/?k=<访问口令>`，确认跳转 `/` 后顶部显示采集时间。不要把完整首访地址粘贴到聊天、日志、截图、共享文档或 shell 历史。浏览器收到的 cookie 为 HttpOnly、SameSite=Lax；`/snapshot.json` 和 `/healthz` 也需要 cookie。请先退出上述前台服务再启用 LaunchAgent。

**内网直连只做 owner 的受控连通性验证**：`0.0.0.0` 是所有 IPv4 网卡，不等于“仅公司 LAN”。下面的例子是明文 HTTP，口令和 cookie 在网络上不加密；不要在不可信网络启用，不要做公网端口转发。可用时优先只绑定指定 LAN 地址，或保留 loopback 并使用 owner 管理的受限 HTTPS 入口；不要为本页关闭防火墙或放宽系统安全限制。若 LAN 不通，先恢复 loopback 并交由 owner 决定后续接入方式。

### LaunchAgent 示例

各写一个 plist 到 `~/Library/LaunchAgents/`。所有 `/ABS/...` 替换为本机绝对路径，`launchd` 不展开 `~` 或 `$HOME`。`PATH` 应包含已批准的本机 `res` 设备探测工具目录；不要新增凭据文件或环境变量。每个 `ProgramArguments` 数组只运行一个进程。

`local.mini-duty-board.collect.plist`：

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>local.mini-duty-board.collect</string>
  <key>ProgramArguments</key><array>
    <string>/ABS/NODE/bin/node</string><string>/ABS/CHECKOUT/scripts/board/collect.mjs</string>
    <string>--data</string><string>/ABS/HOME/.claude/orchestrator/_shared/board</string>
    <string>--loop</string><string>30</string>
  </array>
  <key>EnvironmentVariables</key><dict>
    <key>PATH</key><string>/ABS/NODE/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
  </dict>
  <key>RunAtLoad</key><true/><key>KeepAlive</key><true/><key>ThrottleInterval</key><integer>10</integer>
  <key>StandardErrorPath</key><string>/ABS/HOME/.claude/orchestrator/_shared/board/collect.err</string>
</dict></plist>
```

`local.mini-duty-board.serve.plist`（正式启用前按上面说明检查绑定地址）：

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>local.mini-duty-board.serve</string>
  <key>ProgramArguments</key><array>
    <string>/ABS/NODE/bin/node</string><string>/ABS/CHECKOUT/scripts/board/serve.mjs</string>
    <string>--host</string><string>0.0.0.0</string><string>--port</string><string>8765</string>
    <string>--data</string><string>/ABS/HOME/.claude/orchestrator/_shared/board</string>
    <string>--token-file</string><string>/ABS/HOME/.claude/orchestrator/_shared/board/token</string>
  </array>
  <key>RunAtLoad</key><true/><key>KeepAlive</key><true/><key>ThrottleInterval</key><integer>10</integer>
  <key>StandardErrorPath</key><string>/ABS/HOME/.claude/orchestrator/_shared/board/serve.err</string>
</dict></plist>
```

```sh
for job in collect serve; do
  plist="$HOME/Library/LaunchAgents/local.mini-duty-board.$job.plist"
  plutil -lint "$plist" && launchctl bootstrap "gui/$(id -u)" "$plist" || break
done
```

停止和卸载：先 `launchctl bootout "gui/$(id -u)/local.mini-duty-board.serve"`，再对 `local.mini-duty-board.collect` 执行同样操作。确认两个作业都已停止，再移除这两个 plist。保留共享目录和秘书的 `cards.ndjson`；快照、历史、服务日志和口令由 owner 按需要单独清理。

## 数据和维护

- `snapshot.json` 原子替换，`history/YYYY-MM-DD.ndjson` 按 UTC 日追加。启动和运行中每小时清理超过 48 小时的记录；磁盘上最多会暂留不到一小时的过期边界数据。只运行一个 collector。
- 每个来源最多等 10 秒；失败只让自己的 block 进入 stale，并保留该 block 上一份可用数据。页面在对应区块标出采集时间和原因，其他来源继续更新。
- 任务基本状态来自 `quota.mjs --running --json`；项目 `board.json`/任务 `brief.md` 补标题和下一步。`worker-events.jsonl` 提供最近三条进展、近 30 分钟失败任务、生命周期事件和未确认的 `queue-stalled` owner 通知；`route-log.jsonl` 提供路由理由以及改派事件。任务详情展示队列位置、等待时间、是否卡住、owner 通知、最近三条进展、路由理由和本地“复制给秘书”文本。
- `cards.ndjson` 由秘书维护。每张卡的最新事件为 `asked` 时就保持开放，超过 `defaultAt` 后仍显示并标为默认已经生效；`answered`/`withdrawn` 才关闭。开放卡显示项目、标题、提出时间、等待时长、默认动作和生效时间；没有开放卡时显示“没有等你的事”和折叠的最近回答三张。无法解析的行被忽略，并在 block 提示中计数。
- 机器实时读数优先来自调度与板面共用的 `_shared/host-samples/latest.json`。共享采样器每分钟维护它，host 键与 `res devbox-registry` 一致；成功样本不到 3 分钟时采用并标“共享采样”和年龄，`errorClass: "auth"` 标为“需要登录（Kerberos 票据过期）”。文件缺失或没有可用的新样本时回退到 runner 按任务申请写下的 `_shared/devbox-metrics/<host>.json` 和 `_shared/mini2-metrics.json`，并标“调度器样本”和年龄。board collector 只读，绝不写任何机器样本文件。
- `res devbox-registry` 把 registry host 映射到 `hosts.json` 简称；`res status`/`status devbox-cn` 提供本机、mini2、开发机和设备租约持有者；`res audit --json` 提供开发机核数、预计余量和租约数；各 `res pool-capacity` 提供申请容量、gate 和链路。调度器 stale-metrics gate 显示“申请时计算”，不当作故障；样本文件缺失/损坏、有租约且样本超过 6 小时、链路未就绪或 res 读取失败才标 amber。未提供负载时不拿租约数冒充 CPU 负载。
- VAK 当前 PPE 的版本、SCM build 和部署时间来自 `~/code/.claude-data/orchestrator/video-agent/ppe-state.json` 的 `mainPpe`。生产版本只显示同文件 `autoRelease.lastTransaction.prodVersion` 的最近事务观测值和 `updatedAt`；该记录没有可比的当前生产 build，因此 build 显示“未知”。现有状态也没有可靠的当天生产发布流水，所以“今天生产发布”显示“未知”，不从 PPE history 猜测。
- 上次 PPE 周期来自 `_shared/nightly/vak-ppe-release/cycle-events.jsonl` 的最新记录。上次夜间回归来自 `_shared/nightly/vak-web/runs/*/report.json` 中按 run 目录倒序找到的最新非空 `rows`：页面显示通过数/总数、结束时间和最多五个失败 job 名。其他项目没有可比较的状态文件，不显示伪造的发布数据。
- “最近发生的事”合并最近 12 小时、最多 40 条：`worker-events.jsonl` 的完成/失败/中断/明确改派、`route-log.jsonl` 的改派 fallback、相邻 `history/*.ndjson` 快照推导的额度用完/重置、`references/global-rules.md` 第二行版本及文件修改时间、VAK PPE history 发布，以及卡片提出/回答。列表按小时分组、新到旧排序，并跟随项目筛选。
- `hosts.json` 的键是 `res devbox-registry` 的稳定 registry slot 别名（每台机器挑一个），值是板上显示的简称。`local` 和 `mini2-exec-1` 单独用于两台 mini。增加机器时选一个不含地址、邮件或设备标识的 registry slot 别名，添加一个唯一的中文简称。不把原始 host、target 或 registry 描述写入快照。
- 验证：`node scripts/test/board-scenarios.mjs`；`scripts/test/run-all.mjs` 会自动发现该套件。
