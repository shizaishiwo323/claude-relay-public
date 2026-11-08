---
name: image-gen
description: 生成或编辑图片：插画、海报、封面、配图、壁纸、图标、Logo 草图、照片风格图、概念图、头像、表情包、产品图、背景图、给上传的图片换风格或修改等。只要用户要一张"图"（画一张、生成图片、做个海报、出几张配图、帮我设计个封面、把这张图改成…、P 图、来张壁纸），就自动使用本技能，不需要用户提到技能名或 Codex。它调用本机 Codex 的图像生成功能（ChatGPT 账号）。Claude 自己不能直接输出位图，所以凡是需要真实图像的请求都用它；只要图表、流程图、SVG 矢量或数据可视化时不用（用 Mermaid、代码绘图或 nature-figure）。
---

# image-gen：生成图片

Claude 不能直接输出位图。本技能调用本机 Codex CLI 的图像生成工具（模型优先用 `gpt-6.1-sol`，不可用时自动换），图片保存到 `outputs/images/`。

**用户在对话里要图时，直接生成，不要先问"要不要用生图技能"，也不要说自己不能画图。** 只有关键信息完全缺失、且无法合理假设时才先问一句（比如"给我画张图"但没说画什么）。

## 怎么调用（按可用性选一种）

1. **有 `generate_image` 工具时（Claude Relay 网站的 Chat / Code 模式都有）**：直接调用它。网页上会实时显示进度卡片（启动 → 生成中，计时 → 已生成第 k 张 → 保存 → 完成），完成后图片自动出现在回复下方。
2. **否则用 Bash 跑脚本**：
   ```bash
   node ~/.claude/skills/image-gen/scripts/image_gen.mjs --prompt "<提示词>" --aspect landscape --name <英文短名> --out "<工作目录>/outputs/images"
   ```
   参数：`--aspect square|landscape|portrait|16:9|4:3|3:4…`、`--n 1-4`（变体数量）、`--ref 图片路径`（可重复，参考图或要编辑的图）、`--model`、`--timeout 秒`。提示词很长时用 `--prompt-file 文件`。
   进度会一行行打印到 stderr（`[image-gen] 12s 正在生成图片`）；stdout 最后输出一行 JSON：`{"ok":true,"files":[...]}` 或 `{"ok":false,"error":"..."}`。一张图通常 20–60 秒，多张图时间成倍增加。开始前告诉用户大约要等多久。

## 写提示词

- 把用户的想法扩写成具体画面：主体、构图、风格（扁平插画/写实摄影/水彩/3D/像素…）、色调、光线、视角、背景、情绪。不要只转发一句话。
- 用户要的文字（标题、标语）原样写进提示词并加引号。中文也可以，Codex 能准确渲染中文。
- 比例看用途：手机壁纸和竖版海报用 `portrait`，横幅、封面、PPT 用 `landscape`，头像和图标用 `square`。
- 编辑或参考已有图片：用 `--ref`（或工具的 `reference_images`）传入路径，在提示词里写清"保留什么、改什么"。用户在网站上传的图片，路径在消息里给出。
- 用户想多看几个方向时 `n` 设 2–4。

## 生成之后

1. 用 Read 打开生成的图片看一眼，确认是否符合要求：文字对不对、主体对不对、有没有明显瑕疵。不符合就改提示词重来一次，并告诉用户改了什么。
2. 回复里简单说明画了什么、用了什么比例和风格。在 Claude Relay 网站上图片会自动出现在回复下方，不用让用户去找路径；在别处给出文件路径。
3. 不要说"我画了"却没有文件。生成失败要如实说明原因（见下）。

## 常见失败

- `401 Unauthorized / invalid_api_key`：Codex 用了 API Key 而不是 ChatGPT 登录。环境变量 `CODEX_API_KEY` 会让 Codex 改用 API Key（`OPENAI_API_KEY` 不会），脚本已为 Codex 进程去掉这两个变量。若仍出现，说明 `~/.codex/auth.json` 的 ChatGPT 登录过期或不存在，需要用户运行 `codex login`。**不要**在 config.toml 里加 `forced_login_method = "chatgpt"`：环境里有 API Key 时，Codex 会因此自动退出登录并删除 auth.json。
- `model ... not supported when using Codex with a ChatGPT account`：脚本会按 `gpt-6.1-sol` → `gpt-6-astra` → `gpt-5.6-luna` 的顺序自动换模型。新模型常常需要较新的 Codex CLI（`npm i -g @openai/codex@latest`）。也可以用 `--model` 或环境变量 `CODEX_IMAGE_MODEL` 指定。
- 额度用完、内容被拒绝：如实转告用户 Codex 返回的原因。
