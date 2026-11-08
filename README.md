# Claude Relay

一个自己部署的、仿 claude.ai 的网页。网页上发的消息，由你电脑或服务器上**已登录的 Claude**（官方 [Claude Agent SDK](https://docs.claude.com/en/api/agent-sdk/overview)）处理，用的是你自己的 Claude 订阅。通过 Cloudflare Tunnel 发布到你自己的域名，手机、平板、任何浏览器都能用，不需要公网 IP，也不用开端口。

> **本仓库只有代码和部署教程，不提供任何现成的服务、账号或额度。** 你按教程部署出来的是**你自己的**中转站：用你自己的 Claude 账号、你自己的 Cloudflare 账号和你自己的域名，数据只存在你自己的机器上。

> 适合：想在手机上随时用自己电脑上的 Claude Code；想要一个带文件、网页预览、分享链接的 Claude 网页界面；想让自己的另一台电脑也能被 Claude 操作。

## 功能

- **Chat / Code 两种模式**
  - Chat：风格接近 claude.ai，只能搜索网页、读网页、读上传的文件、用技能，不会改动电脑。
  - Code：完整的 Claude Code 智能体，能执行命令、改文件；每一步可以在网页上批准或拒绝。
- **模型和思考强度切换**，思考过程实时显示；技能菜单（输入 `/`）。
- **上传文件和图片**；Word（.docx）自动转成文字和图片交给 Claude。
- **生成的文件**直接在回复下方预览、下载，也可以整个对话打包下载。
- **网页实时预览**：Claude 做的网页放在独立的预览域名上运行，改了自动刷新，可切换手机、平板宽度。
- **Mermaid 流程图**：自动画出来，可以全屏缩放、拖动、下载 SVG / PNG。
- **对话分支**：从任意一条回复开出新对话，带着之前的上下文。
- **划选引用回复**、对话内索引、草稿自动保存、断线自动重发。
- **额度面板**：订阅的 5 小时 / 每周用量。
- **分享链接**：把某个对话（或本机 Claude Code 的会话）做成只读链接；可以暂停、设有效期、看访问次数；密钥和用户目录会自动打码。
- **访客子链接**：给别人单独的链接，每人只看到自己的对话；可以限制 TA 最多用掉你多少周额度，指定共享给 TA 哪些对话；是否允许 Code 模式可以逐个设置。
- **我的电脑**：把另一台 Mac / Windows 连上来（一行命令），在 Code 模式里让 Claude 操作那台电脑。文件只能在你指定的工作文件夹里读写，命令默认逐条在网页上确认。

## 工作原理

```
手机 / 电脑浏览器 ──HTTPS──► Cloudflare（你的域名）
                                  │ Cloudflare Tunnel（从你的机器主动连出，无需公网 IP / 开端口）
                                  ▼
                      cloudflared ──► http://localhost:8787
                                         │
                           server.mjs（Node，只监听 127.0.0.1）
                             ├─ public/index.html   网页
                             ├─ /ws                 流式回复、权限确认
                             ├─ /api/*              对话、上传、额度、分享、访客、设备
                             └─ Claude Agent SDK ──► 本机已登录的 Claude
```

链接带一个随机密钥（`?k=…`），没有密钥的人打不开。

## 你需要准备（全部用你自己的）

1. **一台常开的电脑或服务器**：Windows 10/11、Linux（Ubuntu / Debian），或 macOS。
2. **你自己的 Claude 账号**，有 Pro / Max / Team 订阅，在这台机器上登录 Claude Code。
3. **你自己的 Cloudflare 账号**（免费即可），以及一个 DNS 托管在上面的**你自己的域名**。只想在本机用可以先跳过。
4. **Node.js 20 以上**和 **Git**。

部署过程中不会用到、也不会连到本项目作者的任何账号或服务器。

## 部署（约 15 分钟）

每一步的详细说明见 **[docs/GUIDE.md](docs/GUIDE.md)**。简要流程：

**第 1 步：下载代码**
```bash
git clone <本仓库的地址> claude-relay     # 在本仓库 GitHub 页面点绿色的 Code 按钮复制；也可以 Download ZIP
cd claude-relay
```

**第 2 步：在 Cloudflare 建一条隧道**（[GUIDE 第 2 节](docs/GUIDE.md#2-在-cloudflare-建隧道)）
- Cloudflare 控制台 → Zero Trust → Networks → Tunnels → Create a tunnel → Cloudflared，起个名字。
- 复制安装命令里那串 `eyJ…` 开头的 token。
- 加两个 Public hostname，都指向 `HTTP` `localhost:8787`：
  - `claude.你的域名`（主站）
  - `preview.你的域名`（网页预览和分享链接）

**第 3 步：运行安装脚本**，按提示填两个地址和 token
- Windows（PowerShell，不需要管理员）：
  ```powershell
  powershell -ExecutionPolicy Bypass -File setup.ps1
  ```
- Linux 服务器：
  ```bash
  sudo bash linux/setup.sh
  ```
- macOS：见 [GUIDE 第 3.3 节](docs/GUIDE.md#33-macos)。

**第 4 步：登录 Claude**（如果这台机器还没登录过）
```bash
npx -y @anthropic-ai/claude-code
# 进去后输入 /login，在浏览器里授权，完成后输入 /exit
```

**第 5 步：打开管理链接**
安装脚本最后会打印 `https://claude.你的域名/?k=…`。这就是你的**管理链接**，相当于密码，只留给自己；收藏到手机浏览器即可。

## 三种链接

| 链接 | 谁用 | 能做什么 |
|---|---|---|
| 管理链接 `?k=<adminKey>` | 你自己 | 看到全部对话；管理分享链接、访客、设备 |
| 个人链接 `?k=<accessKey>` | 你自己的其它设备（可选） | 只看到用它建的对话，没有管理功能 |
| 访客子链接 `?k=g…` | 你分享给的人 | 只看到 TA 自己的对话；额度上限、Code 模式由你设置 |

两个密钥都在 `data/config.json`，启动日志里也会打印。

## 安全须知

- `data/` 文件夹里有密钥、隧道 token 和全部对话，**不要提交到 Git**（`.gitignore` 已经排除）。
- 管理链接等于密码。泄露了就在「分享管理 → 访客子链接」里点「更换管理链接」。
- Code 模式能在运行中转站的机器上执行任意命令。给访客开 Code 模式，等于让 TA 使用这台机器，请只给信任的人。
- 访客子链接是可选功能：访客用的是你这个中转站背后的 Claude 账号额度。开给别人前请先了解 Anthropic 的[使用条款](https://www.anthropic.com/legal/consumer-terms)对账号使用的要求。
- 本项目通过官方 Agent SDK 调用本机的 Claude Code，不会抓取、转发 claude.ai 的网页登录凭据。

## 目录

| 路径 | 内容 |
|---|---|
| `server.mjs` | 服务端：HTTP、WebSocket、Agent SDK、上传、额度、分享、访客、设备 |
| `public/index.html` | 网页（单文件） |
| `lib/` | 分享、访客、设备、网页预览、docx 转换、zip 等模块 |
| `connector/` | 「我的电脑」连接器源码；`node connector/build.mjs` 打包成 Mac / Windows 程序 |
| `setup.ps1` `start.ps1` `watchdog.ps1` `install-autostart.ps1` | Windows 安装、前台运行、后台守护、开机自启 |
| `linux/` | Linux 安装脚本和 systemd 服务 |
| `start.sh` | macOS / Linux 前台运行 |
| `extras/skills/image-gen` | 可选：用 Codex CLI 生图的技能 |
| `docs/GUIDE.md` | 完整部署和使用手册 |

## 许可

[MIT](LICENSE)。本项目与 Anthropic 无关，"Claude" 是 Anthropic 的商标。
