// Read-only share links for a conversation: a relay conversation or a Claude Code session (desktop app / CLI transcript).
// Sharing takes a SNAPSHOT: the messages are copied, cleaned (system reminders and app plumbing removed, long tool output
// truncated, secrets and the home folder path masked) and stored in data/shares/<token>.json. The public copy never
// contains file paths: files are referenced by number, and only the files listed in the snapshot can be downloaded.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { DELIVERABLE } from './outputs.mjs';

const MAX_RESULT = 3000;   // characters of tool output kept per call
const MAX_INPUT = 3000;    // characters kept per tool argument (e.g. the content of a Write)
const MAX_FILES = 200;
// Tools that are app plumbing (task list, wrap-up, tool loading…): not part of the story.
const HIDDEN_TOOLS = /^(mcp__ccd_turn__|mcp__ccd_session__|mcp__ccd_view__|mcp__ccd_directory__|ToolSearch$|TodoWrite$|Task(Create|Update|List|Get)$)/;

export function createShares({ dir, publicBase, secrets = [] }) {
  fs.mkdirSync(dir, { recursive: true });
  const INDEX = path.join(dir, 'index.json');
  let index = {}; try { index = JSON.parse(fs.readFileSync(INDEX, 'utf8')); } catch {}
  const saveIndex = () => fs.writeFileSync(INDEX, JSON.stringify(index, null, 2));
  const snapPath = (t) => path.join(dir, `${t}.json`);
  const assetDir = (t) => path.join(dir, t);

  // ---------- cleaning ----------
  const home = os.homedir();
  // C:\Users\me, C:/Users/me, C:\\Users\\me (in JSON) and /c/Users/me (Git Bash) all become ~
  const parts = home.split(/[\\/]+/).filter(Boolean).map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  const drive = /^[A-Za-z]:$/.test(parts[0] || '') ? `(?:${parts[0]}|/${parts[0][0].toLowerCase()})` : '';
  const homeRe = new RegExp((drive ? drive + '[\\\\/]+' + parts.slice(1).join('[\\\\/]+') : '/' + parts.join('/')) + '(?![\\w.-])', 'gi');
  // the account name on its own (ls -l output, folder names such as C--Users-<name>-…)
  const uname = (() => { try { return os.userInfo().username; } catch { return ''; } })();
  const userRe = uname.length >= 4 ? new RegExp(`(?<![A-Za-z0-9])${uname.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![A-Za-z0-9])`, 'gi') : null;
  // secrets may be a function so keys created or rotated later (main key, guest keys) are masked too
  const knownNow = () => (typeof secrets === 'function' ? secrets() : secrets).filter((s) => s && String(s).length >= 8).map(String);
  const PATTERNS = [
    /\bsk-[A-Za-z0-9_-]{16,}/g, /\bsk-ant-[A-Za-z0-9_-]{16,}/g, /\bgh[pousr]_[A-Za-z0-9]{20,}/g, /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
    /\bAKIA[0-9A-Z]{16}\b/g, /\bxox[abpr]-[A-Za-z0-9-]{10,}/g, /\beyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}/g,
    /([?&]k=)[A-Za-z0-9_-]{16,}/g, /((?:api[_-]?key|token|secret|password)["']?\s*[:=]\s*["']?)[A-Za-z0-9_\-./+]{16,}/gi,
  ];
  function scrub(s) {
    if (typeof s !== 'string') return s;
    for (const k of knownNow()) s = s.split(k).join('[已隐藏]');
    for (const re of PATTERNS) s = s.replace(re, (m, pre) => (typeof pre === 'string' && m.startsWith(pre) ? pre : '') + '[已隐藏]');
    s = s.replace(homeRe, '~');
    return userRe ? s.replace(userRe, 'user') : s;
  }
  const clip = (s, n) => (s.length > n ? s.slice(0, n) + `\n…（已截断，共 ${s.length} 字）` : s);
  const deep = (v, f) => (typeof v === 'string' ? f(v) : Array.isArray(v) ? v.map((x) => deep(x, f)) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, deep(x, f)])) : v);
  const stripReminders = (s) => String(s || '').replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '').trim();

  // ---------- file registry (server side only) ----------
  function registry() {
    const files = [], byPath = new Map();
    const ref = (p, name) => {
      const key = path.resolve(p).toLowerCase();
      if (byPath.has(key)) return byPath.get(key);
      if (files.length >= MAX_FILES) return null;
      let st; try { st = fs.statSync(p); } catch { return null; }
      if (!st.isFile()) return null;
      files.push({ name: name || path.basename(p), path: p, size: st.size });
      byPath.set(key, files.length - 1);
      return files.length - 1;
    };
    return { files, ref };
  }

  // ---------- relay conversation ----------
  function fromRelay(conv, { uploads = {}, livePath = (p) => p } = {}) {
    const reg = registry();
    const messages = conv.messages.map((m) => {
      if (m.role === 'user') {
        const attachments = (m.attachments || []).map((a) => {
          const u = uploads[a.id]; const r = u ? reg.ref(livePath(u.path), u.name) : null;
          return { name: a.name, type: a.type, size: a.size, ...(r != null ? { id: 'r' + r } : {}) };
        });
        return { role: 'user', text: m.text || '', ...(m.quotes?.length ? { quotes: m.quotes, quoteSrc: m.quoteSrc } : {}), attachments };
      }
      const blocks = (m.blocks || []).filter(Boolean).map((b) => {
        if (b.type !== 'tool') return { type: b.type, text: b.text };
        const out = { type: 'tool', id: b.id, name: b.name, input: b.input, result: b.result === undefined ? '' : b.result, isError: b.isError };
        if (b.images) out.images = b.images.map((im) => ({ name: im.name, size: im.size, ref: reg.ref(livePath(im.path), im.name) })).filter((x) => x.ref != null);
        return out;
      });
      const files = (m.files || []).map((f) => ({ name: f.name, size: f.size, ref: reg.ref(livePath(f.path), f.name) })).filter((f) => f.ref != null);
      return { role: 'assistant', blocks, files, done: true, result: { durationMs: m.result?.durationMs } };
    });
    return { title: conv.title || '对话', messages, files: reg.files };
  }

  // ---------- Claude Code session (.jsonl transcript) ----------
  function findSession(id) {
    if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
    const root = path.join(home, '.claude', 'projects');
    let dirs = []; try { dirs = fs.readdirSync(root); } catch {}
    for (const d of dirs) { const f = path.join(root, d, id + '.jsonl'); if (fs.existsSync(f)) return f; }
    return null;
  }
  // The desktop app writes a selected-and-replied quote as "<!-- reply N -->\n> quoted\n\nmessage".
  function splitQuotes(text) {
    if (!/<!-- reply\b[^>]*-->/.test(text)) return { text, quotes: [] };
    const quotes = [], rest = [];
    for (const part of text.split(/<!-- reply\b[^>]*-->/)) {
      const lines = part.replace(/^\s*\n/, '').split('\n'); let i = 0; const q = [];
      while (i < lines.length && /^>\s?/.test(lines[i])) q.push(lines[i++].replace(/^>\s?/, ''));
      if (q.length) quotes.push(q.join('\n').trim());
      const r = lines.slice(i).join('\n').trim(); if (r) rest.push(r);
    }
    return { text: rest.join('\n\n'), quotes };
  }
  function fromSession(file, { assetsTo } = {}) {
    const lines = fs.readFileSync(file, 'utf8').split('\n');
    let title = null, scratchRoot = null, relocated = null;
    const entries = [];
    for (const l of lines) {
      let o; try { o = JSON.parse(l); } catch { continue; }
      if (o.type === 'custom-title' && o.customTitle) title = o.customTitle;
      if (o.type === 'relocated' && o.relocatedCwd) relocated = o.relocatedCwd;
      if (o.cwd && !scratchRoot) { const m = o.cwd.match(/^(.*[\\/]scratch-workspaces[\\/][^\\/]+[\\/][^\\/]+[\\/][^\\/]+)/); if (m) scratchRoot = m[1]; }
      if ((o.type === 'user' || o.type === 'assistant') && !o.isSidechain) entries.push(o);
    }
    // Files may have moved since (the session was moved out of its scratch folder, files were reorganised):
    // try the path as written, then the same place under the new folder, then a file of that name under the new folder.
    const byName = new Map();
    if (relocated) {
      const walk = (d, depth) => { let es; try { es = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
        for (const e of es) { const p = path.join(d, e.name);
          if (e.isDirectory()) { if (depth && !/^(node_modules|\.git|frames|tmp|cache)$/i.test(e.name)) walk(p, depth - 1); }
          else { const k = e.name.toLowerCase(); (byName.get(k) || byName.set(k, []).get(k)).push(p); } } };
      walk(relocated, 6);
    }
    const resolve = (p, cwd) => {
      if (!p) return null;
      p = String(p).replace(/^\/([a-z])\//i, (_, d) => d.toUpperCase() + ':\\');
      const abs = path.isAbsolute(p) ? p : path.resolve(cwd || relocated || home, p);
      if (fs.existsSync(abs)) return abs;
      if (scratchRoot && relocated && abs.toLowerCase().startsWith(scratchRoot.toLowerCase())) {
        const moved = path.join(relocated, abs.slice(scratchRoot.length)); if (fs.existsSync(moved)) return moved;
      }
      const same = byName.get(path.basename(abs).toLowerCase());
      if (same?.length) return same.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)[0];
      return null;
    };
    const PATH_RE = /(?:[A-Za-z]:[\\/]|\/[a-z]\/)[^\n\r"'`<>|*?()\[\]{}]*?\.[A-Za-z0-9]{1,5}(?=$|[\s"'`<>|)\]},;，。；：:！!？?])/g;

    const reg = registry();
    const messages = []; let turn = null; const tools = new Map(); const turnFiles = new Map(); // turn -> Set(path)
    const addFile = (p, cwd) => { const r = resolve(p, cwd); if (r && DELIVERABLE.test(r) && !/[\\/](tool-results|\.claude)[\\/]/i.test(r)) turnFiles.get(turn)?.add(r); };
    let imgN = 0;
    const saveImage = (b) => {
      if (!assetsTo || b.source?.type !== 'base64') return null;
      fs.mkdirSync(assetsTo, { recursive: true });
      const ext = (b.source.media_type || 'image/png').split('/')[1].replace('jpeg', 'jpg');
      const f = path.join(assetsTo, `image-${++imgN}.${ext}`); fs.writeFileSync(f, Buffer.from(b.source.data, 'base64'));
      return { f, type: b.source.media_type || 'image/png' };
    };
    for (const o of entries) {
      const c = o.message?.content;
      if (o.type === 'user') {
        if (o.isMeta || o.isCompactSummary || o.isVisibleInTranscriptOnly) continue;
        const parts = typeof c === 'string' ? [{ type: 'text', text: c }] : Array.isArray(c) ? c : [];
        const texts = [], atts = [];
        for (const b of parts) {
          if (b.type === 'tool_result') {
            const t = tools.get(b.tool_use_id); if (!t) continue;
            const r = typeof b.content === 'string' ? b.content : Array.isArray(b.content) ? b.content.map((x) => (x.type === 'text' ? x.text : x.type === 'image' ? '[图片]' : '')).join('\n') : '';
            t.result = clip(stripReminders(r), MAX_RESULT); t.isError = !!b.is_error;
          } else if (b.type === 'text') { const t = stripReminders(b.text); if (t && !/^<(command-|local-command-)/.test(t)) texts.push(t); }
          else if (b.type === 'image') { const s = saveImage(b); if (s) { const r = reg.ref(s.f, path.basename(s.f)); atts.push({ name: path.basename(s.f), type: s.type, size: fs.statSync(s.f).size, id: 'r' + r }); } }
        }
        if (!texts.length && !atts.length) continue;
        const { text, quotes } = splitQuotes(texts.join('\n\n'));
        messages.push({ role: 'user', text, ...(quotes.length ? { quotes } : {}), attachments: atts });
        turn = null;
      } else {
        if (!Array.isArray(c)) continue;
        if (!turn) { turn = { role: 'assistant', blocks: [], files: [], done: true, result: {} }; messages.push(turn); turnFiles.set(turn, new Set()); }
        for (const b of c) {
          if (b.type === 'text' && b.text?.trim()) {
            if (o.isApiErrorMessage) turn.blocks.push({ type: 'error', text: b.text });
            else { turn.blocks.push({ type: 'text', text: b.text }); for (const m of b.text.matchAll(PATH_RE)) addFile(m[0], o.cwd); }
          } else if (b.type === 'thinking' && b.thinking?.trim()) turn.blocks.push({ type: 'thinking', text: b.thinking });
          else if (b.type === 'tool_use') {
            if (HIDDEN_TOOLS.test(b.name)) continue;
            const input = deep(b.input || {}, (s) => clip(s, MAX_INPUT));
            const t = { type: 'tool', id: b.id, name: b.name, input, result: '' };
            tools.set(b.id, t); turn.blocks.push(t);
            const inp = b.input || {};
            if (b.name === 'SendUserFile') (inp.files || []).forEach((f) => addFile(f, o.cwd));
            if (/^(Write|Edit|NotebookEdit)$/.test(b.name) && inp.file_path) addFile(inp.file_path, o.cwd);
          }
        }
      }
    }
    // A file is listed under the LAST reply that made or mentioned it (its final version).
    const last = new Map();
    for (const [t, set] of turnFiles) for (const p of set) last.set(p.toLowerCase(), [t, p]);
    for (const [t, p] of last.values()) { const r = reg.ref(p); if (r != null) t.files.push({ name: reg.files[r].name, size: reg.files[r].size, ref: r }); }
    return { title: title || '对话', messages: messages.filter((m) => m.role === 'user' || m.blocks.length || m.files.length), files: reg.files };
  }

  // ---------- store ----------
  const tokenFor = (source) => Object.values(index).find((s) => s.source === source)?.token;
  function save({ kind, source, snap, extras = [] }) {
    const token = tokenFor(source) || crypto.randomBytes(12).toString('base64url');
    const reg = { files: snap.files };
    const extra = [];
    for (const p of extras) {
      let st; try { st = fs.statSync(p); } catch { continue; }
      if (!st.isFile()) continue;
      const i = reg.files.findIndex((f) => path.resolve(f.path).toLowerCase() === path.resolve(p).toLowerCase());
      extra.push(i >= 0 ? i : reg.files.push({ name: path.basename(p), path: p, size: st.size }) - 1);
    }
    const pub = deep({ title: snap.title, messages: snap.messages }, scrub);
    const now = Date.now();
    const old = index[token] || {};
    const rec = { token, kind, source, title: snap.title, createdAt: old.createdAt || now, updatedAt: now, extras: extras.slice(),
      enabled: old.enabled ?? true, expiresAt: old.expiresAt ?? null, views: old.views || 0, lastViewedAt: old.lastViewedAt || null };
    fs.writeFileSync(snapPath(token), JSON.stringify({ ...rec, pub, files: reg.files, extra }));
    index[token] = rec; saveIndex();
    return info(token);
  }
  // active: anyone with the link can open it; paused: switched off by the owner (can be switched on again); expired: past expiresAt.
  const status = (token) => { const r = index[token]; if (!r) return null; return r.enabled === false ? 'paused' : r.expiresAt && Date.now() > r.expiresAt ? 'expired' : 'active'; };
  const info = (token) => { const r = index[token]; return r && { enabled: true, expiresAt: null, views: 0, ...r, status: status(token), url: `${publicBase.replace(/\/$/, '')}/s/${token}` }; };
  // The public routes only see active shares.
  const loadRaw = (token) => { if (!index[token]) return null; try { return JSON.parse(fs.readFileSync(snapPath(token), 'utf8')); } catch { return null; } };
  const load = (token) => (status(token) === 'active' ? loadRaw(token) : null);

  return {
    status,
    get: info,
    // { enabled?: boolean, expiresAt?: ms timestamp | null }
    setState(token, { enabled, expiresAt } = {}) {
      const r = index[token]; if (!r) return null;
      if (typeof enabled === 'boolean') r.enabled = enabled;
      if (expiresAt === null || Number.isFinite(expiresAt)) r.expiresAt = expiresAt;
      saveIndex(); return info(token);
    },
    countView(token) { const r = index[token]; if (!r) return; r.views = (r.views || 0) + 1; r.lastViewedAt = Date.now(); saveIndex(); },
    list: () => Object.keys(index).map(info).sort((a, b) => b.updatedAt - a.updatedAt),
    find: (source) => { const t = tokenFor(source); return t ? info(t) : null; },
    shareRelay(conv, opts) { return save({ kind: 'relay', source: 'relay:' + conv.id, snap: fromRelay(conv, opts), extras: opts?.extras }); },
    shareSession(id, { extras } = {}) {
      const file = findSession(id); if (!file) throw new Error('找不到这个 Claude Code 对话（~/.claude/projects 里没有 ' + id + '.jsonl）');
      const t = tokenFor('cc:' + id) || null;
      const tmp = path.join(dir, '.tmp-' + crypto.randomBytes(4).toString('hex'));
      const snap = fromSession(file, { assetsTo: tmp });
      const rec = save({ kind: 'cc', source: 'cc:' + id, snap, extras: extras ?? index[t]?.extras });
      // pasted images live next to the snapshot
      if (fs.existsSync(tmp)) {
        const dest = assetDir(rec.token); fs.rmSync(dest, { recursive: true, force: true }); fs.renameSync(tmp, dest);
        const s = loadRaw(rec.token); s.files.forEach((f) => { if (f.path.startsWith(tmp)) f.path = dest + f.path.slice(tmp.length); });
        fs.writeFileSync(snapPath(rec.token), JSON.stringify(s));
      }
      return rec;
    },
    remove(token) { if (!index[token]) return false; delete index[token]; saveIndex(); fs.rmSync(snapPath(token), { force: true }); fs.rmSync(assetDir(token), { recursive: true, force: true }); return true; },
    // For the public page: the cleaned conversation with file numbers, never paths.
    publicView(token) {
      const s = load(token); if (!s) return null;
      return { title: s.pub.title, messages: s.pub.messages, extras: (s.extra || []).map((i) => ({ name: s.files[i].name, size: s.files[i].size, ref: i })), sharedAt: s.updatedAt, kind: s.kind };
    },
    file(token, n) { const s = load(token); const f = s?.files?.[n]; return f && fs.existsSync(f.path) ? f : null; },
    allFiles(token) { const s = load(token); return s ? s.files.filter((f) => fs.existsSync(f.path)) : []; },
  };
}
