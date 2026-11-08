// Claude Relay connector: lets Claude, running on the relay, work on THIS computer.
// It connects OUT to the relay (no open ports, no admin rights), pairs once with a code from the web page, and then runs
// the file and command requests of conversations that chose this computer. File access is limited to one work folder,
// checked here on this computer. Every request is printed in this window; close the window to disconnect.
// Runs under Node 22+ or Bun (shipped as a single executable built with `bun build --compile`). macOS and Windows.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { spawn, spawnSync } from 'node:child_process';

const VERSION = '1.1.0';
const WIN = process.platform === 'win32', MAC = process.platform === 'darwin';
const CONF_DIR = WIN ? path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'ClaudeRelayConnector')
  : MAC ? path.join(os.homedir(), 'Library', 'Application Support', 'ClaudeRelayConnector')
  : path.join(os.homedir(), '.config', 'claude-relay-connector');
const CONF = path.join(CONF_DIR, 'config.json');
const MAX_OUT = 100_000;      // characters of command output returned
const MAX_READ = 2_000_000;   // bytes read for one file

// ---------- console ----------
const t = () => new Date().toLocaleTimeString();
const log = (...a) => console.log(`[${t()}]`, ...a);
const short = (s, n = 90) => { s = String(s ?? '').replace(/\s+/g, ' '); return s.length > n ? s.slice(0, n) + '…' : s; };
// On macOS the compiled (Bun) binary cannot watch a terminal with kqueue (EINVAL), so read the line synchronously
// from /dev/tty there. This also works when the installer was piped into bash (stdin = the script).
function askTty(q, def) {
  let fd;
  try { fd = fs.openSync('/dev/tty', 'r'); } catch { return def; }
  process.stdout.write(`${q}${def ? `（直接回车 = ${def}）` : ''}：`);
  const chunks = [], b = Buffer.alloc(1024);
  try {
    for (;;) {
      let n;
      try { n = fs.readSync(fd, b, 0, b.length, null); } catch (e) { if (e.code === 'EAGAIN') continue; break; }
      if (n <= 0) break;
      chunks.push(Buffer.from(b.subarray(0, n)));
      if (b.subarray(0, n).includes(10)) break;
    }
  } finally { fs.closeSync(fd); }
  return Buffer.concat(chunks).toString('utf8').split('\n')[0].trim() || def;
}
async function ask(q, def) {
  if (!WIN) return askTty(q, def);
  if (!process.stdin.isTTY) return def;
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const a = await new Promise((r) => rl.question(`${q}${def ? `（直接回车 = ${def}）` : ''}：`, r));
  rl.close();
  return a.trim() || def;
}

// ---------- args / config ----------
const args = process.argv.slice(2);
const opt = (name) => { const i = args.indexOf('--' + name); return i >= 0 ? args[i + 1] : null; };
let conf = {}; try { conf = JSON.parse(fs.readFileSync(CONF, 'utf8')); } catch {}
const saveConf = () => { fs.mkdirSync(CONF_DIR, { recursive: true }); fs.writeFileSync(CONF, JSON.stringify(conf, null, 2), { mode: 0o600 }); };

// ---------- the work folder: every file request must stay inside it ----------
const norm = (p) => (WIN || MAC ? p.toLowerCase() : p);
// Resolve symlinks of the deepest existing part, so a link inside the folder cannot point outside it.
function realish(p) {
  let cur = p; const rest = [];
  while (!fs.existsSync(cur)) { const up = path.dirname(cur); if (up === cur) break; rest.unshift(path.basename(cur)); cur = up; }
  let real = cur; try { real = fs.realpathSync.native(cur); } catch {}
  return path.join(real, ...rest);
}
function inRoot(p) {
  const root = norm(realish(conf.root)), want = norm(realish(p));
  return want === root || want.startsWith(root.endsWith(path.sep) ? root : root + path.sep);
}
function resolvePath(p) {
  let s = String(p ?? '').trim() || '.';
  if (s === '~' || s.startsWith('~/') || s.startsWith('~\\')) s = path.join(os.homedir(), s.slice(1));
  const abs = path.resolve(conf.root, s);
  if (!inRoot(abs)) throw new Error(`只能访问工作文件夹 ${conf.root} 里的文件（被拒绝：${abs}）`);
  return abs;
}

