// Claude Relay: a Claude-style web UI that drives the local Claude Agent SDK.
// Exposed to the internet through a Cloudflare Tunnel; protected by a secret access key in the URL.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { query, forkSession, getSessionMessages, createSdkMcpServer, tool as sdkTool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { pathToFileURL } from 'node:url';
import { extractDocx } from './lib/docx.mjs';
import { detectFiles } from './lib/outputs.mjs';
import { createPreviews } from './lib/preview.mjs';
import { writeZip } from './lib/zip.mjs';
import { codexUsage } from './lib/codex.mjs';
import { createShares } from './lib/share.mjs';
import { createUsers } from './lib/users.mjs';
import { createDevices } from './lib/devices.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const DATA = path.join(ROOT, 'data');
const CONV_DIR = path.join(DATA, 'conversations');
const CONFIG_FILE = path.join(DATA, 'config.json');
fs.mkdirSync(CONV_DIR, { recursive: true });

// ---------- config ----------
const readJson = (f) => (fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8').replace(/^﻿/, '')) : {});
const shared = readJson(CONFIG_FILE);
// RELAY_PROFILE=<name> (set by the Linux systemd unit) layers data/profiles/<name>.json on top of config.json,
// so one machine can use its own domain and workdir without rewriting the shared config the other machine uses.
const PROFILE = process.env.RELAY_PROFILE ? readJson(path.join(DATA, 'profiles', `${process.env.RELAY_PROFILE}.json`)) : {};
const config = { ...shared, ...PROFILE };
if (process.env.RELAY_PORT) config.port = Number(process.env.RELAY_PORT);
config.port ??= 8787;
config.accessKey ??= crypto.randomBytes(24).toString('base64url');
// The management link (sees everything, manages shares and guests). accessKey stays the original main link.
config.adminKey ??= crypto.randomBytes(24).toString('base64url');
config.workdir ??= path.join(os.homedir(), 'ClaudeRelay');
// A config restored from another PC may point at another user's home folder (or be a Windows path on Linux): use this machine's home instead.
if (!path.isAbsolute(config.workdir) || !fs.existsSync(path.dirname(config.workdir))) config.workdir = path.join(os.homedir(), 'ClaudeRelay');
// Your two public addresses (both routed by the Cloudflare Tunnel to this server). Set them in data/config.json, or
// with RELAY_PUBLIC_URL / RELAY_PREVIEW_URL. Without them the relay works on this computer only (http://localhost).
if (process.env.RELAY_PUBLIC_URL) config.publicUrl = process.env.RELAY_PUBLIC_URL;
if (process.env.RELAY_PREVIEW_URL) config.previewUrl = process.env.RELAY_PREVIEW_URL;
config.publicUrl = String(config.publicUrl || `http://localhost:${config.port}`).replace(/\/$/, '');
// separate origin for live previews of generated web pages and share links (preview.localhost resolves to this computer)
config.previewUrl = String(config.previewUrl || `http://preview.localhost:${config.port}`).replace(/\/$/, '');
if (!process.env.RELAY_PROFILE) fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
else if (!shared.accessKey || !shared.adminKey) fs.writeFileSync(CONFIG_FILE, JSON.stringify({ ...shared, accessKey: config.accessKey, adminKey: config.adminKey }, null, 2));
// A file path recorded on another machine (…\ClaudeRelay\… or …/ClaudeRelay/…) lives in this machine's workdir.
const livePath = (p) => {
  if (!p || fs.existsSync(p)) return p;
  const rel = String(p).split(/[\\/]ClaudeRelay[\\/]/i)[1];
  return rel ? path.join(config.workdir, ...rel.split(/[\\/]+/)) : p;
};
fs.mkdirSync(path.join(config.workdir, 'uploads'), { recursive: true });

// Models and skills are refreshed from the SDK after each run; these are the fallbacks.
let models = [
  { value: 'default', displayName: 'Default (recommended)', description: '' },
  { value: 'opus', displayName: 'Opus', description: '' },
  { value: 'claude-fable-5-1[1m]', displayName: 'Fable', description: '' },
  { value: 'sonnet', displayName: 'Sonnet', description: '' },
  { value: 'haiku', displayName: 'Haiku', description: '' },
];
let commands = scanSkills();

function scanSkills() {
  const dir = path.join(os.homedir(), '.claude', 'skills');
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).flatMap((name) => {
    const f = path.join(dir, name, 'SKILL.md');
    if (!fs.existsSync(f)) return [];
    const m = fs.readFileSync(f, 'utf8').match(/^description:\s*(.+)$/m);
    return [{ name, description: m ? m[1].replace(/^["']|["']$/g, '') : '', argumentHint: '' }];
  });
}

// ---------- usage / quota ----------
// Plan rate limits come from the SDK's (experimental) /usage control request, via an idle query that sends no prompt.
let usageCache = null; // { at, data }
let usageInflight = null;
let liveRateLimits = {}; // rateLimitType -> latest SDKRateLimitInfo seen during chats

async function fetchUsage(force) {
  if (!force && usageCache && Date.now() - usageCache.at < 60_000) return usageCache.data;
  if (usageInflight) return usageInflight;
  usageInflight = (async () => {
    let release;
    const idle = new Promise((r) => (release = r));
    async function* noPrompt() { await idle; }
    const q = query({ prompt: noPrompt(), options: { cwd: config.workdir, settingSources: [] } });
    const timeout = setTimeout(() => q.close(), 30_000);
    try {
      const u = await q.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET({ skipBehaviors: true });
      let account = null;
      try { account = await q.accountInfo(); } catch {}
      const data = {
        subscriptionType: u.subscription_type,
        available: u.rate_limits_available,
        rateLimits: u.rate_limits,
        account: account && { email: account.email, organization: account.organization, subscriptionType: account.subscriptionType },
        fetchedAt: Date.now(),
      };
      usageCache = { at: Date.now(), data };
      return data;
    } finally {
      clearTimeout(timeout);
      release();
      q.close();
      usageInflight = null;
    }
  })();
  return usageInflight;
}

// Local totals from stored conversations (cost reported by each finished turn).
function localStats() {
  const dayStart = new Date(); dayStart.setHours(0, 0, 0, 0);
  const s = { today: { turns: 0, cost: 0 }, last7: { turns: 0, cost: 0 }, all: { turns: 0, cost: 0 } };
  const weekAgo = Date.now() - 7 * 864e5;
  for (const f of fs.readdirSync(CONV_DIR).filter((x) => x.endsWith('.json'))) {
    const c = JSON.parse(fs.readFileSync(path.join(CONV_DIR, f), 'utf8'));
    for (const m of c.messages) {
      if (m.role !== 'assistant' || !m.result) continue;
      const cost = m.result.cost || 0, t = m.startedAt || 0;
      s.all.turns++; s.all.cost += cost;
      if (t >= weekAgo) { s.last7.turns++; s.last7.cost += cost; }
      if (t >= dayStart.getTime()) { s.today.turns++; s.today.cost += cost; }
    }
  }
  return s;
}

// ---------- conversation store ----------
const convPath = (id) => path.join(CONV_DIR, `${id.replace(/[^\w-]/g, '')}.json`);
const loadConv = (id) => (fs.existsSync(convPath(id)) ? JSON.parse(fs.readFileSync(convPath(id), 'utf8')) : null);
// convId -> whose it is: '' = the old main link's pool (every conversation from before), '@admin' = made with the
// management link, otherwise a guest id. Kept in memory so every broadcast can be scoped without reading files.
const convOwner = new Map();
const saveConv = (c) => { convOwner.set(c.id, c.owner || ''); fs.writeFileSync(convPath(c.id), JSON.stringify(c)); };
function allConvs() {
  return fs.readdirSync(CONV_DIR).filter((f) => f.endsWith('.json')).map((f) => {
    const c = JSON.parse(fs.readFileSync(path.join(CONV_DIR, f), 'utf8'));
    convOwner.set(c.id, c.owner || '');
    return c;
  });
}
// Who a conversation belongs to, as the management link's sidebar labels it.
const ownerLabel = (o) => (!o ? '个人链接' : o === ADMIN_POOL ? '' : users.get(o)?.note || '已删除的访客');
// The sidebar list as one user sees it: the management link sees everything (others' conversations carry a label);
// the old main link sees its own pool; a guest sees their own plus the ones shared with them (shared: true, read-only).
function listConvs(who = OWNER, convs = allConvs()) {
  const g = who.role === 'guest' ? users.get(who.id) : null;
  const visible = (c) => (isOwner(who) ? true : who.role === 'legacy' ? !c.owner : !!g && (c.owner === g.id || g.shared.includes(c.id)));
  return convs.filter(visible).map((c) => ({
    id: c.id, title: c.title, updatedAt: c.updatedAt, model: c.model, running: running.has(c.id),
    ...(g ? (c.owner !== g.id ? { shared: true } : {})
      : isOwner(who) && c.owner !== ADMIN_POOL ? { owner: c.owner || 'legacy', ownerNote: ownerLabel(c.owner) } : {}),
  })).sort((a, b) => b.updatedAt - a.updatedAt);
}

// ---------- users ----------
// owner  = the management link (config.adminKey): sees everything, manages shares and guests.
// legacy = the original main link (config.accessKey): all the original features, but sees only its own pool
//          (every conversation from before plus the ones it creates) and has no share / guest management.
// guest  = a sub-link (data/users.json).
const ADMIN_POOL = '@admin';
const OWNER = { role: 'owner' }, LEGACY = { role: 'legacy' };
const users = createUsers({ file: path.join(DATA, 'users.json') });
// Users' own computers connected with the connector ("my computer").
const devices = createDevices({ file: path.join(DATA, 'devices.json') });
function keyOf(req) { const url = new URL(req.url, 'http://x'); return url.searchParams.get('k') || req.headers['x-access-key']; }
const sameKey = (a, b) => typeof a === 'string' && typeof b === 'string' && a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
function authUser(req) {
  const key = keyOf(req);
  if (typeof key !== 'string') return null;
  if (sameKey(key, config.adminKey)) return OWNER;
  if (sameKey(key, config.accessKey)) return LEGACY;
  const u = users.byKey(key);
  return u && u.enabled ? { role: 'guest', id: u.id } : null;
}
const isOwner = (who) => who?.role === 'owner';
const isGuest = (who) => who?.role === 'guest';
// The tag new conversations / uploads / branches get: '@admin', '' (old link) or the guest id.
const poolOf = (who) => (isOwner(who) ? ADMIN_POOL : isGuest(who) ? who.id : '');
// visible: may read it; editable: may send messages, rename, delete.
function canSee(who, convId) {
  if (isOwner(who)) return true;
  if (!convOwner.has(convId)) { const c = loadConv(convId); if (c) convOwner.set(c.id, c.owner || ''); }
  if (who?.role === 'legacy') return convOwner.get(convId) === '';
  const g = who && users.get(who.id); if (!g || !g.enabled) return false;
  return convOwner.get(convId) === g.id || g.shared.includes(convId);
}
function canEdit(who, convId) {
  if (isOwner(who)) return true;
  if (!convOwner.has(convId)) { const c = loadConv(convId); if (c) convOwner.set(c.id, c.owner || ''); }
  if (who?.role === 'legacy') return convOwner.get(convId) === '';
  return !!who && !!users.get(who.id)?.enabled && convOwner.get(convId) === who.id;
}

// ---------- realtime ----------
const clients = new Set(); // each ws carries ws.who
// Permission prompts and plan rate limits never go to guests (prompts additionally only to who can see that conversation).
const OWNER_ONLY = new Set(['perm_request', 'perm_resolved', 'rate_limit']);
// Scoped delivery: the sidebar list is built per user; anything about one conversation goes only to users who can see it.
const broadcast = (msg) => {
  if (msg.type === 'list') {
    const convs = allConvs();
    for (const ws of clients) if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'list', conversations: listConvs(ws.who, convs) }));
    return;
  }
  const convId = msg.convId || msg.conv?.id;
  const s = JSON.stringify(msg);
  for (const ws of clients) {
    if (ws.readyState !== 1) continue;
    if (OWNER_ONLY.has(msg.type) && isGuest(ws.who) && !msg.device) continue; // device prompts go to the guest whose computer it is
    if (convId && !canSee(ws.who, convId)) continue;
    ws.send(s);
  }
};
const running = new Map(); // convId -> { q, turn }
const pendingPerms = new Map(); // reqId -> { resolve, convId, ... }

// ---------- guest quota ----------
// Each guest turn's cost (API-equivalent dollars, from the SDK) is converted to "% of the weekly limit" with
// k = dollars per 1 %. k is calibrated from the relay's own spending against the weekly utilisation the API reports;
// that ratio can only underestimate k (the account is also used outside the relay), so guests are stopped early, not late.
function weekStart() {
  const r = users.meta().sevenDay?.resetsAt;
  return r ? r * 1000 - 7 * 864e5 : Date.now() - 7 * 864e5;
}
function costSince(start, convs, filter = () => true) {
  let cost = 0, turns = 0;
  for (const c of convs) if (filter(c)) for (const m of c.messages) if (m.role === 'assistant' && m.result && (m.startedAt || 0) >= start) { cost += m.result.cost || 0; turns++; }
  return { cost, turns };
}
function guestUsage(id, convs = allConvs()) {
  const g = users.get(id); const { cost, turns } = costSince(weekStart(), convs, (c) => c.owner === id);
  const pct = cost / users.k();
  return { cost, turns, pct, limitPct: g?.quotaPct ?? null, over: g?.quotaPct != null && pct >= g.quotaPct, resetsAt: users.meta().sevenDay?.resetsAt || null };
}
function noteWeekly(info) {
  const w = info?.unifiedWindows?.seven_day; if (!w || w.utilization == null) return;
  const util = w.utilization * 100;
  users.setMeta({ sevenDay: { utilization: util, resetsAt: w.resetsAt, at: Date.now() } });
  if (util >= 3) {
    const est = costSince(weekStart(), allConvs()).cost / util;
    if (est > (users.meta().kAuto || 0)) users.setMeta({ kAuto: Math.round(est * 1000) / 1000 });
  }
}

// ---------- uploads ----------
// Files are uploaded over plain HTTP (not the WebSocket) and referenced by id in chat messages.
const UPLOAD_DIR = path.join(config.workdir, 'uploads');
const UPLOAD_INDEX = path.join(DATA, 'uploads.json');
const uploads = fs.existsSync(UPLOAD_INDEX) ? JSON.parse(fs.readFileSync(UPLOAD_INDEX, 'utf8')) : {};
// The index may come from another PC (restored from GitHub): files always live in this machine's UPLOAD_DIR.
for (const u of Object.values(uploads)) u.path = path.join(UPLOAD_DIR, path.win32.basename(u.path));
const MAX_UPLOAD = 50 * 1024 * 1024;
const MAX_INLINE_IMAGE = 3.5 * 1024 * 1024; // API limit is 5 MB base64 per image

// ---------- downloads (uploads and files Claude produced) ----------
const FILE_MIME = { pdf: 'application/pdf', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml',
  bmp: 'image/bmp', tif: 'image/tiff', tiff: 'image/tiff', mp4: 'video/mp4', m4v: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm', mkv: 'video/x-matroska',
  avi: 'video/x-msvideo', mp3: 'audio/mpeg', wav: 'audio/wav', m4a: 'audio/mp4', ogg: 'audio/ogg', flac: 'audio/flac', txt: 'text/plain; charset=utf-8',
  md: 'text/markdown; charset=utf-8', csv: 'text/csv; charset=utf-8', tsv: 'text/tab-separated-values; charset=utf-8', html: 'text/plain; charset=utf-8', htm: 'text/plain; charset=utf-8',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', doc: 'application/msword', xls: 'application/vnd.ms-excel',
  ppt: 'application/vnd.ms-powerpoint', zip: 'application/zip' };
const mimeOf = (name) => FILE_MIME[path.extname(name).slice(1).toLowerCase()] || 'application/octet-stream';
// Streams a file; supports Range so videos can be previewed and seeked. download=true makes the browser save it.
// SVG and HTML are never rendered inline from this origin (they could run script): they always download / show as text.
function serveFile(req, res, file, name, type, download) {
  const st = fs.statSync(file);
  if (/svg|html/.test(type)) download = true;
  const head = { 'content-type': type || 'application/octet-stream', 'accept-ranges': 'bytes', 'cache-control': 'private, max-age=3600',
    'x-content-type-options': 'nosniff', 'content-disposition': `${download ? 'attachment' : 'inline'}; filename*=UTF-8''${encodeURIComponent(name)}` };
  const r = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
  if (r && (r[1] || r[2])) {
    let start = r[1] ? +r[1] : Math.max(0, st.size - +r[2]), end = r[1] && r[2] ? Math.min(+r[2], st.size - 1) : st.size - 1;
    if (start >= st.size || start > end) { res.writeHead(416, { 'content-range': `bytes */${st.size}` }); return res.end(); }
    res.writeHead(206, { ...head, 'content-length': end - start + 1, 'content-range': `bytes ${start}-${end}/${st.size}` });
    return fs.createReadStream(file, { start, end }).pipe(res);
  }
  res.writeHead(200, { ...head, 'content-length': st.size });
  if (req.method === 'HEAD') return res.end();
  fs.createReadStream(file).pipe(res);
}
const previews = createPreviews({ file: path.join(DATA, 'previews.json'), workdir: config.workdir });
// Read-only share links (served on the preview host, which never sees the access key). Known secrets are masked in snapshots.
const shares = createShares({
  dir: path.join(DATA, 'shares'), publicBase: config.previewUrl,
  // a function: the main key can be replaced and guest keys are added while the server runs
  secrets: () => [config.accessKey, config.adminKey, ...users.keys(),
    ...['tunnel-token.txt', 'tunnel.env'].map((f) => { try { return fs.readFileSync(path.join(DATA, f), 'utf8').replace(/^TUNNEL_TOKEN=/, '').trim(); } catch { return ''; } }),
    process.env.TUNNEL_TOKEN, process.env.OPENAI_API_KEY, process.env.CODEX_API_KEY, process.env.ANTHROPIC_API_KEY],
});
// Public routes of a share link: /s/<token> (the page), /api/s/<token> (the snapshot), /api/s/<token>/f/<n>, /api/s/<token>/zip
async function handleShare(req, res, url) {
  const sec = { 'x-robots-tag': 'noindex, nofollow', 'referrer-policy': 'no-referrer' };
  const page = url.pathname.match(/^\/s\/([\w-]{12,40})\/?$/);
  if (page) {
    const st = shares.status(page[1]);
    if (st !== 'active') {
      const msg = st === 'paused' ? ['分享已暂停', '分享者暂时关闭了这个链接，恢复后可以继续访问。'] : st === 'expired' ? ['分享已过期', '这个链接已超过分享者设置的有效期。'] : ['分享不存在', '这个链接可能已被删除，或地址有误。'];
      res.writeHead(st ? 410 : 404, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', ...sec });
      res.end(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${msg[0]}</title><style>body{font:15px/1.7 system-ui,sans-serif;background:#faf9f5;color:#3d3929;display:grid;place-items:center;min-height:100vh;margin:0;padding:16px}@media(prefers-color-scheme:dark){body{background:#262624;color:#e8e6dc}}h1{font-weight:500;font-size:22px;margin:0 0 6px}p{margin:0;opacity:.75}</style><div><h1>${msg[0]}</h1><p>${msg[1]}</p></div>`);
      return true;
    }
    if (req.method === 'GET') shares.countView(page[1]);
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache', ...sec });
    fs.createReadStream(path.join(ROOT, 'public', 'index.html')).pipe(res); return true;
  }
  const a = url.pathname.match(/^\/api\/s\/([\w-]{12,40})(?:\/(f)\/(\d+)|\/(zip))?$/);
  if (!a) return false;
  const tok = a[1];
  if (a[2]) {
    const f = shares.file(tok, +a[3]);
    if (!f) { res.writeHead(404, sec); res.end(); return true; }
    serveFile(req, res, f.path, f.name, mimeOf(f.name), url.searchParams.has('dl')); return true;
  }
  const view = shares.publicView(tok);
  if (!view) { res.writeHead(404, { 'content-type': 'application/json', ...sec }); res.end('{}'); return true; }
  if (a[4]) {
    const names = new Set(), entries = [];
    for (const f of shares.allFiles(tok)) {
      let n = f.name, k = 2; const e = path.extname(f.name);
      while (names.has(n.toLowerCase())) n = `${path.basename(f.name, e)} (${k++})${e}`;
      names.add(n.toLowerCase()); entries.push({ name: n, path: f.path });
    }
    if (!entries.length) { res.writeHead(404, sec); res.end(); return true; }
    const zipName = `${String(view.title).replace(/[\\/:*?"<>|]+/g, '_').slice(0, 40)}-文件.zip`;
    res.writeHead(200, { 'content-type': 'application/zip', 'cache-control': 'no-store', 'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(zipName)}`, ...sec });
    try { await writeZip(res, entries); } catch (e) { res.destroy(e); }
    return true;
  }
  res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-cache', ...sec }); res.end(JSON.stringify(view)); return true;
}
// Web pages among a reply's files get a live preview link on the preview host.
function addPreviews(files = []) {
  let changed = false;
  for (const f of files) {
    if (f.preview || !/\.html?$/i.test(f.name) || !fs.existsSync(f.path)) continue;
    try { f.preview = previews.link(config.previewUrl, f.path); changed = true; } catch {}
  }
  return changed;
}
// Older replies (before file detection existed) get their files found once, when the conversation is opened.
function backfillFiles(c) {
  let changed = false;
  c.messages.forEach((m) => {
    if (m.role !== 'assistant' || !m.done || !m.startedAt) return;
    if (m.files === undefined) {
      const to = m.startedAt + (m.result?.durationMs || 0) + 10_000;
      try { m.files = detectFiles(m, { workdir: config.workdir, uploadDir: UPLOAD_DIR, from: m.startedAt, to }); } catch { m.files = []; }
      changed = true;
    }
    if (addPreviews(m.files)) changed = true;
  });
  return changed;
}

// Uploads a guest may use: their own, plus files attached in conversations shared with them.
function guestUploads(id) {
  const g = users.get(id); if (!g) return [];
  const ids = new Set(Object.values(uploads).filter((u) => u.owner === id).map((u) => u.id));
  for (const cid of g.shared) for (const m of loadConv(cid)?.messages || []) for (const a of m.attachments || []) ids.add(a.id);
  return [...ids].map((x) => uploads[x]).filter(Boolean);
}
// A guest allowed Code mode works in their own folder: <workdir>/guests/<id>.
const guestDir = (id) => path.join(config.workdir, 'guests', id);
const inside = (p, dir) => { const a = path.resolve(String(p)).toLowerCase(), b = path.resolve(dir).toLowerCase(); return a === b || a.startsWith(b + path.sep); };
// A guest's Claude may read their uploads (and what was extracted from them, e.g. <file>.docx.extracted/…),
// and, with Code mode, anything in their own folder.
function guestMayRead(id, p) {
  if (!p) return false;
  if (users.get(id)?.code && inside(p, guestDir(id))) return true;
  const want = path.resolve(String(p)).toLowerCase();
  return guestUploads(id).some((u) => { const base = path.resolve(u.path).toLowerCase(); return want === base || want.startsWith(base + '.') || want.startsWith(base + path.sep); });
}
// The authoritative gate for a guest's tool calls. A PreToolUse hook runs for EVERY call (also in bypassPermissions),
// unlike canUseTool, which Claude Code skips for reads inside its working directory (the relay workdir, where all uploads live).
// code = this turn runs in Code mode: file tools are limited to the guest's folder; shell commands are let through
// unchecked, as the owner chose (a command can reach outside the folder; the management panel says so).
const LOCAL_HOST = /^(localhost|.*\.localhost|127\.\d+\.\d+\.\d+|0\.0\.0\.0|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+|169\.254\.\d+\.\d+|\[?::1\]?|\[?f[cd][0-9a-f:]*\]?)$/i;
function guestHooks(id, code = false) {
  const deny = (why) => ({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: why } });
  const allowWith = (updatedInput) => ({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow', updatedInput } });
  const dir = guestDir(id);
  return {
    PreToolUse: [{
      hooks: [async (input) => {
        const name = input.tool_name, args = input.tool_input || {};
        if (name === 'Read') return guestMayRead(id, args.file_path) ? {} : deny(code ? `只能读取你的文件夹 ${dir} 和你上传的文件` : '访客只能读取自己上传的文件');
        if (name === 'WebFetch') {
          let host = ''; try { host = new URL(String(args.url)).hostname; } catch {}
          return host && !LOCAL_HOST.test(host) ? {} : deny('访客不能访问本机或内网地址');
        }
        if (name === 'WebSearch' || name === 'Skill' || name === 'ToolSearch' || IMAGE_TOOLS.includes(name)) return {};
        if (code) {
          if (/^(Write|Edit|MultiEdit|NotebookEdit)$/.test(name)) return inside(args.file_path || args.notebook_path || '', dir) ? {} : deny(`只能在你的文件夹 ${dir} 里创建或修改文件`);
          // Searches default to the relay workdir: point them at the guest's folder instead.
          if (name === 'Glob' || name === 'Grep') return !args.path ? allowWith({ ...args, path: dir }) : inside(args.path, dir) ? {} : deny(`只能在你的文件夹 ${dir} 里搜索`);
          if (/^(Bash|PowerShell|BashOutput|KillShell|KillBash|TodoWrite|Task(Create|Update|List|Get|Output|Stop)?|Monitor)$/.test(name)) return {};
        }
        return deny(`访客不能使用 ${name}`);
      }],
    }],
  };
}
function saveUpload(req, res, who = OWNER) {
  const name = decodeURIComponent(req.headers['x-file-name'] || 'file').replace(/[\\/:*?"<>|\x00-\x1f]/g, '_').slice(-120);
  const type = String(req.headers['content-type'] || 'application/octet-stream').split(';')[0];
  const id = crypto.randomUUID();
  const file = path.join(UPLOAD_DIR, `${id.slice(0, 8)}-${name}`);
  let size = 0;
  const out = fs.createWriteStream(file);
  req.on('data', (d) => {
    size += d.length;
    if (size > MAX_UPLOAD) { req.destroy(); out.destroy(); fs.rmSync(file, { force: true }); }
  });
  req.pipe(out);
  out.on('finish', () => {
    if (size > MAX_UPLOAD) return;
    uploads[id] = { id, name, type, size, path: file, at: Date.now(), ...(poolOf(who) ? { owner: poolOf(who) } : {}) };
    fs.writeFileSync(UPLOAD_INDEX, JSON.stringify(uploads));
    json(res, 200, { id, name, type, size });
  });
  req.on('aborted', () => fs.rmSync(file, { force: true }));
  out.on('error', (e) => json(res, 500, { error: String(e) }));
}

// Build the user message: small images inline (like claude.ai); other files are referenced by local path
// so Claude reads them with its tools (Read handles PDFs, images, docs, code).
// Quoted passages (the "Reply" on selected text, like claude.ai) go first as Markdown blockquotes.
function quoteText(quotes = []) {
  return quotes.map((q) => String(q).trim().split('\n').map((l) => '> ' + l).join('\n')).join('\n\n');
}
const MAX_DOC_CHARS = 120000;   // longer documents are left in a .md file for Claude to Read in parts
const MAX_DOC_IMAGES = 20;      // images beyond this are listed by path
const isDocx = (u) => /\.docx$/i.test(u.name) || u.type === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const inlineImage = (type, file) => ({ type: 'image', source: { type: 'base64', media_type: type, data: fs.readFileSync(file).toString('base64') } });

// Word documents: Claude's Read tool can't open .docx (a zip archive), so the text is extracted to Markdown
// (headings, lists, tables kept) and embedded images are attached in order, marked 「图 N」 where they appear.
async function docxBlocks(u) {
  let r;
  try { r = await extractDocx(u.path); }
  catch (e) { return { blocks: [], note: `[用户上传了 Word 文档「${u.name}」，但解析失败（${String(e?.message || e).slice(0, 200)}）。文件保存在: ${u.path}]` }; }
  const blocks = [], extra = [];
  const imgs = r.images.length ? `，共 ${r.images.length} 张图片（文中用「[图 N：文件名]」标出位置）` : '，文档中没有图片';
  const head = `[用户上传了 Word 文档「${u.name}」。下面是从中提取的全文（Markdown）${imgs}。原文件: ${u.path}]`;
  if (r.markdown.length <= MAX_DOC_CHARS) blocks.push({ type: 'text', text: `${head}\n<document name="${u.name}">\n${r.markdown || '(文档没有文字)'}\n</document>` });
  else blocks.push({ type: 'text', text: `${head}\n全文较长（${r.markdown.length} 字符），已保存为 Markdown：${r.mdPath}，请用 Read 分段读取。开头部分：\n<document name="${u.name}" part="start">\n${r.markdown.slice(0, 20000)}\n</document>` });
  let shown = 0;
  for (const im of r.images) {
    const name = path.basename(im.file);
    if (im.readable && im.size <= MAX_INLINE_IMAGE && shown < MAX_DOC_IMAGES) {
      blocks.push({ type: 'text', text: `「${u.name}」中的图 ${im.n}（${name}）：` }, inlineImage(im.type, im.file));
      shown++;
    } else if (im.readable) extra.push(`图 ${im.n}: ${im.file}`);
    else extra.push(`图 ${im.n}: ${im.file}（${im.type} 格式，无法直接查看）`);
  }
  if (extra.length) blocks.push({ type: 'text', text: `「${u.name}」中未直接附上的图片（可用 Read 查看）：\n${extra.join('\n')}` });
  if (r.messages.length) blocks.push({ type: 'text', text: `（解析提示：${r.messages.join('；')}）` });
  return { blocks };
}

async function buildUserContent(text, attachments = [], quotes = []) {
  const content = [];
  if (quotes.length) text = quoteText(quotes) + (text ? '\n\n' + text : '');
  const notes = [];
  for (const a of attachments) {
    const u = uploads[a.id];
    if (!u || !fs.existsSync(u.path)) { notes.push(`[附件 ${a.name} 未找到]`); continue; }
    if (/^image\/(png|jpeg|gif|webp)$/.test(u.type) && u.size <= MAX_INLINE_IMAGE) {
      content.push(inlineImage(u.type, u.path));
    } else if (isDocx(u)) {
      const d = await docxBlocks(u);
      content.push(...d.blocks);
      if (d.note) notes.push(d.note);
    } else if (/\.doc$/i.test(u.name)) {
      notes.push(`[用户上传了旧版 Word 文档「${u.name}」(.doc)，已保存到: ${u.path}。这种格式无法直接解析，如果读不了，请让用户在 Word 里另存为 .docx 或 PDF 后重新上传]`);
    } else {
      notes.push(`[用户上传了附件「${u.name}」(${u.type}, ${(u.size / 1024).toFixed(0)} KB)，已保存到: ${u.path}]`);
    }
  }
  content.push({ type: 'text', text: [text, ...notes].filter(Boolean).join('\n\n') || '(见附件)' });
  return content;
}

// ---------- automatic titles ----------
// After the first exchange, a small model names the conversation (like claude.ai). A manual rename wins.
const titling = new Set();
async function autoTitle(convId) {
  const conv = loadConv(convId);
  if (!conv || conv.titled || titling.has(convId)) return;
  const user = conv.messages.find((m) => m.role === 'user');
  const reply = conv.messages.find((m) => m.role === 'assistant' && m.done);
  if (!user || !reply) return;
  titling.add(convId);
  const answer = (reply.blocks || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n').slice(0, 1500);
  const files = (user.attachments || []).map((a) => a.name).join(', ');
  const prompt = `Write a short title for this conversation, for a chat sidebar.
Rules:
- Same language as the user's message.
- At most 12 Chinese characters, or at most 5 English words.
- Name the topic as a noun phrase, not the request: "维也纳天气查询" (not "请问维也纳天气"), "CO2 地质封存原理", "Python list sorting".
- If there is no real topic yet (just a greeting), use a plain label such as "简单问候" or "Greeting".
- No quotes, no trailing punctuation. Reply with the title only.

<user_message>${user.quotes?.length ? quoteText(user.quotes) + '\n\n' : ''}${(user.text || '').slice(0, 1500)}${files ? `\n[attachments: ${files}]` : ''}</user_message>
<assistant_reply>${answer}</assistant_reply>`;
  try {
    let title = '';
    for await (const m of query({ prompt, options: { model: 'haiku', effort: 'low', tools: [], settingSources: [], maxTurns: 1, cwd: config.workdir, systemPrompt: 'You write concise conversation titles.' } })) {
      if (m.type === 'result' && m.subtype === 'success' && !m.is_error) title = String(m.result || '');
    }
    title = title.split('\n').map((s) => s.trim()).find(Boolean)?.replace(/^["'“”「『#*\s]+|["'“”」』*。.!！\s]+$/g, '');
    if (title && title.length > 40) title = title.slice(0, 40).replace(/\s+\S*$/, '') + '…';
    const fresh = loadConv(convId);
    if (!title || !fresh || fresh.titled) return;
    fresh.title = title; fresh.titled = true;
    saveConv(fresh);
    broadcast({ type: 'list' });
    broadcast({ type: 'title', convId, title });
  } catch (e) {
    console.error('auto title failed', convId, e?.message || e);
  } finally {
    titling.delete(convId);
  }
}

// ---------- chat mode ----------
// Chat mode answers like the claude.ai chat assistant instead of a coding agent: its own system prompt,
// and only read-only tools (web search/fetch, reading uploaded files, skills), all pre-approved.
const CHAT_TOOLS = ['WebSearch', 'WebFetch', 'Read'];

// ---------- image generation: the image-gen skill's script, exposed as a tool so Chat mode (no Bash) can use it ----------
// Pictures are saved in <workdir>/outputs/images, so they show up as preview/download cards under the reply.
const IMAGE_SCRIPT = path.join(os.homedir(), '.claude', 'skills', 'image-gen', 'scripts', 'image_gen.mjs');
const IMAGE_TOOLS = fs.existsSync(IMAGE_SCRIPT) ? ['mcp__image-gen__generate_image'] : [];
// A fresh server per turn: one SDK MCP server instance can't be connected to two running conversations at once.
// Progress (start, generating + elapsed, image k of n, saving, done) is stored on the running tool block and pushed
// to the page as 'tool_progress' messages, so the user sees what is happening during the 20-60 s wait.
function imageServer(convId, turn, guestId) {
  const generate_image = sdkTool('generate_image',
    'Generate or edit raster images (illustrations, posters, covers, photos, icons, concept art…) with the local Codex image tool. ' +
    'Write a detailed visual prompt (subject, composition, style, colours, lighting; quote any text that must appear). Takes 20–60 s per call. ' +
    'Returns the saved file paths and the images so you can check them; the user sees them automatically under your reply.',
    {
      prompt: z.string().describe('Detailed description of the image; for edits, say what to keep and what to change'),
      aspect: z.string().optional().describe('square | landscape | portrait | ratio such as 16:9, 4:3, 3:4'),
      n: z.number().int().min(1).max(4).optional().describe('Number of variations (1-4, default 1)'),
      reference_images: z.array(z.string()).optional().describe('Absolute paths of images to edit or use as reference (e.g. uploaded files)'),
      name: z.string().optional().describe('Short ASCII file name base, e.g. "vienna-poster"'),
    },
    async (a) => {
      try {
        const { generateImage } = await import(pathToFileURL(IMAGE_SCRIPT).href);
        // Find this call's tool block: the SDK doesn't pass the tool_use id, so match on the prompt (fallback: newest running one).
        const isImg = (x) => x?.type === 'tool' && /generate_image$/.test(x.name || '');
        const block = () => turn.blocks.find((x) => isImg(x) && x.result === undefined && x.input?.prompt === a.prompt)
          || [...turn.blocks].reverse().find((x) => isImg(x) && x.result === undefined);
        let b0 = null;
        const onProgress = (p) => {
          const b = b0 ||= block();
          const images = (p.files || []).map((f) => { try { return { name: path.basename(f), path: f, size: fs.statSync(f).size }; } catch { return null; } }).filter(Boolean);
          const prog = { ...p, files: undefined, file: undefined };
          if (b) { b.progress = prog; if (images.length) b.images = images; }
          // Pictures are sent as they finish, so the page can show them while the rest are still being drawn.
          broadcast({ type: 'tool_progress', convId, blockId: b?.id, progress: prog, images: b?.images ? b.images.map(({ name, size }) => ({ name, size })) : undefined });
        };
        // A guest may only use their own uploads as reference pictures.
        const refs = (a.reference_images || []).filter((p) => !guestId || guestMayRead(guestId, p));
        if (guestId && refs.length < (a.reference_images || []).length) throw new Error('只能使用你自己上传的图片作为参考图');
        const r = await generateImage({ prompt: a.prompt, aspect: a.aspect, n: a.n, refs, name: a.name, outDir: path.join(config.workdir, 'outputs', 'images'), onProgress });
        const content = [{ type: 'text', text: JSON.stringify({ ok: true, files: r.files, seconds: r.seconds, model: r.model }) }];
        for (const f of r.files) {
          const buf = fs.readFileSync(f);
          if (buf.length <= MAX_INLINE_IMAGE) content.push({ type: 'image', data: buf.toString('base64'), mimeType: f.endsWith('.png') ? 'image/png' : f.endsWith('.webp') ? 'image/webp' : 'image/jpeg' });
        }
        return { content };
      } catch (e) {
        return { content: [{ type: 'text', text: JSON.stringify({ ok: false, error: String(e?.message || e) }) }], isError: true };
      }
    });
  return createSdkMcpServer({ name: 'image-gen', version: '1.0.0', tools: [generate_image] });
}

// ---------- web pages: shown through this relay's own preview domain, never as claude.ai Artifacts ----------
// preview_link turns an HTML file / project folder in the working directory into a https://preview.<domain>/p/<token>/ link;
// save_web_page (for Chat mode, which has no Write tool) saves a single-file page into <workdir>/web/<name>/index.html.
// Not offered to guests: a preview link exposes a folder of the owner's working directory.
const WEB_TOOLS = ['mcp__relay-web__preview_link', 'mcp__relay-web__save_web_page'];
// claude.ai publishing tools are switched off in every mode: pages must stay on this relay.
const BLOCKED_TOOLS = ['Artifact', 'ArtifactComments', 'ArtifactData'];
const inWorkdir = (p) => { const r = path.relative(config.workdir, p); return !!r && !r.startsWith('..') && !path.isAbsolute(r); };
function webServer() {
  const linkFor = (target) => {
    const st = fs.statSync(target);
    // A folder opens at index.html (or its first page); a file opens itself, with its folder's css/js/images available.
    if (st.isDirectory()) {
      const pages = fs.readdirSync(target).filter((f) => /\.html?$/i.test(f));
      if (!pages.length) throw new Error('这个文件夹里没有 .html 文件');
      const entry = pages.find((f) => /^index\.html?$/i.test(f)) || pages[0];
      return previews.link(config.previewUrl, path.join(target, entry));
    }
    return previews.link(config.previewUrl, target);
  };
  const preview_link = sdkTool('preview_link',
    'Get the live preview link (https://preview.… on this relay) for a web page you saved: an .html file, or a project folder ' +
    'containing index.html. The file must be inside the working directory ' + config.workdir + ' (not a temp or scratchpad folder). ' +
    'Give the returned URL to the user. Saving again to the same folder keeps the same link, and an open preview reloads by itself.',
    { path: z.string().describe('Absolute path of the .html file or of the project folder') },
    async ({ path: p }) => {
      try {
        const target = path.resolve(config.workdir, String(p).replace(/^\/([a-z])\//i, (_, d) => d.toUpperCase() + ':\\'));
        if (!fs.existsSync(target)) throw new Error('文件不存在：' + target);
        if (!inWorkdir(target)) throw new Error(`预览只能打开工作目录 ${config.workdir} 里的文件。请把网页保存到 ${path.join(config.workdir, '<项目名>', 'index.html')} 再调用。`);
        if (!fs.statSync(target).isDirectory() && !/\.html?$/i.test(target)) throw new Error('只能预览 .html 文件或包含 .html 的文件夹');
        const url = linkFor(target);
        return { content: [{ type: 'text', text: JSON.stringify({ ok: true, url }) }] };
      } catch (e) { return { content: [{ type: 'text', text: JSON.stringify({ ok: false, error: String(e?.message || e) }) }], isError: true }; }
    });
  const save_web_page = sdkTool('save_web_page',
    'Save a complete single-file web page (HTML with inline CSS/JS; CDN libraries are fine) and get its live preview link on this relay. ' +
    'Use the same name again to update the page: the link stays the same.',
    {
      name: z.string().describe('Short ASCII folder name, e.g. "solar-sizer"'),
      html: z.string().describe('The full HTML document, starting with <!doctype html>'),
    },
    async ({ name, html }) => {
      try {
        const slug = String(name || '').toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'page';
        const dir = path.join(config.workdir, 'web', slug);
        fs.mkdirSync(dir, { recursive: true });
        const file = path.join(dir, 'index.html');
        fs.writeFileSync(file, html);
        return { content: [{ type: 'text', text: JSON.stringify({ ok: true, file, url: linkFor(file) }) }] };
      } catch (e) { return { content: [{ type: 'text', text: JSON.stringify({ ok: false, error: String(e?.message || e) }) }], isError: true }; }
    });
  return createSdkMcpServer({ name: 'relay-web', version: '1.0.0', tools: [preview_link, save_web_page] });
}
const WEB_RULES = `Web pages and previews in this app:
- This conversation runs on the user's own relay site. To show a web page, HTML demo, prototype, landing page, form, calculator, dashboard or any interactive page, never use the Artifact tool or any claude.ai publishing (it is disabled here), and don't send the user claude.ai/artifact links.
- Instead, save the page inside the working directory ${config.workdir}, one folder per project (e.g. ${path.join(config.workdir, 'solar-sizer', 'index.html')} plus its css/js/images), not in a temp or scratchpad folder. Then call preview_link with the file or folder path and give the user the returned https://preview.… link. In Chat mode, use save_web_page (it saves and returns the link in one step).
- The page also appears as a preview card under your reply. Keep working in the same folder when the user asks for changes: the link stays the same and an open preview refreshes itself.`;

function chatSystemPrompt(forGuest = false) {
  const today = new Date().toLocaleDateString('zh-CN', { year: 'numeric', month: 'long', day: 'numeric', weekday: 'long' });
  return `You are Claude, an AI assistant made by Anthropic, talking with a user in a chat interface. Today is ${today}.

How to respond:
- Reply in the language the user writes in.
- Be a thoughtful conversation partner: warm, direct and genuinely helpful. Give your own view when asked, and say plainly when you are unsure or something is outside what you know.
- Match length to the question. Casual messages get short, natural replies; complex questions get thorough, well-organised answers. Don't pad, and don't repeat the question back.
- Write in natural prose by default. Use Markdown (headings, lists, tables, code blocks) when it genuinely helps readability, not for simple answers.
- For maths use LaTeX ($...$ inline, $$...$$ display). For code, use fenced code blocks with a language tag.
- This interface renders Mermaid: for flowcharts, sequence diagrams, mind maps, timelines and similar diagrams, write a \`\`\`mermaid code block and it is drawn as a picture. Quote node labels that contain spaces, punctuation or CJK brackets (A["标签（说明）"]). Don't fall back to ASCII art for diagrams.
- You are not a coding agent in this mode: don't offer to run commands or edit files, and don't mention tools, the working directory or the local machine unless the user asks.

Tools available to you:
- Web search and web fetch: use them when the question needs current or specific information you may not know, and cite the sources you used with links.
- Read: when the user attaches a file, its local path is given in the message; read it to answer about it. Don't read other files unless the user asks.
- Skills: if an installed skill clearly fits the request, use it.${IMAGE_TOOLS.length ? `
- Images: you can create and edit pictures with the generate_image tool (posters, illustrations, covers, photos, icons, edits of an uploaded image). Use it whenever the user asks you to draw, generate or modify an image; write a detailed prompt, look at the result, and the picture appears under your reply automatically. Don't claim you cannot make images.` : ''}
${forGuest ? '' : `
- Web pages: when the user wants a web page, demo, prototype or interactive tool, build it as one HTML file and save it with save_web_page, then share the preview link it returns.

${WEB_RULES}`}`;
}

// ---------- "my computer": Code mode on the user's own Mac / PC through the connector ----------
// Claude still runs here (this account, this quota); its built-in file and shell tools are switched off and replaced by
// these tools, which the connector runs on the user's computer. File access is fenced to the work folder by the connector
// itself; commands need the user's OK on the page unless they set that computer to "run directly".
const DEVICE_TOOLS = ['run_command', 'read_file', 'write_file', 'edit_file', 'list_dir', 'find_files', 'search_text', 'send_file_to_chat', 'put_attachment'].map((n) => 'mcp__device__' + n);
const xfers = new Map(); // nonce -> one file transfer between the relay and a device
const osLabel = (d) => (d.os === 'darwin' ? 'macOS' : d.os === 'win32' ? 'Windows' : d.os);
function deviceRules(d) {
  const win = d.os === 'win32';
  return `You are working on the USER'S OWN COMPUTER "${d.name}" (${osLabel(d)} ${d.arch || ''}, user "${d.user || ''}"), remotely, through the mcp__device__ tools. The machine this agent process runs on is a relay server, NOT the user's computer: never use local paths or local tools for the user's files.
- Work folder on that computer: ${d.root}. File tools (read_file, write_file, edit_file, list_dir, find_files, search_text) only work inside it; relative paths are relative to it. Put projects there.
- run_command runs one command in ${win ? 'Windows PowerShell 5.1 (use PowerShell syntax: Get-ChildItem, Copy-Item, `;` between commands, $env:VAR; quote paths with spaces)' : 'zsh on macOS (BSD userland, Homebrew paths are on PATH if installed)'}, starting in the work folder. ${d.policy === 'auto' ? 'Commands run directly.' : 'The user confirms each command on the web page first, so prefer the file tools for reading and writing files and keep commands purposeful.'} Commands must not need interactive input; avoid long-running servers unless asked (timeout max 600 s).
- Ask before deleting files, installing software or changing system settings on the user's computer.
- To give the user a file from their computer in the chat (so it can be previewed / downloaded), call send_file_to_chat. Files the user attached in this chat live on the relay, not on their computer: images are visible to you directly; call put_attachment to copy an attachment into the work folder when you need it there.
- Do not use claude.ai Artifacts.`;
}
// A PreToolUse gate for "my computer" turns: only the device tools and harmless helpers; nothing on the relay itself.
function deviceHooks() {
  const deny = (why) => ({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: why } });
  return { PreToolUse: [{ hooks: [async (input) => {
    const name = input.tool_name, args = input.tool_input || {};
    if (DEVICE_TOOLS.includes(name) || IMAGE_TOOLS.includes(name) || ['WebSearch', 'Skill', 'ToolSearch', 'TodoWrite'].includes(name)) return {};
    if (name === 'WebFetch') { let host = ''; try { host = new URL(String(args.url)).hostname; } catch {} return host && !LOCAL_HOST.test(host) ? {} : deny('不能访问中转站所在机器或内网地址'); }
    return deny(`在「我的电脑」模式下不能使用 ${name}，请用 mcp__device__ 工具操作用户的电脑`);
  }] }] };
}
// Asks on the page (the conversation's viewers, guests included) whether a command may run on their computer.
function askOnPage(convId, title, input, signal) {
  return new Promise((resolve) => {
    const reqId = crypto.randomUUID();
    const req = { reqId, convId, toolName: title, input, hasSuggestions: false, device: true };
    pendingPerms.set(reqId, { ...req, resolve: (r) => resolve(r?.behavior === 'allow') });
    broadcast({ type: 'perm_request', ...req });
    signal?.addEventListener('abort', () => { pendingPerms.delete(reqId); broadcast({ type: 'perm_resolved', reqId, convId, device: true }); resolve(false); });
  });
}
function deviceServer(conv, turn, dev, signal) {
  const call = (op, a, ms) => devices.call(dev.id, op, a, { timeoutMs: ms, signal });
  const text = (v) => ({ content: [{ type: 'text', text: typeof v === 'string' ? v : JSON.stringify(v, null, 1) }] });
  const err = (e) => ({ content: [{ type: 'text', text: String(e?.message || e) }], isError: true });
  const wrap = (fn) => async (a) => { try { return await fn(a); } catch (e) { return err(e); } };
  const tools = [
    sdkTool('run_command', `Run one command on the user's computer (${osLabel(dev)}, ${dev.os === 'win32' ? 'PowerShell' : 'zsh'}). Starts in the work folder unless cwd is given (relative to it). Returns exit code and combined output (max 100k chars).`,
      { command: z.string(), cwd: z.string().optional().describe('Folder inside the work folder'), timeout_seconds: z.number().int().min(1).max(600).optional() },
      wrap(async (a) => {
        const d = devices.get(dev.id) || dev;
        if (d.policy !== 'auto' && !(await askOnPage(conv.id, `在你的电脑「${d.name}」上执行命令`, { command: a.command, ...(a.cwd ? { cwd: a.cwd } : {}) }, signal))) return err('用户没有允许执行这条命令。');
        const r = await call('exec', { command: a.command, cwd: a.cwd, timeout: a.timeout_seconds || 120 }, ((a.timeout_seconds || 120) + 20) * 1000);
        return text(`exit code ${r.exitCode}${r.timedOut ? ' (timed out, stopped)' : ''} · ${r.seconds}s · cwd ${r.cwd}${r.truncated ? ' · output truncated' : ''}\n${r.output}`);
      })),
    sdkTool('read_file', 'Read a text file on the user\'s computer (inside the work folder). Lines are numbered.', { path: z.string(), offset: z.number().int().optional(), limit: z.number().int().optional() },
      wrap(async (a) => { const r = await call('read', a, 60_000); return text(r.binary ? `${r.path} is a binary file (${r.size} bytes); use send_file_to_chat to show it.` : `${r.path} (${r.totalLines} lines${r.truncated ? ', partial' : ''})\n${r.content}`); })),
    sdkTool('write_file', 'Create or overwrite a text file on the user\'s computer (inside the work folder; folders are created).', { path: z.string(), content: z.string() },
      wrap(async (a) => text(await call('write', a, 60_000)))),
    sdkTool('edit_file', 'Replace exact text in a file on the user\'s computer. old_string must be unique unless replace_all.', { path: z.string(), old_string: z.string(), new_string: z.string(), replace_all: z.boolean().optional() },
      wrap(async (a) => text(await call('edit', a, 60_000)))),
    sdkTool('list_dir', 'List a folder on the user\'s computer (default: the work folder).', { path: z.string().optional() },
      wrap(async (a) => text(await call('list', a, 60_000)))),
    sdkTool('find_files', 'Find files by glob pattern (e.g. "**/*.py") under a folder of the work folder.', { pattern: z.string(), path: z.string().optional() },
      wrap(async (a) => text(await call('glob', a, 120_000)))),
    sdkTool('search_text', 'Search file contents with a regular expression under a folder of the work folder.', { pattern: z.string(), path: z.string().optional(), glob: z.string().optional(), ignore_case: z.boolean().optional() },
      wrap(async (a) => text(await call('grep', a, 120_000)))),
    sdkTool('send_file_to_chat', 'Copy a file from the user\'s computer into this chat so they can preview / download it (documents, images, results). Max 200 MB.', { path: z.string() },
      wrap(async (a) => {
        const nonce = crypto.randomBytes(16).toString('hex');
        xfers.set(nonce, { kind: 'up', deviceId: dev.id, turn, expiresAt: Date.now() + 30 * 60_000 });
        try { const r = await call('upload', { path: a.path, url: `/connect/xfer/${nonce}` }, 30 * 60_000); return text(`已发送到对话：${r.name || a.path}（${r.bytes} 字节）`); }
        finally { xfers.delete(nonce); }
      })),
    sdkTool('put_attachment', 'Copy a file the user attached in this chat onto their computer (into the work folder). name = the attachment\'s file name.', { name: z.string(), path: z.string().optional().describe('Destination inside the work folder (default: its name)') },
      wrap(async (a) => {
        const att = conv.messages.flatMap((m) => m.attachments || []).reverse().find((x) => x.name === a.name || uploads[x.id]?.name === a.name);
        const u = att && uploads[att.id];
        if (!u || !fs.existsSync(u.path)) throw new Error('这个对话里没有叫这个名字的附件');
        const nonce = crypto.randomBytes(16).toString('hex');
        xfers.set(nonce, { kind: 'down', deviceId: dev.id, file: u.path, name: u.name, expiresAt: Date.now() + 30 * 60_000 });
        try { return text(await call('download', { url: `/connect/xfer/${nonce}`, path: a.path || u.name }, 30 * 60_000)); }
        finally { xfers.delete(nonce); }
      })),
  ];
  return createSdkMcpServer({ name: 'device', version: '1.0.0', tools });
}

// Public routes for the connector (no access key; each one checks its own credential):
//   POST /connect/pair            pairing code -> device token
//   GET  /connect/install.sh|ps1  one-line installers (macOS / Windows), with this server's address filled in
//   GET  /connect/bin/<file>      the connector executables (connector/dist, built by connector/build.mjs)
//   GET|POST /connect/xfer/<nonce> one file between the relay and a device (device token required)
const CONNECTOR_DIST = path.join(ROOT, 'connector', 'dist');
const binSums = new Map();
const INSTALL_SH = (s) => `#!/bin/bash
# Claude Relay connector installer for macOS. Usage: curl -fsSL ${s}/connect/install.sh | bash -s -- <pairing code>
set -e
SERVER="${s}"
CODE="\${1:-$RELAY_PAIR}"
DIR="$HOME/.claude-relay-connector"
case "$(uname -m)" in arm64) BIN=connector-mac-arm64 ;; x86_64) BIN=connector-mac-x64 ;; *) echo "不支持的处理器：$(uname -m)"; exit 1 ;; esac
mkdir -p "$DIR"
# Download only when the server has a different build than the one already here (codesign changes the file, so the
# server's hash of the installed build is remembered next to it).
SUM="$(curl -fsSL "$SERVER/connect/bin/$BIN.sha256" 2>/dev/null || true)"
if [ -x "$DIR/connector" ] && [ -n "$SUM" ] && [ "$SUM" = "$(cat "$DIR/connector.sha256" 2>/dev/null)" ]; then
  echo "连接器已是最新版本，无需重新下载。"
else
  echo "正在下载连接器…"
  rm -f "$DIR/connector.sha256"
  curl -fL --progress-bar "$SERVER/connect/bin/$BIN" -o "$DIR/connector.tmp"
  chmod +x "$DIR/connector.tmp"
  # The binary is not signed by a developer: give it the local ad-hoc signature macOS requires and drop any quarantine flag.
  codesign --force --sign - "$DIR/connector.tmp" >/dev/null 2>&1 || true
  xattr -d com.apple.quarantine "$DIR/connector.tmp" >/dev/null 2>&1 || true
  mv -f "$DIR/connector.tmp" "$DIR/connector"
  [ -n "$SUM" ] && echo "$SUM" > "$DIR/connector.sha256"
fi
echo ""
if [ -n "$CODE" ]; then exec "$DIR/connector" --server "$SERVER" --pair "$CODE" < /dev/tty; else exec "$DIR/connector" < /dev/tty; fi
`;
const INSTALL_PS1 = (s) => `# Claude Relay connector installer for Windows. Usage (PowerShell): $env:RELAY_PAIR='<code>'; irm ${s}/connect/install.ps1 | iex
$ErrorActionPreference = 'Stop'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
$server = '${s}'
$code = $env:RELAY_PAIR
$dir = Join-Path $env:LOCALAPPDATA 'ClaudeRelayConnector'
New-Item -ItemType Directory -Force $dir | Out-Null
$exe = Join-Path $dir 'connector.exe'
$ProgressPreference = 'SilentlyContinue'
$sum = try { (Invoke-WebRequest "$server/connect/bin/connector-win-x64.exe.sha256" -UseBasicParsing).Content.Trim() } catch { '' }
$have = if (Test-Path $exe) { (Get-FileHash $exe -Algorithm SHA256).Hash.ToLower() } else { '' }
if ($have -and $sum -and $have -eq $sum) {
  Write-Host 'The connector is up to date, no download needed.'
} else {
  Write-Host 'Downloading the connector...'
  Invoke-WebRequest "$server/connect/bin/connector-win-x64.exe" -OutFile "$exe.tmp" -UseBasicParsing
  try { Move-Item -Force "$exe.tmp" $exe } catch { Write-Host 'The connector is already running in another window: close that window first, then run this command again.'; return }
}
[Console]::OutputEncoding = [Text.Encoding]::UTF8
Remove-Item Env:RELAY_PAIR -ErrorAction SilentlyContinue
if ($code) { & $exe --server $server --pair $code } else { & $exe }
`;
async function handleConnect(req, res, url) {
  const p = url.pathname;
  if (p === '/connect/pair' && req.method === 'POST') {
    try { const r = devices.pair(await readBody(req)); broadcast({ type: 'devices' }); return json(res, 200, r); }
    catch (e) { return json(res, 400, { error: String(e?.message || e) }); }
  }
  if (p === '/connect/install.sh' || p === '/connect/install.ps1') {
    res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
    return res.end(p.endsWith('.sh') ? INSTALL_SH(config.publicUrl) : INSTALL_PS1(config.publicUrl));
  }
  const bin = p.match(/^\/connect\/bin\/(connector-(mac-arm64|mac-x64|win-x64\.exe))(\.sha256)?$/);
  if (bin) {
    const f = path.join(CONNECTOR_DIST, bin[1]);
    if (!fs.existsSync(f)) { res.writeHead(404); return res.end('connector not built yet'); }
    if (bin[3]) { // the build's SHA-256, so installers skip downloading a build they already have
      const st = fs.statSync(f), c = binSums.get(f);
      const sum = c && c.mtime === st.mtimeMs ? c.sum : crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
      binSums.set(f, { mtime: st.mtimeMs, sum });
      res.writeHead(200, { 'content-type': 'text/plain', 'cache-control': 'no-store' }); return res.end(sum);
    }
    return serveFile(req, res, f, bin[1], 'application/octet-stream', true);
  }
  const xm = p.match(/^\/connect\/xfer\/([0-9a-f]{32})$/);
  if (xm) {
    const x = xfers.get(xm[1]);
    const d = devices.byToken(req.headers['x-device-token']);
    if (!x || x.expiresAt < Date.now() || !d || d.id !== x.deviceId) return json(res, 403, { error: 'forbidden' });
    if (x.kind === 'down' && req.method === 'GET') return serveFile(req, res, x.file, x.name, 'application/octet-stream', true);
    if (x.kind === 'up' && req.method === 'POST') {
      const name = decodeURIComponent(req.headers['x-file-name'] || 'file').replace(/[\\/:*?"<>|\x00-\x1f]/g, '_').slice(-120) || 'file';
      const dir = path.join(config.workdir, 'device-files', d.id); fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, `${Date.now().toString(36)}-${name}`);
      let size = 0; const out = fs.createWriteStream(file);
      req.on('data', (c) => { size += c.length; if (size > 200 * 1024 * 1024) { req.destroy(); out.destroy(); fs.rmSync(file, { force: true }); } });
      req.pipe(out);
      out.on('finish', () => { (x.turn.deviceFiles ||= []).push({ name, path: file, size }); json(res, 200, { name, bytes: size }); });
      out.on('error', (e) => json(res, 500, { error: String(e) }));
      return;
    }
    return json(res, 405, {});
  }
  res.writeHead(404); res.end();
}

async function runTurn({ convId, text, attachments, quotes, quoteSrc, model, effort, permissionMode, mode, owner, pool, device }) {
  const guest = owner || null; // guest id when a sub-link user sends
  pool = guest || pool || ''; // tag for a new conversation: guest id, '@admin' (management link) or '' (old main link)
  // A guest gets Code mode only when the owner switched it on for them; it then runs without prompts (nobody on the
  // guest side can answer them) and its file tools are fenced to the guest's folder by guestHooks.
  // "My computer": the conversation runs on the user's own computer (checked by the caller: it is theirs).
  const dev = device ? devices.get(device) : null;
  if (dev) { mode = 'code'; permissionMode = 'bypassPermissions'; }
  const guestCode = !dev && !!guest && mode === 'code' && !!users.get(guest)?.code;
  if (guest && !dev) { mode = guestCode ? 'code' : 'chat'; permissionMode = guestCode ? 'bypassPermissions' : 'default'; }
  if (guestCode) fs.mkdirSync(guestDir(guest), { recursive: true });
  const chat = mode === 'chat';
  // quoteSrc[k] = index of the message quotes[k] was selected from (lets the page jump back to it).
  const pairs = (Array.isArray(quotes) ? quotes : []).map((q, k) => [String(q).slice(0, 8000), Array.isArray(quoteSrc) && Number.isInteger(quoteSrc[k]) && quoteSrc[k] >= 0 ? quoteSrc[k] : null])
    .filter(([q]) => q.trim()).slice(0, 10);
  quotes = pairs.map((p) => p[0]);
  quoteSrc = pairs.map((p) => p[1]);
  // The browser picks the id of a new conversation so it can follow it across reconnects.
  if (!/^[0-9a-f-]{36}$/.test(convId || '')) convId = crypto.randomUUID();
  // Built first (Word documents are converted here): nothing below may await before the turn is marked running.
  const userContent = await buildUserContent(text, attachments, quotes);
  let conv = loadConv(convId);
  if (!conv) {
    conv = { id: convId, title: (text || attachments?.[0]?.name || '新对话').slice(0, 40), createdAt: Date.now(), messages: [], sessionId: null, ...(pool ? { owner: pool } : {}) };
  }
  if ((conv.owner || null) !== guest && guest) return broadcast({ type: 'error', convId: conv.id, error: '这是共享给你的只读对话，不能在里面发消息。可以在回复下方点「分支」接着聊。' });
  if (running.has(conv.id)) return broadcast({ type: 'error', convId: conv.id, error: '该对话正在运行中' });
  conv.model = model; conv.effort = effort; conv.permissionMode = permissionMode; conv.mode = chat ? 'chat' : 'code'; conv.updatedAt = Date.now();
  conv.device = dev ? dev.id : null; // which computer this conversation last ran on (null = the relay's own computer)
  conv.messages.push({
    role: 'user', text, ...(quotes.length ? { quotes, quoteSrc } : {}),
    attachments: (attachments || []).map((a) => ({ id: a.id, name: a.name, type: a.type, size: a.size })),
  });
  const turn = { role: 'assistant', blocks: [], startedAt: Date.now() };
  conv.messages.push(turn);
  saveConv(conv);
  broadcast({ type: 'conv', conv });
  broadcast({ type: 'list' });

  const userMsg = { type: 'user', message: { role: 'user', content: userContent }, parent_tool_use_id: null, session_id: '' };
  async function* prompt() { yield userMsg; }

  const abortController = new AbortController();
  const devAbort = new AbortController(); // stops a command running on the user's computer (Stop button, end of turn)
  const q = query({
    prompt: prompt(),
    options: {
      cwd: config.workdir,
      model: model || undefined,
      effort: effort || undefined,
      resume: conv.sessionId || undefined,
      includePartialMessages: true,
      thinking: { type: 'adaptive', display: 'summarized' },
      skills: 'all',
      abortController,
      ...(dev
        // On the user's own computer: built-in file / shell tools off, the device tools instead (see deviceServer).
        ? { systemPrompt: { type: 'preset', preset: 'claude_code', append: deviceRules(dev) },
            tools: ['WebSearch', 'WebFetch', 'TodoWrite', 'Skill'], allowedTools: [...DEVICE_TOOLS, 'WebSearch', 'WebFetch', 'TodoWrite', 'Skill', ...IMAGE_TOOLS],
            permissionMode: 'bypassPermissions', allowDangerouslySkipPermissions: true, settingSources: ['user'], hooks: deviceHooks() }
        : guestCode
        // A guest in Code mode: Claude Code's agent, no prompts, file tools fenced to <workdir>/guests/<id> by the hook.
        ? { systemPrompt: { type: 'preset', preset: 'claude_code', append: `This user reaches you through a guest link. Their own folder is ${guestDir(guest)}: create and change files only there (cd into it before running commands), and use it as the place for every project. Files they attached are listed in their messages. Everything else on this computer belongs to someone else: do not read, list, change or delete anything outside that folder, even when asked. Do not use claude.ai Artifacts.` },
            permissionMode: 'bypassPermissions', allowDangerouslySkipPermissions: true, settingSources: ['user'], allowedTools: IMAGE_TOOLS, hooks: guestHooks(guest, true) }
        : guest
        // Guests: Chat tools only; Read is checked per call and limited to the guest's own uploads.
        ? { systemPrompt: chatSystemPrompt(true) + '\n\nThis user reaches you through a guest link: the Read tool works only for files they attached; never try to read other files on this computer.',
            tools: CHAT_TOOLS, allowedTools: ['WebSearch', 'WebFetch', 'Skill', ...IMAGE_TOOLS], permissionMode: 'default', settingSources: ['user'], hooks: guestHooks(guest) }
        : chat
        ? { systemPrompt: chatSystemPrompt(), tools: CHAT_TOOLS, allowedTools: [...CHAT_TOOLS, 'Skill', ...IMAGE_TOOLS, ...WEB_TOOLS], permissionMode: 'dontAsk', settingSources: ['user'] }
        // Code mode keeps Claude Code's own system prompt and adds this relay's rules (web pages go to the preview domain).
        : { systemPrompt: { type: 'preset', preset: 'claude_code', append: WEB_RULES },
            permissionMode: permissionMode || 'default', allowDangerouslySkipPermissions: permissionMode === 'bypassPermissions', settingSources: ['user', 'project', 'local'], allowedTools: [...IMAGE_TOOLS, ...WEB_TOOLS] }),
      disallowedTools: BLOCKED_TOOLS,
      mcpServers: { ...(IMAGE_TOOLS.length ? { 'image-gen': imageServer(conv.id, turn, guest) } : {}), ...(guest || dev ? {} : { 'relay-web': webServer() }),
        ...(dev ? { device: deviceServer(conv, turn, dev, devAbort.signal) } : {}) },
      canUseTool: dev ? undefined : guest ? async (toolName, input) => (toolName === 'Read' && guestMayRead(guest, input?.file_path)
          ? { behavior: 'allow', updatedInput: input }
          : { behavior: 'deny', message: toolName === 'Read' ? '访客只能读取自己上传的文件' : `访客不能使用 ${toolName}` })
        : chat || permissionMode === 'bypassPermissions' ? undefined : (toolName, input, { signal, suggestions }) => new Promise((resolve) => {
        const reqId = crypto.randomUUID();
        const req = { reqId, convId: conv.id, toolName, input, hasSuggestions: !!suggestions?.length };
        pendingPerms.set(reqId, { ...req, suggestions, resolve });
        broadcast({ type: 'perm_request', ...req });
        signal.addEventListener('abort', () => { pendingPerms.delete(reqId); resolve({ behavior: 'deny', message: 'aborted' }); });
      }),
    },
  });
  running.set(conv.id, { q, abortController, turn, devAbort });

  let base = 0; // block offset for the current API message within this turn
  let lastPush = 0;
  const push = (force) => {
    const now = Date.now();
    if (!force && now - lastPush < 80) return;
    lastPush = now;
    broadcast({ type: 'turn', convId: conv.id, blocks: turn.blocks });
  };

  try {
    for await (const m of q) {
      // Last transcript entry of this turn: a branch from this reply forks the session up to here.
      if ((m.type === 'assistant' || m.type === 'user') && !m.parent_tool_use_id && m.uuid && !m.isReplay) { turn.lastUuid = m.uuid; turn.sessionId = m.session_id; }
      if (m.type === 'system' && m.subtype === 'init') {
        conv.sessionId = m.session_id;
        conv.resolvedModel = m.model;
      } else if (m.type === 'stream_event' && !m.parent_tool_use_id) {
        const e = m.event;
        if (e.type === 'message_start') base = turn.blocks.length;
        else if (e.type === 'content_block_start') {
          const b = e.content_block;
          if (b.type === 'text') turn.blocks[base + e.index] = { type: 'text', text: b.text || '' };
          else if (b.type === 'thinking') turn.blocks[base + e.index] = { type: 'thinking', text: b.thinking || '' };
          else if (b.type === 'tool_use') turn.blocks[base + e.index] = { type: 'tool', id: b.id, name: b.name, inputJson: '', input: null };
        } else if (e.type === 'content_block_delta') {
          const blk = turn.blocks[base + e.index];
          if (!blk) continue;
          if (e.delta.type === 'text_delta') blk.text += e.delta.text;
          else if (e.delta.type === 'thinking_delta') blk.text += e.delta.thinking;
          else if (e.delta.type === 'input_json_delta') blk.inputJson += e.delta.partial_json;
        } else if (e.type === 'content_block_stop') {
          const blk = turn.blocks[base + e.index];
          if (blk?.type === 'tool') { try { blk.input = JSON.parse(blk.inputJson || '{}'); } catch { blk.input = blk.inputJson; } }
        }
        push(false);
      } else if (m.type === 'assistant' && !m.parent_tool_use_id) {
        // Complete message: make sure tool inputs are authoritative.
        for (const b of m.message.content) {
          if (b.type !== 'tool_use') continue;
          const blk = turn.blocks.find((x) => x?.type === 'tool' && x.id === b.id);
          if (blk) blk.input = b.input; else turn.blocks.push({ type: 'tool', id: b.id, name: b.name, input: b.input });
        }
        push(true);
      } else if (m.type === 'user' && !m.parent_tool_use_id && Array.isArray(m.message?.content)) {
        for (const b of m.message.content) {
          if (b.type !== 'tool_result') continue;
          const blk = turn.blocks.find((x) => x?.type === 'tool' && x.id === b.tool_use_id);
          if (!blk) continue;
          const c = Array.isArray(b.content) ? b.content.map((x) => (x.type === 'text' ? x.text : `[${x.type}]`)).join('\n') : String(b.content ?? '');
          blk.result = c.length > 20000 ? c.slice(0, 20000) + '\n…(已截断)' : c;
          blk.isError = !!b.is_error;
        }
        push(true);
      } else if (m.type === 'rate_limit_event') {
        const info = m.rate_limit_info;
        liveRateLimits[info.rateLimitType || 'unknown'] = { ...info, at: Date.now() };
        try { noteWeekly(info); } catch {}
        broadcast({ type: 'rate_limit', info });
      } else if (m.type === 'result') {
        turn.result = { subtype: m.subtype, cost: m.total_cost_usd, durationMs: m.duration_ms, isError: m.is_error, usage: m.usage };
        if (m.is_error && m.result) turn.blocks.push({ type: 'error', text: m.result });
        else if (m.subtype !== 'success') turn.blocks.push({ type: 'error', text: (m.errors || [m.subtype]).join('\n') });
      }
    }
    // Refresh model / skill lists from the live session.
    try { models = await q.supportedModels(); } catch {}
    try { const cs = await q.supportedCommands(); if (cs?.length) commands = cs.filter((c) => !c.builtin); } catch {}
  } catch (err) {
    if (turn.blocks.some((b) => b?.type === 'error')) { /* already reported via the result message */ }
    else if (!abortController.signal.aborted) turn.blocks.push({ type: 'error', text: String(err?.message || err) });
    else turn.blocks.push({ type: 'error', text: '已停止' });
  } finally {
    turn.blocks = turn.blocks.filter(Boolean).map((b) => { if (b.type === 'tool') delete b.inputJson; return b; });
    turn.done = true;
    try { turn.files = detectFiles(turn, { workdir: config.workdir, uploadDir: UPLOAD_DIR, from: turn.startedAt, to: Date.now() }); addPreviews(turn.files); } catch { turn.files ||= []; }
    // A guest's reply lists only the pictures its own image calls made (the outputs folder is shared with the owner)
    // and, in Code mode, files in the guest's own folder (web pages there keep a preview link scoped to that folder).
    if (guest) {
      const mine = new Set(turn.blocks.flatMap((b) => (b.images || []).map((im) => path.resolve(im.path).toLowerCase())));
      turn.files = (turn.files || []).filter((f) => mine.has(path.resolve(f.path).toLowerCase()) || (guestCode && inside(f.path, guestDir(guest))))
        .map((f) => (guestCode && inside(f.path, guestDir(guest)) ? f : { ...f, preview: undefined }));
    }
    // On the user's own computer: list what send_file_to_chat brought over (and generated pictures), not paths on this server.
    if (dev) {
      const pics = new Set(turn.blocks.flatMap((b) => (b.images || []).map((im) => path.resolve(im.path).toLowerCase())));
      turn.files = [...(turn.files || []).filter((f) => pics.has(path.resolve(f.path).toLowerCase())), ...(turn.deviceFiles || [])];
    }
    delete turn.deviceFiles;
    devAbort.abort();
    running.delete(conv.id);
    for (const [id, p] of pendingPerms) if (p.convId === conv.id) { pendingPerms.delete(id); broadcast({ type: 'perm_resolved', reqId: id }); }
    conv.updatedAt = Date.now();
    saveConv(conv);
    broadcast({ type: 'conv', conv });
    broadcast({ type: 'list' });
    usageCache = null;
    broadcast({ type: 'usage_stale' });
    if (!conv.titled && turn.blocks.some((b) => b.type === 'text')) autoTitle(conv.id);
  }
}

// ---------- branches ----------
// A branch from reply #index copies the visible messages up to that reply into a new conversation and
// forks the Claude session at the same point (SDK forkSession), so the branch keeps the full context.
const isPrompt = (e) => e.type === 'user' && !e.parent_tool_use_id &&
  (typeof e.message?.content === 'string' || (Array.isArray(e.message?.content) && !e.message.content.some((b) => b.type === 'tool_result')));
async function branchConv(srcId, index, owner = null) {
  const src = loadConv(srcId);
  if (!src) throw new Error('对话不存在');
  if (running.has(srcId) && index >= src.messages.length - 1) throw new Error('这条回复还在生成中');
  const turn = src.messages[index];
  if (!turn || turn.role !== 'assistant') throw new Error('只能从 Claude 的回复处分支');
  let sessionId = null;
  const from = turn.sessionId || src.sessionId;
  if (from) {
    let upTo = turn.lastUuid;
    if (!upTo) {
      // Older replies have no recorded uuid: find the end of turn k in the transcript (entry before prompt k+1).
      const k = src.messages.slice(0, index).filter((x) => x.role === 'user').length; // 1-based turn number
      const entries = await getSessionMessages(from, { dir: config.workdir });
      let seen = 0;
      for (let i = 0; i < entries.length; i++) {
        if (!isPrompt(entries[i])) continue;
        seen++;
        if (seen === k + 1) { upTo = entries[i - 1]?.uuid; break; }
      }
      // No later prompt: the reply is the last turn, so copy the whole session.
    }
    sessionId = (await forkSession(from, { dir: config.workdir, ...(upTo ? { upToMessageId: upTo } : {}) })).sessionId;
  }
  const conv = {
    id: crypto.randomUUID(), title: `${src.title || '对话'} · 分支`, titled: true,
    createdAt: Date.now(), updatedAt: Date.now(), sessionId,
    model: src.model, effort: src.effort, permissionMode: src.permissionMode, mode: src.mode,
    branchOf: { convId: src.id, title: src.title, index }, ...(owner ? { owner } : {}),
    messages: JSON.parse(JSON.stringify(src.messages.slice(0, index + 1))),
  };
  saveConv(conv);
  broadcast({ type: 'list' });
  return conv;
}

// ---------- HTTP ----------
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png' };
const json = (res, code, body) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
const readBody = (req) => new Promise((r) => { let s = ''; req.on('data', (d) => (s += d)); req.on('end', () => r(s ? JSON.parse(s) : {})); });

// previewAliases: older preview domains whose links are still stored in conversations.
const PREVIEW_HOSTS = new Set([config.previewUrl, ...(config.previewAliases || [])].map((u) => new URL(u).host.toLowerCase()));
// preview.localhost:<port> also counts (browsers resolve *.localhost to this PC): lets previews be tested locally.
const isPreviewHost = (req) => { const h = String(req.headers.host || '').toLowerCase(); return PREVIEW_HOSTS.has(h) || /^preview\.localhost(:\d+)?$/.test(h); };
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  // The preview host serves preview pages and nothing else (no API, no app, no WebSocket).
  if (isPreviewHost(req)) {
    if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); return res.end(); }
    try { if (await handleShare(req, res, url)) return; return previews.handle(req, res, url.pathname); } catch (e) { res.writeHead(500); return res.end(String(e?.message || e)); }
  }
  if (url.pathname.startsWith('/connect/')) return handleConnect(req, res, url);
  if (url.pathname.startsWith('/api/')) {
    const who = authUser(req);
    if (!who) return json(res, 401, { error: 'unauthorized' });
    // Guests reach only these routes (each one below also checks the guest may see / change that conversation).
    if (!isOwner(who)) {
      const p = url.pathname;
      // Share and guest management belong to the management link only.
      if (/^\/api\/(users|shares|owner)(\/|$)/.test(p)) return json(res, 403, { error: '这个链接不能使用管理功能' });
      // Guests reach only these routes.
      if (isGuest(who)) {
        users.touch(who.id);
        const ok = ['/api/meta', '/api/conversations', '/api/usage', '/api/upload', '/api/client-log'].includes(p)
          || /^\/api\/files\/[0-9a-f-]{36}$/.test(p)
          || /^\/api\/conversations\/[\w-]+(\/(zip|branch|img\/[\w-]+\/\d+|out\/\d+\/\d+))?$/.test(p)
          || /^\/api\/devices(\/pair-code|\/[0-9a-f]{12}(\/root)?)?$/.test(p);
        if (!ok) return json(res, 403, { error: '访客链接不能使用这个功能' });
      }
      // Guests and the old main link: only conversations they may see / change.
      const cm = p.match(/^\/api\/conversations\/([\w-]+)/);
      if (cm && !canSee(who, cm[1]) && !(p === `/api/conversations/${cm[1]}` && req.method === 'GET' && !loadConv(cm[1]))) return json(res, 404, {});
      if (cm && (req.method === 'DELETE' || req.method === 'PATCH') && !canEdit(who, cm[1])) return json(res, 403, { error: '共享给你的对话不能修改或删除' });
    }
    // ---- "my computer": every link manages its own connected computers (the management link sees all) ----
    if (url.pathname.startsWith('/api/devices')) {
      const mayConnect = !isGuest(who) || users.get(who.id)?.devices !== false;
      const mineDev = (d) => d && (isOwner(who) || d.owner === poolOf(who));
      if (url.pathname === '/api/devices' && req.method === 'GET')
        return json(res, 200, { allowed: mayConnect, devices: devices.list(isOwner(who) ? undefined : poolOf(who)).map((d) => ({ ...d, ...(isOwner(who) && d.owner !== ADMIN_POOL ? { ownerNote: ownerLabel(d.owner) } : {}) })), server: config.publicUrl });
      if (url.pathname === '/api/devices/pair-code' && req.method === 'POST') {
        if (!mayConnect) return json(res, 403, { error: '链接的主人没有允许你连接自己的电脑' });
        const { code, expiresAt } = devices.newCode(poolOf(who));
        const s = config.publicUrl;
        return json(res, 200, { code, expiresAt, server: s,
          commands: { mac: `curl -fsSL ${s}/connect/install.sh | bash -s -- ${code}`, win: `$env:RELAY_PAIR='${code}'; irm ${s}/connect/install.ps1 | iex` },
          reconnect: { mac: `curl -fsSL ${s}/connect/install.sh | bash`, win: `irm ${s}/connect/install.ps1 | iex` } });
      }
      const rm = url.pathname.match(/^\/api\/devices\/([0-9a-f]{12})\/root$/);
      if (rm && req.method === 'POST') { // switch the work folder: the connector checks and applies it
        const d = devices.get(rm[1]); if (!mineDev(d)) return json(res, 404, {});
        if (!d.online) return json(res, 409, { error: '这台电脑现在离线，先在那台电脑上打开连接器再切换' });
        try {
          const r = await devices.call(d.id, 'setroot', { root: (await readBody(req)).root }, { timeoutMs: 20_000 });
          const nd = devices.setRoot(d.id, r.root); broadcast({ type: 'devices' }); return json(res, 200, nd);
        } catch (e) {
          const m = String(e?.message || e);
          return json(res, 400, { error: /未知操作/.test(m) ? '这台电脑上的连接器版本太旧，不支持在网页上切换：关掉连接器窗口，运行卡片上的「重新连接」命令（会自动更新），再来切换' : m });
        }
      }
      const dm = url.pathname.match(/^\/api\/devices\/([0-9a-f]{12})$/);
      if (dm) {
        const d = devices.get(dm[1]); if (!mineDev(d)) return json(res, 404, {});
        if (req.method === 'PATCH') return json(res, 200, devices.update(d.id, await readBody(req)));
        if (req.method === 'DELETE') { devices.remove(d.id); broadcast({ type: 'devices' }); return json(res, 200, {}); }
      }
      return json(res, 404, {});
    }
    // ---- owner only: guest sub-links ----
    if (url.pathname === '/api/users' && req.method === 'GET') {
      const convs = allConvs();
      return json(res, 200, {
        users: users.list().map((u) => ({ ...u, url: `${config.publicUrl}/?k=${u.key}`, usage: guestUsage(u.id, convs), convCount: convs.filter((c) => c.owner === u.id).length })),
        quota: { ...users.meta(), weekStart: weekStart() },
        convs: convs.filter((c) => !c.owner || c.owner === ADMIN_POOL).sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0)).map((c) => ({ id: c.id, title: c.title, updatedAt: c.updatedAt })),
      });
    }
    if (url.pathname === '/api/users' && req.method === 'POST') { const u = users.create(await readBody(req)); return json(res, 200, { ...u, url: `${config.publicUrl}/?k=${u.key}` }); }
    if (url.pathname === '/api/users/quota' && req.method === 'PATCH') { users.setMeta(await readBody(req)); return json(res, 200, users.meta()); }
    const um = url.pathname.match(/^\/api\/users\/([0-9a-f]{12})(\/rotate)?$/);
    if (um) {
      const kick = (id) => { for (const ws of clients) if (ws.who?.id === id) ws.close(); }; // closed sockets re-authenticate with the new state
      if (req.method === 'PATCH') { const u = users.update(um[1], await readBody(req)); if (!u) return json(res, 404, {}); kick(u.id); broadcast({ type: 'list' }); return json(res, 200, u); }
      if (req.method === 'POST' && um[2]) { const u = users.rotate(um[1]); if (!u) return json(res, 404, {}); kick(u.id); return json(res, 200, { ...u, url: `${config.publicUrl}/?k=${u.key}` }); }
      if (req.method === 'DELETE') { kick(um[1]); return json(res, users.remove(um[1]) ? 200 : 404, {}); }
    }
    // Replace the management link (e.g. if it leaked): the old one stops working at once. The original main link
    // (accessKey) is left alone on purpose.
    if (url.pathname === '/api/owner/rotate-key' && req.method === 'POST') {
      config.adminKey = crypto.randomBytes(24).toString('base64url');
      const disk = readJson(CONFIG_FILE); disk.adminKey = config.adminKey; fs.writeFileSync(CONFIG_FILE, JSON.stringify(disk, null, 2));
      setTimeout(() => { for (const ws of clients) if (isOwner(ws.who)) ws.close(); }, 300);
      return json(res, 200, { url: `${config.publicUrl}/?k=${config.adminKey}` });
    }
    if (url.pathname === '/api/previews' && req.method === 'GET')
      return json(res, 200, { base: config.previewUrl, sites: previews.listSites().map((s) => ({ ...s, url: previews.link(config.previewUrl, s.dir) })) });
    if (url.pathname === '/api/previews' && req.method === 'POST') {
      try { const b = await readBody(req); return json(res, 200, { url: previews.link(config.previewUrl, path.resolve(config.workdir, String(b.path || ''))) }); }
      catch (e) { return json(res, 400, { error: String(e?.message || e) }); }
    }
    // Share links: list / create or refresh ({convId} for a relay conversation, {sessionId} for a Claude Code session) / revoke.
    if (url.pathname === '/api/shares' && req.method === 'GET') {
      const convId = url.searchParams.get('convId');
      return json(res, 200, convId ? { share: shares.find('relay:' + convId) } : shares.list());
    }
    if (url.pathname === '/api/shares' && req.method === 'POST') {
      try {
        const b = await readBody(req);
        if (b.convId) {
          const c = loadConv(String(b.convId)); if (!c) return json(res, 404, { error: '对话不存在' });
          if (running.has(c.id)) return json(res, 409, { error: '这个对话还在回复中，等它结束再分享' });
          backfillFiles(c);
          return json(res, 200, shares.shareRelay(c, { uploads, livePath }));
        }
        if (b.sessionId) return json(res, 200, shares.shareSession(String(b.sessionId).trim(), Array.isArray(b.extras) ? { extras: b.extras } : {}));
        return json(res, 400, { error: '缺少 convId 或 sessionId' });
      } catch (e) { return json(res, 400, { error: String(e?.message || e) }); }
    }
    const sd = url.pathname.match(/^\/api\/shares\/([\w-]{12,40})$/);
    if (sd && req.method === 'DELETE') return json(res, shares.remove(sd[1]) ? 200 : 404, {});
    // Pause / resume ({enabled}) and validity ({expiresAt}: ms timestamp, or null = never expires).
    if (sd && req.method === 'PATCH') {
      const b = await readBody(req);
      const r = shares.setState(sd[1], { enabled: b.enabled, expiresAt: b.expiresAt === null ? null : b.expiresAt === undefined ? undefined : Number(b.expiresAt) });
      return r ? json(res, 200, r) : json(res, 404, { error: '分享不存在' });
    }
    // Refresh the snapshot with the conversation's current content (same link).
    const sr = url.pathname.match(/^\/api\/shares\/([\w-]{12,40})\/refresh$/);
    if (sr && req.method === 'POST') {
      const s = shares.get(sr[1]); if (!s) return json(res, 404, { error: '分享不存在' });
      try {
        const [kind, id] = [s.source.slice(0, s.source.indexOf(':')), s.source.slice(s.source.indexOf(':') + 1)];
        if (kind === 'cc') return json(res, 200, shares.shareSession(id));
        const c = loadConv(id); if (!c) return json(res, 404, { error: '原对话已被删除，无法更新（旧快照仍可访问）' });
        if (running.has(c.id)) return json(res, 409, { error: '这个对话还在回复中，等它结束再更新' });
        backfillFiles(c);
        return json(res, 200, shares.shareRelay(c, { uploads, livePath }));
      } catch (e) { return json(res, 400, { error: String(e?.message || e) }); }
    }
    const ps = url.pathname.match(/^\/api\/previews\/([\w-]{8,})\/stamp$/);
    if (ps) return json(res, 200, { stamp: previews.stamp(ps[1]) });
    const m = url.pathname.match(/^\/api\/conversations\/([\w-]+)$/);
    if (url.pathname === '/api/meta') return json(res, 200, !isGuest(who)
      ? { role: who.role, models, commands, workdir: config.workdir, previewUrl: config.previewUrl }
      : { role: 'guest', note: users.get(who.id)?.note, code: !!users.get(who.id)?.code, models, commands });
    if (url.pathname === '/api/conversations') return json(res, 200, listConvs(who));
    // A guest sees only their own allowance for this week, never the owner's account details.
    if (url.pathname === '/api/usage' && isGuest(who)) return json(res, 200, { guest: guestUsage(who.id) });
    if (url.pathname === '/api/usage') {
      const refresh = url.searchParams.has('refresh');
      let plan = null, error = null, codex = null;
      const cx = codexUsage(refresh).then((d) => (codex = d), (e) => (codex = { error: String(e?.message || e) }));
      try { plan = await fetchUsage(refresh); } catch (e) { error = String(e?.message || e); }
      await cx;
      return json(res, 200, { plan, error, codex, live: liveRateLimits, local: localStats() });
    }
    if (url.pathname === '/api/upload' && req.method === 'POST') return saveUpload(req, res, who);
    // Errors the page hits while drawing (e.g. a Mermaid diagram that would not render), kept for diagnosis.
    if (url.pathname === '/api/client-log' && req.method === 'POST') {
      try {
        const b = await readBody(req);
        const line = JSON.stringify({ at: new Date().toISOString(), ...b, ua: String(req.headers['user-agent'] || '').slice(0, 200) }).slice(0, 6000);
        fs.mkdirSync(path.join(DATA, 'logs'), { recursive: true });
        fs.appendFileSync(path.join(DATA, 'logs', 'client.log'), line + '\n');
      } catch {}
      return json(res, 200, {});
    }
    const f = url.pathname.match(/^\/api\/files\/([0-9a-f-]{36})$/);
    if (f) { // a file the user uploaded (?dl=1: download instead of opening in the browser)
      const u = uploads[f[1]];
      if (!u || !fs.existsSync(u.path)) return json(res, 404, {});
      if (isGuest(who) && !guestUploads(who.id).some((x) => x.id === u.id)) return json(res, 404, {});
      if (who.role === 'legacy' && u.owner) return json(res, 404, {}); // the old link: only uploads from its own pool
      return serveFile(req, res, u.path, u.name, u.type, url.searchParams.has('dl'));
    }
    const zp = url.pathname.match(/^\/api\/conversations\/([\w-]+)\/zip$/);
    if (zp) { // "download all": the conversation's files as one .zip (which=out: made by Claude, up: uploaded, all: both)
      const c = loadConv(zp[1]); if (!c) return json(res, 404, {});
      const live = running.get(c.id); if (live && c.messages.at(-1)?.role === 'assistant') c.messages[c.messages.length - 1] = live.turn;
      const which = url.searchParams.get('which') || 'all';
      const rebase = livePath;
      const seen = new Set(), names = new Set(), entries = [];
      const add = (p, name, dir) => {
        p = rebase(p); if (!p || seen.has(p.toLowerCase()) || !fs.existsSync(p)) return;
        seen.add(p.toLowerCase());
        let n = (which === 'all' ? dir + '/' : '') + name, k = 2;
        while (names.has(n.toLowerCase())) { const e = path.extname(name); n = (which === 'all' ? dir + '/' : '') + `${path.basename(name, e)} (${k++})${e}`; }
        names.add(n.toLowerCase()); entries.push({ name: n, path: p });
      };
      for (const m of c.messages) {
        if (m.role === 'assistant' && which !== 'up') {
          for (const b of m.blocks || []) for (const im of b?.images || []) add(im.path, im.name, '生成的文件');
          for (const f of m.files || []) add(f.path, f.name, '生成的文件');
        }
        if (m.role === 'user' && which !== 'out') for (const a of m.attachments || []) { const u = uploads[a.id]; if (u) add(u.path, u.name, '上传的文件'); }
      }
      if (!entries.length) return json(res, 404, { error: '没有可下载的文件' });
      const zipName = `${String(c.title || '对话').replace(/[\\/:*?"<>|]+/g, '_').slice(0, 40)}-${which === 'up' ? '上传的文件' : which === 'out' ? '生成的文件' : '全部文件'}.zip`;
      res.writeHead(200, { 'content-type': 'application/zip', 'cache-control': 'no-store', 'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(zipName)}` });
      try { await writeZip(res, entries); } catch (e) { res.destroy(e); }
      return;
    }
    const gi = url.pathname.match(/^\/api\/conversations\/([\w-]+)\/img\/([\w-]+)\/(\d+)$/);
    if (gi) { // a picture made by one generate_image call (available as soon as it is drawn, before the reply ends)
      const live = running.get(gi[1]);
      const msgs = live ? [live.turn] : (loadConv(gi[1])?.messages || []);
      let file = null;
      for (const m of msgs) for (const b of m?.blocks || []) if (b?.id === gi[2]) {
        let list = b.images;
        if (!list) { try { list = (JSON.parse(String(b.result).trim().split('\n')[0]).files || []).map((p) => ({ name: path.basename(p), path: p })); } catch { list = []; } }
        file = list[+gi[3]];
      }
      if (file) file = { ...file, path: livePath(file.path) };
      if (!file || !fs.existsSync(file.path)) return json(res, 404, { error: '图片不存在' });
      return serveFile(req, res, file.path, file.name, mimeOf(file.name), url.searchParams.has('dl'));
    }
    const o = url.pathname.match(/^\/api\/conversations\/([\w-]+)\/out\/(\d+)\/(\d+)$/);
    if (o) { // a file Claude produced in reply #turn of this conversation
      const c = loadConv(o[1]);
      const file = c?.messages[+o[2]]?.files?.[+o[3]];
      // Restored on another machine: a path inside the old workdir now lives in this machine's workdir.
      const p = livePath(file?.path);
      if (!p || !fs.existsSync(p)) return json(res, 404, { error: '文件不存在（可能已被移动或删除）' });
      return serveFile(req, res, p, file.name, mimeOf(file.name), url.searchParams.has('dl'));
    }
    const br = url.pathname.match(/^\/api\/conversations\/([\w-]+)\/branch$/);
    if (br && req.method === 'POST') {
      // A guest's branch (also from a conversation shared with them) becomes the guest's own conversation.
      try { const b = await readBody(req); return json(res, 200, await branchConv(br[1], Number(b.index), poolOf(who) || null)); }
      catch (e) { return json(res, 400, { error: String(e?.message || e) }); }
    }
    if (m && req.method === 'GET') {
      const c = loadConv(m[1]);
      if (!c) return json(res, 404, {});
      if (backfillFiles(c)) saveConv(c);
      // While a turn is running, the file on disk is stale: substitute the live, in-memory turn.
      const r = running.get(c.id);
      if (r && c.messages.at(-1)?.role === 'assistant') c.messages[c.messages.length - 1] = r.turn;
      if (isGuest(who)) { delete c.sessionId; for (const x of c.messages) { delete x.lastUuid; delete x.sessionId; } }
      return json(res, 200, { ...c, running: !!r, ...(canEdit(who, c.id) ? {} : { readOnly: true }),
        ...(isOwner(who) && c.owner !== ADMIN_POOL ? { ownerNote: ownerLabel(c.owner), ownerKind: c.owner ? 'guest' : 'legacy' } : {}) });
    }
    if (m && req.method === 'DELETE') { running.get(m[1])?.abortController.abort(); fs.rmSync(convPath(m[1]), { force: true }); convOwner.delete(m[1]); broadcast({ type: 'list' }); return json(res, 200, {}); }
    if (m && req.method === 'PATCH') { const c = loadConv(m[1]); const b = await readBody(req); if (c && b.title) { c.title = b.title; c.titled = true; saveConv(c); } broadcast({ type: 'list' }); return json(res, 200, {}); }
    return json(res, 404, {});
  }
  const file = path.join(ROOT, 'public', url.pathname === '/' ? 'index.html' : path.normalize(url.pathname));
  if (!file.startsWith(path.join(ROOT, 'public')) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404); return res.end('not found');
  }
  res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-cache' });
  fs.createReadStream(file).pipe(res);
});

const wss = new WebSocketServer({ noServer: true, maxPayload: 4 * 1024 * 1024 });
// Cloudflare drops a WebSocket after ~100 s without data, so send an application-level heartbeat.
setInterval(() => { broadcast({ type: 'ping', t: Date.now() }); devices.ping(); }, 25_000);
const seenSends = new Set(); // client message ids, so a resend after reconnect is not run twice
// The connector's channel: authenticated by its device token (header, or the first "hello" message).
const connWss = new WebSocketServer({ noServer: true, maxPayload: 8 * 1024 * 1024 });
connWss.on('connection', (ws, req) => {
  let dev = devices.byToken(req.headers['x-device-token']);
  const timer = setTimeout(() => { if (!dev) ws.close(4401, 'no token'); }, 10_000);
  const onFirst = (raw) => {
    let m; try { m = JSON.parse(raw); } catch { return; }
    if (m.type !== 'hello') return;
    ws.off('message', onFirst); clearTimeout(timer);
    dev = dev || devices.byToken(m.token);
    if (!dev) return ws.close(4401, 'bad token');
    devices.attach(dev.id, ws, m, () => broadcast({ type: 'devices' }));
  };
  ws.on('message', onFirst);
});
server.on('upgrade', (req, socket, head) => {
  if (!isPreviewHost(req) && new URL(req.url, 'http://x').pathname === '/connector') { connWss.handleUpgrade(req, socket, head, (ws) => connWss.emit('connection', ws, req)); return; }
  const who = isPreviewHost(req) || new URL(req.url, 'http://x').pathname !== '/ws' ? null : authUser(req);
  if (!who) { socket.destroy(); return; }
  wss.handleUpgrade(req, socket, head, (ws) => { ws.who = who; wss.emit('connection', ws); });
});
wss.on('connection', (ws) => {
  clients.add(ws);
  ws.on('close', () => clients.delete(ws));
  const guest = isGuest(ws.who);
  const fail = (convId, error) => ws.send(JSON.stringify({ type: 'error', convId, error }));
  // Re-send pending permission prompts to a newly connected client (never to guests; only for conversations it can see).
  // Guests only get prompts about commands on their own computer.
  for (const p of pendingPerms.values()) if ((!guest || p.device) && canSee(ws.who, p.convId)) ws.send(JSON.stringify({ type: 'perm_request', reqId: p.reqId, convId: p.convId, toolName: p.toolName, input: p.input, hasSuggestions: p.hasSuggestions, device: p.device }));
  ws.on('message', (raw) => {
    let msg; try { msg = JSON.parse(raw); } catch { return; }
    if (msg.type === 'ping') return;
    // A guest whose link was switched off or deleted is cut off at once.
    if (guest && !users.get(ws.who.id)?.enabled) { fail(msg.convId, '这个访客链接已被停用'); return ws.close(); }
    if (msg.type === 'send') {
      ws.send(JSON.stringify({ type: 'ack', clientId: msg.clientId }));
      if (msg.clientId) { if (seenSends.has(msg.clientId)) return; seenSends.add(msg.clientId); }
      // Nobody may post into a conversation that isn't theirs (the old link into the management link's, a guest into a shared one…).
      if (msg.convId && convOwner.has(msg.convId) && !canEdit(ws.who, msg.convId))
        return fail(msg.convId, guest ? '这是共享给你的只读对话，不能在里面发消息。可以在回复下方点「分支」接着聊。' : '不能在这个对话里发消息');
      if (!guest && (msg.attachments || []).some((a) => ws.who.role === 'legacy' && uploads[a.id]?.owner)) return fail(msg.convId, '附件无效，请重新上传');
      if (guest) {
        const id = ws.who.id;
        if (msg.convId && convOwner.has(msg.convId) && convOwner.get(msg.convId) !== id) return fail(msg.convId, '这是共享给你的只读对话，不能在里面发消息。可以在回复下方点「分支」接着聊。');
        if ((msg.attachments || []).some((a) => uploads[a.id]?.owner !== id)) return fail(msg.convId, '附件无效，请重新上传');
        const u = guestUsage(id);
        if (u.over) return fail(msg.convId, `本周可用额度已用完（上限为主账号周额度的 ${u.limitPct}%），等每周额度重置后再来，或请链接的主人调高上限。`);
        // Code only when the owner allowed it for this guest (runTurn checks again).
        msg.owner = id; msg.mode = msg.mode === 'code' && users.get(id)?.code ? 'code' : 'chat'; msg.permissionMode = 'default';
      } else { delete msg.owner; msg.pool = poolOf(ws.who); }
      // "My computer": only one of the sender's own connected computers (the management link may use any).
      if (msg.device) {
        const d = devices.get(String(msg.device));
        if (!d || !(isOwner(ws.who) || d.owner === poolOf(ws.who))) return fail(msg.convId, '找不到这台电脑，请在「我的电脑」里重新连接');
        if (guest && users.get(ws.who.id)?.devices === false) return fail(msg.convId, '链接的主人没有允许你连接自己的电脑');
        if (!d.online) return fail(msg.convId, `电脑「${d.name}」现在不在线：请在那台电脑上打开连接器（「我的电脑」里有命令），连上后再发送。`);
        msg.mode = 'code';
      } else delete msg.device;
      runTurn(msg).catch((e) => fail(msg.convId, String(e)));
    }
    else if (msg.type === 'stop') { if (!canEdit(ws.who, msg.convId)) return; const r = running.get(msg.convId); r?.devAbort?.abort(); r?.q.interrupt().catch(() => r.abortController.abort()); }
    else if (msg.type === 'perm') {
      const p = pendingPerms.get(msg.reqId);
      if (!p || (guest && !p.device) || !canEdit(ws.who, p.convId)) return;
      pendingPerms.delete(msg.reqId);
      p.resolve(msg.allow
        ? { behavior: 'allow', updatedInput: p.input, ...(msg.always && p.suggestions ? { updatedPermissions: p.suggestions } : {}) }
        : { behavior: 'deny', message: msg.message || '用户拒绝了此操作' });
      broadcast({ type: 'perm_resolved', reqId: msg.reqId, convId: p.convId, device: p.device });
    }
  });
});

// Name existing conversations that still carry their raw first message as title, one at a time.
(async () => { for (const c of listConvs()) await autoTitle(c.id); })();

server.listen(config.port, '127.0.0.1', () => {
  console.log(`Claude Relay 已启动（本机）: http://127.0.0.1:${config.port}/?k=${config.adminKey}`);
  console.log(`管理链接（只给自己，能看到全部、管理分享和访客）: ${config.publicUrl}/?k=${config.adminKey}`);
  console.log(`个人链接（只看到用它建的对话，可以给自己的其它设备用）: ${config.publicUrl}/?k=${config.accessKey}`);
});
