# Claude Relay 部署和使用手册

目录
1. [准备](#1-准备)
2. [在 Cloudflare 建隧道](#2-在-cloudflare-建隧道)
3. [安装](#3-安装)（Windows / Linux / macOS）
4. [登录 Claude](#4-登录-claude)
5. [日常管理和更新](#5-日常管理和更新)
6. [配置文件](#6-配置文件)
7. [功能说明](#7-功能说明)
8. [安全设计](#8-安全设计)
9. [常见问题](#9-常见问题)
10. [换机器和备份](#10-换机器和备份)

---

## 1. 准备

本手册里出现的账号、域名、密钥，**全部是你自己的**：你用自己的 Claude 账号登录，在自己的 Cloudflare 账号里建隧道，用自己的域名。文中的 `example.com`、`claude.example.com` 只是示例，换成你的域名即可。部署出来的中转站完全独立，不连到本项目作者的任何账号或服务器。

| 需要 | 说明 |
|---|---|
| 一台常开的机器 | Windows 10/11、Ubuntu/Debian 服务器或 macOS。中转站跑在哪台机器上，Claude 的 Code 模式就在哪台机器上工作。 |
| 你的 Claude 账号 | 需要 Pro、Max 或 Team 订阅。在这台机器上登录 Claude Code（第 4 节）。 |
| Node.js 20+、Git | Windows：`winget install OpenJS.NodeJS.LTS` 和 `winget install Git.Git`；macOS：`brew install node git`；Linux 安装脚本会自动装 Node。 |
| 你的 Cloudflare 账号和域名 | 在 [cloudflare.com](https://dash.cloudflare.com/sign-up) 免费注册，把你的域名添加进去（按提示到域名注册商那里改 NS 服务器）。只在本机用可以不要。 |

**同一个域名同一时间只让一台机器运行。** 两台机器连着同一条隧道时，Cloudflare 会把请求随机分给两台，对话会时有时无。

## 2. 在 Cloudflare 建隧道

隧道让你的机器主动连到 Cloudflare，网页请求再从 Cloudflare 转回你的机器，所以不需要公网 IP，也不用在路由器上开端口。

1. 用你自己的账号登录 [Cloudflare 控制台](https://dash.cloudflare.com)，进入 **Zero Trust**（第一次进入需要选一个免费套餐和团队名）。
2. **Networks → Tunnels → Create a tunnel**，类型选 **Cloudflared**，名字随便起，比如 `claude-relay`。
3. 下一页「Install and run a connector」里有一条命令，形如 `cloudflared service install eyJhIjoi…`。**复制 `eyJ` 开头的那一长串**，这是隧道 token，等下安装脚本会问你。不用执行页面上的安装命令，安装脚本会自己运行 cloudflared。
4. 下一页添加 **Public hostname**（新版控制台叫 Published application routes），加两条：

   | Subdomain | Domain | Service |
   |---|---|---|
   | `claude` | 你的域名 | `HTTP` → `localhost:8787` |
   | `preview` | 你的域名 | `HTTP` → `localhost:8787` |

   子域名可以换成别的，安装时填对应的地址就行。Cloudflare 会自动建好 DNS 记录。

为什么要两个地址：Claude 做的网页、分享链接放在 `preview.` 上，和主站分开。这样网页里的脚本读不到主站的密钥，也调用不了主站的接口（和 claude.ai 把 Artifacts 放在独立域名上是同一个道理）。

token 泄露了：在隧道页面点 **Refresh / Rotate token**，把新 token 写进 `data/tunnel-token.txt`（Windows）或 `data/tunnel.env`（Linux / macOS，格式 `TUNNEL_TOKEN=eyJ…`），再重启隧道。

## 3. 安装

### 3.1 Windows

```powershell
cd $HOME\Documents
git clone <本仓库的地址> claude-relay     # 在本仓库 GitHub 页面点绿色的 Code 按钮复制；也可以 Download ZIP
cd claude-relay
powershell -ExecutionPolicy Bypass -File setup.ps1
```

`setup.ps1` 会依次：
1. 检查 Node.js，`npm ci` 安装依赖；
2. 下载 cloudflared 到 `bin\`；
3. 问你主站地址（如 `https://claude.example.com`）和预览地址（默认 `https://preview.example.com`），写进 `data\config.json`；
4. 问隧道 token，存到 `data\tunnel-token.txt`；
5. 打包「我的电脑」连接器（第 7.4 节，约 1 分钟）；
6. 注册计划任务 `ClaudeRelay`：登录时启动，之后每小时检查一次，没在运行就拉起来。运行时不会弹出窗口，**不需要管理员权限**；
7. 打印管理链接。

主站地址直接回车，就只在本机用：`http://localhost:8787/?k=…`。以后想上线，重新运行一次 `setup.ps1` 即可。

### 3.2 Linux 服务器

用一个普通用户 clone 代码，中转站就以这个用户身份运行：

```bash
git clone <本仓库的地址> claude-relay     # 在本仓库 GitHub 页面点绿色的 Code 按钮复制；也可以 Download ZIP
cd claude-relay
sudo bash linux/setup.sh
```

脚本会安装 Node 22、cloudflared、Claude Code，问地址和 token（token 存到 `data/tunnel.env`，权限 600），打包连接器，安装两个开机自启的 systemd 服务：`claude-relay`（网页）和 `claude-relay-tunnel`（隧道）。

然后用同一个用户登录 Claude：
```bash
claude        # 输入 /login。服务器上没有浏览器：把显示的链接复制到你自己的电脑上打开，授权后把代码粘回来，然后 /exit
```

### 3.3 macOS

```bash
brew install node cloudflared
git clone <本仓库的地址> claude-relay     # 在本仓库 GitHub 页面点绿色的 Code 按钮复制；也可以 Download ZIP
cd claude-relay
npm ci
node server.mjs        # 第一次运行会生成 data/config.json，看到链接后按 Ctrl+C
```

编辑 `data/config.json`，填上两个地址：
```json
"publicUrl": "https://claude.example.com",
"previewUrl": "https://preview.example.com",
```
把隧道 token 存起来，然后运行：
```bash
echo 'TUNNEL_TOKEN=eyJ...' > data/tunnel.env && chmod 600 data/tunnel.env
node connector/build.mjs     # 可选：启用「我的电脑」
./start.sh                   # 前台运行，终端窗口保持打开
```

想开机自启，可以用 launchd：把下面的内容存成 `~/Library/LaunchAgents/com.claude-relay.plist`（改掉两处路径），再运行 `launchctl load ~/Library/LaunchAgents/com.claude-relay.plist`。
```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.claude-relay</string>
  <key>ProgramArguments</key><array><string>/bin/bash</string><string>/Users/你/claude-relay/start.sh</string></array>
  <key>WorkingDirectory</key><string>/Users/你/claude-relay</string>
  <key>EnvironmentVariables</key><dict><key>PATH</key><string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string></dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
</dict></plist>
```

## 4. 登录 Claude

中转站用的是这台机器上 Claude Code 的登录状态。没登录过的话：
```bash
npx -y @anthropic-ai/claude-code
# 输入 /login，在浏览器里授权，完成后 /exit
```
登录凭据在 `~/.claude/` 里，不会进入本项目的任何文件。网页上提示「Not logged in」就是这一步没做。

## 5. 日常管理和更新

**Windows**
```powershell
Start-ScheduledTask ClaudeRelay                                    # 立即检查并拉起
Get-NetTCPConnection -LocalPort 8787 -State Listen                 # 是否在运行
Get-Content data\logs\server.log -Tail 20                          # 日志（还有 server.err.log、tunnel.err.log、watchdog.log）
Stop-Process -Id (Get-NetTCPConnection -LocalPort 8787 -State Listen).OwningProcess -Force; Start-ScheduledTask ClaudeRelay   # 重启
Unregister-ScheduledTask -TaskName ClaudeRelay -Confirm:$false     # 取消自启
```

**Linux**
```bash
systemctl status claude-relay claude-relay-tunnel
journalctl -u claude-relay -f
sudo systemctl restart claude-relay
```

**更新到新版本**
```bash
git pull
npm ci
node connector/build.mjs      # 连接器有改动时
```
然后重启服务。重启前最好确认没有正在回复的对话（重启会打断它）。

## 6. 配置文件

`data/config.json`，第一次启动时自动生成：

| 字段 | 说明 |
|---|---|
| `port` | 本地端口，默认 8787（也可以用环境变量 `RELAY_PORT`） |
| `adminKey` | 管理链接的密钥。删掉这一行再重启，会生成新的 |
| `accessKey` | 个人链接的密钥 |
| `workdir` | Claude 的工作目录，默认 `~/ClaudeRelay`。上传的文件、生成的文件、网页项目都在这里 |
| `publicUrl` | 主站地址（也可以用 `RELAY_PUBLIC_URL`）。没填时为 `http://localhost:8787` |
| `previewUrl` | 预览地址（也可以用 `RELAY_PREVIEW_URL`）。没填时为 `http://preview.localhost:8787`，浏览器会把 `*.localhost` 解析到本机 |

改完重启服务生效。

## 7. 功能说明

### 7.1 Chat 和 Code

在输入框下方切换，每个对话分别记住自己的模式。
- **Chat**：自定义的系统提示，风格接近 claude.ai；只开放网页搜索、网页读取、读上传的文件和技能，全部自动允许。
- **Code**：Claude Code 的完整智能体，工作目录是 `workdir`。权限模式可以选「每次询问」（在网页上点批准/拒绝）或「不再询问」。

技能：放在 `~/.claude/skills/` 下的技能会出现在 `/` 菜单里。

### 7.2 分享链接

对话顶部「分享」生成只读链接（放在预览域名上，形如 `https://preview.…/s/<随机码>`）。侧栏「分享管理」可以：
- 暂停 / 恢复、设置有效期（1 天、7 天、30 天、指定日期、永久）、看访问次数；
- 「更新内容」：用原对话的最新内容刷新快照，链接不变；
- 删除：链接永久作废；
- 粘贴**本机 Claude Code 的会话 ID**（`~/.claude/projects/*/<id>.jsonl`），把桌面版或命令行里的对话也分享出去。

分享的是快照。快照会去掉内部提示和工具细节，每段工具输出最多 3000 字；密钥、token、`sk-`/`ghp_`/JWT 这类字符串换成「[已隐藏]」，用户目录写成 `~`。分享前仍请自己看一遍内容。

### 7.3 访客子链接

「分享管理 → 访客子链接」里新建。每个访客：
- 只看到自己的对话；可以指定把你的哪些对话以只读方式共享给 TA；
- 有一个**周额度上限**（占你订阅周额度的百分比）。每轮回复的花费按 SDK 的 `total_cost_usd` 记账，再按「多少美元 = 1% 周额度」换算。这个比例默认 0.7，会根据你实际的周用量自动校准，也可以手动设；
- 默认只能用 Chat 模式，读文件限于 TA 自己上传的文件。工具权限由 PreToolUse 钩子逐次检查（不能只靠 `canUseTool`：Claude Code 读工作目录里的文件时不经过它）；
- 可以单独允许 **Code 模式**：TA 有一个专属文件夹 `workdir/guests/<id>`，文件工具限于这个文件夹；**命令不经确认直接执行，命令本身能访问整台机器**，所以只给信任的人；
- 可以停用、更换链接、删除（TA 的对话保留在你这里）。

### 7.4 我的电脑

让 Claude 操作另一台电脑（你自己的，或访客自己的）。Claude 仍在中转站上运行，那台电脑上只跑一个「连接器」：它主动用 WebSocket 连到中转站，不需要公网 IP、开端口、管理员权限，也不用装 Node、Claude 或 Tailscale。

**用法**：侧栏「我的电脑」→ 选 Mac / Windows →「生成配对命令」→ 在那台电脑的终端 / PowerShell 里粘贴运行 → 输入工作文件夹（直接回车用 `~/ClaudeWorkspace`）→ 网页显示「已连接」。之后在 Code 模式输入框旁边选这台电脑。

- 关掉连接器窗口就断开；重新连接用卡片上的命令（有新版本会自动更新，不用重新配对）。
- 工作文件夹可以在网页卡片上随时切换，也能一键切回「最近用过」的文件夹。
- **安全边界**：文件读写由连接器在那台电脑上检查，只能在工作文件夹内（会解析符号链接），服务器出问题也越不过去；命令默认每条在网页上确认，也可以设为「直接执行」；网页上「移除」后连接器立即退出并删除本地令牌。
- **前提**：中转站这台机器上运行过 `node connector/build.mjs`。它用 Bun（通过 npx 临时下载）交叉编译出 Mac（Apple 芯片 / Intel）和 Windows 程序到 `connector/dist/`，每个约 90–115 MB。程序没有代码签名：Mac 安装脚本会自动做本地签名并去掉隔离标记；Windows 安全中心可能提示，选「仍要运行」。

### 7.5 网页预览

Claude 做的网页按项目存在 `workdir/<项目名>/` 下，并通过 `preview_link` 工具生成预览链接（Chat 模式用 `save_web_page`）。回复里的 HTML 文件有「预览」按钮；侧栏「网页预览」列出所有网页项目。预览面板可以切换宽度，文件变了自动刷新。

### 7.6 生图（可选）

`extras/skills/image-gen` 是一个用 [Codex CLI](https://github.com/openai/codex) 的生图功能（ChatGPT 账号）画图的技能。想用的话：
```bash
npm i -g @openai/codex && codex login
# 把 extras/skills/image-gen 复制到 ~/.claude/skills/image-gen，然后重启中转站
```
装好后，Chat 和 Code 模式都会多一个生图工具，图片边画边显示在对话里。不装也不影响其他功能。

## 8. 安全设计

- 服务只监听 `127.0.0.1`，外部只能经 Cloudflare Tunnel 访问。
- 所有页面和接口都要 `?k=` 密钥（比较时用常数时间）；预览域名只提供预览文件和分享快照，没有 API、没有 WebSocket。
- 分享快照里只有文件编号，不含路径，只能下载登记过的文件。
- 访客 WebFetch 不能访问本机和内网地址。
- 设备令牌、配对码：服务器只存 SHA-256；配对码 10 分钟有效、只能用一次。
- `data/` 包含全部敏感数据，已在 `.gitignore` 里排除。**不要把 `data/` 推到公开仓库。** 如果你想用私有 Git 仓库备份，单独建一个私有仓库存 `data/`。

## 9. 常见问题

- **Windows PowerShell 运行 .ps1 报「字符串缺少终止符」**：PowerShell 5.1 会把不带 BOM 的 UTF-8 当成 ANSI。本项目的 .ps1 都只用英文；你自己改脚本时也别加中文。
- **网页提示 Not logged in**：这台机器上的 Claude 没登录，见第 4 节。
- **关掉 PowerShell 窗口后网站打不开**：`start.ps1` 是前台运行的；日常请用 `setup.ps1` 注册的计划任务。
- **对话时有时无**：大概率有两台机器连着同一条隧道。
- **上传大文件后对话卡住**：Cloudflare 会断开约 100 秒没有数据的 WebSocket。服务器每 25 秒发心跳，浏览器有确认和自动重发，刷新页面也会补发。如果仍然出现，看 `data/logs/`。
- **Mac 上连接器报 kqueue EINVAL**：旧版连接器的问题，在网页上重新生成配对命令运行一次即可更新。
- **「我的电脑」生成配对命令后下载 404**：中转站这台机器还没运行 `node connector/build.mjs`。
- **为什么不直接转发 claude.ai 网页的登录（sessionKey）**：那违反服务条款，还会被机器人检测拦截。本项目用官方 Agent SDK 驱动本机的 Claude Code。

## 10. 换机器和备份

中转站的状态都在三个地方：

| 位置 | 内容 |
|---|---|
| `data/` | 配置和密钥、对话记录、分享、访客、设备、隧道 token |
| `workdir`（默认 `~/ClaudeRelay`） | 上传的文件、生成的文件、网页项目 |
| `~/.claude/projects/<workdir 路径，非字母数字换成 ->/` | Claude 的会话上下文（继续聊、开分支需要） |

换机器：在新机器上装好本项目，**先停掉旧机器**，把这三处复制过去，然后启动。路径里的用户名变了也没关系：记录在 `...\ClaudeRelay\...` 下的文件会自动对应到新机器的 `workdir`。