// ---------- commands ----------
const procs = new Map(); // call id -> child
function shellSpawn(command, cwd) {
  if (WIN) {
    // UTF-8 output (Windows PowerShell 5.1 would otherwise mangle Chinese); the command goes in -EncodedCommand (no quoting issues).
    const script = `[Console]::OutputEncoding=[Text.Encoding]::UTF8;$OutputEncoding=[Text.Encoding]::UTF8;$ProgressPreference='SilentlyContinue';\n${command}`;
    const enc = Buffer.from(script, 'utf16le').toString('base64');
    return spawn('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', enc], { cwd, windowsHide: true });
  }
  const sh = fs.existsSync('/bin/zsh') ? '/bin/zsh' : '/bin/bash';
  return spawn(sh, ['-l', '-c', command], { cwd, detached: true, env: { ...process.env, LANG: process.env.LANG || 'en_US.UTF-8' } });
}
function killTree(child) {
  try { if (WIN) spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true }); else process.kill(-child.pid, 'SIGKILL'); } catch {}
}
function runCommand(id, { command, cwd, timeout }) {
  const dir = resolvePath(cwd || '.');
  fs.mkdirSync(dir, { recursive: true });
  const ms = Math.min(Math.max(Number(timeout) || 120, 1), 600) * 1000;
  return new Promise((resolve) => {
    const started = Date.now();
    const child = shellSpawn(String(command), dir);
    procs.set(id, child);
    let out = '', truncated = false, timedOut = false;
    const add = (d) => { if (out.length < MAX_OUT) out += d.toString('utf8'); else truncated = true; };
    child.stdout.on('data', add); child.stderr.on('data', add);
    const timer = setTimeout(() => { timedOut = true; killTree(child); }, ms);
    child.on('error', (e) => { out += `\n[无法启动：${e.message}]`; });
    child.on('close', (code) => {
      clearTimeout(timer); procs.delete(id);
      if (out.length > MAX_OUT) { out = out.slice(0, MAX_OUT); truncated = true; }
      resolve({ exitCode: code, output: out, truncated, timedOut, seconds: Math.round((Date.now() - started) / 100) / 10, cwd: dir });
    });
  });
}

// ---------- files ----------
const SKIP = new Set(['node_modules', '.git', '.venv', 'venv', '__pycache__', '.cache', 'Library']);
async function walk(dir, max, onFile) {
  const stack = [dir]; let n = 0;
  while (stack.length && n < max) {
    const d = stack.pop(); let ents; try { ents = await fsp.readdir(d, { withFileTypes: true }); } catch { continue; }
    for (const e of ents) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) { if (!SKIP.has(e.name)) stack.push(p); }
      else if (e.isFile()) { n++; if (onFile(p) === false || n >= max) return; }
    }
  }
}
function globToRe(g) {
  let re = '';
  for (let i = 0; i < g.length; i++) {
    const c = g[i];
    if (c === '*') { if (g[i + 1] === '*') { re += '.*'; i++; if (g[i + 1] === '/' || g[i + 1] === '\\') i++; } else re += '[^/\\\\]*'; }
    else if (c === '?') re += '[^/\\\\]';
    else if (c === '/' || c === '\\') re += '[/\\\\]';
    else if (c === '{') { const j = g.indexOf('}', i); re += '(' + g.slice(i + 1, j).split(',').map((x) => x.replace(/[.+^$()|[\]]/g, '\\$&')).join('|') + ')'; i = j; }
    else re += c.replace(/[.+^$()|[\]]/g, '\\$&');
  }
  return new RegExp('^' + re + '$', 'i');
}
const full = (u) => (String(u).startsWith('/') ? conf.server + u : u); // transfer links come as paths on the paired server
const looksBinary = (buf) => buf.subarray(0, 8000).includes(0);
const OPS = {
  async info() { return { root: conf.root, os: process.platform, release: os.release(), arch: process.arch, hostname: os.hostname(), user: os.userInfo().username, home: os.homedir(), shell: WIN ? 'powershell' : (fs.existsSync('/bin/zsh') ? 'zsh' : 'bash'), version: VERSION }; },
  async exec(a, id) { return runCommand(id, a); },
  // Switch the work folder (asked from the web page's 「我的电脑」). Never offered to Claude as a tool.
  async setroot({ root }) {
    let r = String(root || '').trim().replace(/^["']|["']$/g, '');
    if (!r) throw new Error('请填写文件夹路径');
    if (r === '~' || r.startsWith('~/') || r.startsWith('~\\')) r = path.join(os.homedir(), r.slice(1));
    if (!path.isAbsolute(r)) throw new Error(`请填写完整路径，例如 ${WIN ? 'D:\\项目 或 ~\\Documents\\项目' : '~/Documents/项目 或 /Users/你的用户名/项目'}`);
    r = path.resolve(r);
    if (norm(r) === norm(path.parse(r).root)) throw new Error('不能把整个磁盘设为工作文件夹，请换一个文件夹');
    if (fs.existsSync(r) && !fs.statSync(r).isDirectory()) throw new Error('这是一个文件，不是文件夹：' + r);
    try { fs.mkdirSync(r, { recursive: true }); fs.readdirSync(r); }
    catch (e) { throw new Error(`无法访问这个文件夹（${e.code || e.message}）${MAC ? '。macOS 可能拦截了：到「系统设置 → 隐私与安全性 → 文件和文件夹」里允许「终端」访问，或换一个文件夹' : ''}`); }
    const old = conf.root; conf.root = r; saveConf();
    log(`📁 工作文件夹已在网页上切换为：${r}（原来是 ${old}）`);
    return { root: r, old };
  },
  async read({ path: p, offset, limit }) {
    const f = resolvePath(p); const st = await fsp.stat(f);
    if (st.isDirectory()) throw new Error('这是一个文件夹，请用 list_dir');
    const buf = Buffer.alloc(Math.min(st.size, MAX_READ)); const fh = await fsp.open(f, 'r'); await fh.read(buf, 0, buf.length, 0); await fh.close();
    if (looksBinary(buf)) return { path: f, binary: true, size: st.size };
    const lines = buf.toString('utf8').split(/\r?\n/), from = Math.max(0, (Number(offset) || 1) - 1), n = Math.min(Number(limit) || 2000, 5000);
    return { path: f, totalLines: lines.length, from: from + 1, content: lines.slice(from, from + n).map((l, i) => `${from + i + 1}\t${l.length > 2000 ? l.slice(0, 2000) + '…' : l}`).join('\n'), truncated: st.size > MAX_READ || from + n < lines.length };
  },
  async write({ path: p, content }) {
    const f = resolvePath(p); await fsp.mkdir(path.dirname(f), { recursive: true }); await fsp.writeFile(f, String(content ?? ''), 'utf8');
    return { path: f, bytes: Buffer.byteLength(String(content ?? '')) };
  },
  async edit({ path: p, old_string, new_string, replace_all }) {
    const f = resolvePath(p); const s = await fsp.readFile(f, 'utf8');
    const n = s.split(old_string).length - 1;
    if (!old_string || n === 0) throw new Error('没有找到要替换的原文');
    if (n > 1 && !replace_all) throw new Error(`原文出现了 ${n} 次，请提供更长、唯一的原文，或设置 replace_all`);
    await fsp.writeFile(f, replace_all ? s.split(old_string).join(new_string) : s.replace(old_string, () => new_string), 'utf8');
    return { path: f, replaced: replace_all ? n : 1 };
  },
  async list({ path: p }) {
    const d = resolvePath(p); const ents = await fsp.readdir(d, { withFileTypes: true });
    const items = [];
    for (const e of ents.slice(0, 500)) {
      let st = null; try { st = await fsp.stat(path.join(d, e.name)); } catch {}
      items.push({ name: e.name, type: e.isDirectory() ? 'dir' : 'file', size: st?.size, modified: st ? new Date(st.mtimeMs).toISOString().slice(0, 16) : undefined });
    }
    return { path: d, total: ents.length, items };
  },
  async glob({ pattern, path: p }) {
    const base = resolvePath(p); const re = globToRe(String(pattern || '**/*')); const hits = [];
    await walk(base, 20000, (f) => { const rel = path.relative(base, f); if (re.test(rel) || re.test(path.basename(f))) hits.push(rel); if (hits.length >= 500) return false; });
    return { base, matches: hits };
  },
  async grep({ pattern, path: p, glob, ignore_case }) {
    const base = resolvePath(p); const re = new RegExp(String(pattern), ignore_case ? 'i' : ''); const g = glob ? globToRe(glob) : null; const hits = [];
    const files = []; await walk(base, 20000, (f) => { if (!g || g.test(path.basename(f)) || g.test(path.relative(base, f))) files.push(f); });
    for (const f of files) {
      let st; try { st = await fsp.stat(f); } catch { continue; }
      if (st.size > 2_000_000) continue;
      let buf; try { buf = await fsp.readFile(f); } catch { continue; }
      if (looksBinary(buf)) continue;
      const lines = buf.toString('utf8').split(/\r?\n/);
      for (let i = 0; i < lines.length && hits.length < 300; i++) if (re.test(lines[i])) hits.push(`${path.relative(base, f)}:${i + 1}: ${lines[i].slice(0, 300)}`);
      if (hits.length >= 300) break;
    }
    return { base, matches: hits, truncated: hits.length >= 300 };
  },
  // Send a file of this computer to the relay (to show and download it in the chat).
  async upload({ path: p, url }) {
    const f = resolvePath(p); const st = await fsp.stat(f);
    if (st.size > 200 * 1024 * 1024) throw new Error('文件超过 200MB');
    const r = await fetch(full(url), { method: 'POST', headers: { 'x-device-token': conf.token, 'x-file-name': encodeURIComponent(path.basename(f)) }, body: await fsp.readFile(f) });
    if (!r.ok) throw new Error('上传失败：' + r.status);
    return { path: f, bytes: st.size, ...(await r.json()) };
  },
  // Fetch a file from the relay (e.g. one the user attached in the chat) into the work folder.
  async download({ url, path: p }) {
    const f = resolvePath(p);
    const r = await fetch(full(url), { headers: { 'x-device-token': conf.token } });
    if (!r.ok) throw new Error('下载失败：' + r.status);
    const buf = Buffer.from(await r.arrayBuffer()); await fsp.mkdir(path.dirname(f), { recursive: true }); await fsp.writeFile(f, buf);
    return { path: f, bytes: buf.length };
  },
};
const LABEL = { exec: '执行命令', read: '读取', write: '写入', edit: '修改', list: '列出', glob: '查找文件', grep: '搜索内容', upload: '发送文件到对话', download: '保存附件', info: '查看电脑信息', setroot: '切换工作文件夹' };

// ---------- connection ----------
let ws = null, backoff = 1000;
function connect() {
  const url = conf.server.replace(/^http/, 'ws').replace(/\/$/, '') + '/connector';
  ws = new WebSocket(url, { headers: { 'x-device-token': conf.token } });
  // Some WebSocket implementations ignore headers: the token also goes in the first message.
  ws.onopen = async () => { backoff = 1000; ws.send(JSON.stringify({ type: 'hello', token: conf.token, ...(await OPS.info()) })); };
  ws.onmessage = async (ev) => {
    let m; try { m = JSON.parse(typeof ev.data === 'string' ? ev.data : Buffer.from(ev.data).toString('utf8')); } catch { return; }
    if (m.type === 'ping') return ws.send(JSON.stringify({ type: 'pong' }));
    if (m.type === 'ready') { log(`✅ 已连接到 ${conf.server}，设备名「${m.name}」。工作文件夹：${conf.root}`); log('现在可以回到网页，在 Code 模式里选择这台电脑。关闭本窗口即断开连接。'); return; }
    if (m.type === 'revoked') { log('❌ 这台电脑已在网页上被移除，连接器退出。需要重新连接请到网页上再生成配对码。'); try { fs.rmSync(CONF); } catch {} process.exit(1); }
    if (m.type === 'cancel') { const c = procs.get(m.id); if (c) { killTree(c); log('⏹ 已停止正在运行的命令'); } return; }
    if (m.type !== 'call') return;
    const fn = OPS[m.op];
    const arg = m.args || {};
    log(`${LABEL[m.op] || m.op}  ${short(arg.command || arg.path || arg.pattern || arg.root || '')}`);
    try {
      if (!fn) throw new Error('未知操作 ' + m.op);
      const result = await fn(arg, m.id);
      ws.send(JSON.stringify({ type: 'result', id: m.id, ok: true, result }));
      if (m.op === 'exec') log(`   ↳ 退出码 ${result.exitCode}${result.timedOut ? '（超时被停止）' : ''}，用时 ${result.seconds}s`);
    } catch (e) {
      log(`   ↳ 失败：${short(e.message, 150)}`);
      ws.send(JSON.stringify({ type: 'result', id: m.id, ok: false, error: String(e.message || e) }));
    }
  };
  ws.onclose = (ev) => {
    if (ev.code === 4401) { log('❌ 设备令牌无效（可能已在网页上移除）。请在网页上重新生成配对码。'); try { fs.rmSync(CONF); } catch {} process.exit(1); }
    log(`连接断开，${Math.round(backoff / 1000)} 秒后重连…`);
    setTimeout(connect, backoff); backoff = Math.min(backoff * 2, 30000);
  };
  ws.onerror = () => {};
}

// ---------- start ----------
async function main() {
  console.log(`\nClaude Relay 连接器 v${VERSION}  ·  ${MAC ? 'macOS' : WIN ? 'Windows' : process.platform}  ·  ${os.hostname()}\n`);
  const code = opt('pair'), server = opt('server') || conf.server;
  if (code) {
    if (!server) throw new Error('缺少 --server');
    const def = conf.root || path.join(os.homedir(), 'ClaudeWorkspace');
    console.log('Claude 只能读写你指定的「工作文件夹」里的文件（执行命令时也会默认在这个文件夹里运行）。');
    let root = opt('root') || await ask('请输入工作文件夹的完整路径', def);
    if (root === '~' || root.startsWith('~/')) root = path.join(os.homedir(), root.slice(1));
    root = path.resolve(root);
    if (norm(root) === norm(path.parse(root).root)) throw new Error('不能把整个磁盘设为工作文件夹，请换一个文件夹');
    fs.mkdirSync(root, { recursive: true });
    const r = await fetch(server.replace(/\/$/, '') + '/connect/pair', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: code.trim().toUpperCase(), os: process.platform, arch: process.arch, hostname: os.hostname(), user: os.userInfo().username, root, version: VERSION }),
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(d.error || ('配对失败：' + r.status));
    conf = { server: server.replace(/\/$/, ''), token: d.token, deviceId: d.deviceId, root };
    saveConf();
    log(`配对成功：这台电脑在网页上叫「${d.name}」。设置已保存在 ${CONF}`);
  }
  if (!conf.token) {
    console.log('还没有配对。请在中转站网页上点「我的电脑」→「连接新电脑」，按页面上的命令运行。');
    process.exit(1);
  }
  if (!fs.existsSync(conf.root)) fs.mkdirSync(conf.root, { recursive: true });
  log('正在连接…');
  connect();
}
main().catch((e) => { console.error('\n❌ ' + (e.message || e)); process.exitCode = 1; if (process.stdin.isTTY && WIN) setTimeout(() => {}, 15000); });
