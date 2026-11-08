// Live preview of web pages Claude made, served on a separate origin (preview.<domain>) through the same tunnel.
// Why a separate origin: a generated page runs its own scripts; on the main site it could read the access key and
// drive the API. On preview.<domain> it can't (different origin, no key, and the preview host serves nothing else).
// Links look like https://preview.<domain>/p/<token>/index.html — the random token is the only "password" and maps
// to one folder, so relative CSS, images and links between pages work. Only web asset types are served.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const WEB = { html: 'text/html; charset=utf-8', htm: 'text/html; charset=utf-8', css: 'text/css; charset=utf-8', js: 'text/javascript; charset=utf-8',
  mjs: 'text/javascript; charset=utf-8', json: 'application/json; charset=utf-8', map: 'application/json', txt: 'text/plain; charset=utf-8',
  md: 'text/plain; charset=utf-8', csv: 'text/plain; charset=utf-8', svg: 'image/svg+xml', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
  gif: 'image/gif', webp: 'image/webp', avif: 'image/avif', ico: 'image/x-icon', bmp: 'image/bmp', woff: 'font/woff', woff2: 'font/woff2',
  ttf: 'font/ttf', otf: 'font/otf', mp4: 'video/mp4', webm: 'video/webm', mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg',
  pdf: 'application/pdf', wasm: 'application/wasm', glb: 'model/gltf-binary', gltf: 'model/gltf+json', xml: 'application/xml' };
const SKIP = /^(node_modules|\.git|\.cache|__pycache__|\.venv|venv|uploads)$/i;

export function createPreviews({ file, workdir }) {
  let db = {};
  try { db = JSON.parse(fs.readFileSync(file, 'utf8')); } catch {}
  const save = () => fs.writeFileSync(file, JSON.stringify(db, null, 1));
  const inside = (p, root) => { const r = path.relative(root, p); return r === '' || (!r.startsWith('..') && !path.isAbsolute(r)); };
  // After a restore on another PC, folders inside the old ...\ClaudeRelay\ map to this PC's workdir.
  const live = (dir) => { if (fs.existsSync(dir)) return dir; const rel = dir.split(/[\\/]ClaudeRelay[\\/]/i)[1]; return rel ? path.join(workdir, ...rel.split(/[\\/]+/)) : dir; };

  // Token for a folder (whole folder shared) or, when the folder is too broad, for a single page.
  function tokenFor(target) {
    target = path.resolve(target);
    let scope = fs.statSync(target).isDirectory() ? target : path.dirname(target);
    let only = null;
    const broad = !inside(scope, workdir) || path.resolve(scope) === path.resolve(workdir);
    if (broad) { if (fs.statSync(target).isDirectory()) throw new Error('只能预览工作目录里的文件夹'); only = path.basename(target); }
    for (const [t, v] of Object.entries(db)) if (v.dir.toLowerCase() === scope.toLowerCase() && (v.only || null) === only) return t;
    const t = crypto.randomBytes(12).toString('base64url');
    db[t] = { dir: scope, ...(only ? { only } : {}), at: Date.now() };
    save();
    return t;
  }
  const link = (base, target) => {
    const t = tokenFor(target), st = fs.statSync(target);
    return `${base}/p/${t}/${st.isDirectory() ? '' : encodeURIComponent(path.basename(target))}`;
  };

  // Web projects in the working directory: folders (up to 2 levels) that contain .html files.
  function listSites() {
    const out = [];
    const scan = (dir, depth) => {
      let ents; try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
      const pages = ents.filter((e) => e.isFile() && /\.html?$/i.test(e.name)).map((e) => e.name);
      if (pages.length && path.resolve(dir) !== path.resolve(workdir)) {
        const mtime = Math.max(...pages.map((p) => fs.statSync(path.join(dir, p)).mtimeMs));
        out.push({ dir, name: path.relative(workdir, dir), pages: pages.sort((a, b) => (/^index\./i.test(a) ? -1 : /^index\./i.test(b) ? 1 : a.localeCompare(b))), mtime });
      }
      if (depth > 0) for (const e of ents) if (e.isDirectory() && !SKIP.test(e.name) && !e.name.startsWith('.')) scan(path.join(dir, e.name), depth - 1);
    };
    scan(workdir, 2);
    return out.sort((a, b) => b.mtime - a.mtime);
  }

  // Newest modification time in the shared folder (used by the page to auto-refresh the preview).
  function stamp(token) {
    const v = db[token]; if (!v) return null;
    const dir = live(v.dir);
    let m = 0;
    const walk = (d, depth) => {
      let ents; try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
      for (const e of ents) {
        const p = path.join(d, e.name);
        if (e.isFile() && (!v.only || p === path.join(dir, v.only))) { try { m = Math.max(m, fs.statSync(p).mtimeMs); } catch {} }
        else if (e.isDirectory() && depth > 0 && !v.only && !SKIP.test(e.name)) walk(p, depth - 1);
      }
    };
    walk(dir, 2);
    return Math.round(m);
  }

  // Serves GET /p/<token>/<path> on the preview host.
  function handle(req, res, pathname) {
    const send = (code, body) => { res.writeHead(code, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' }); res.end(body); };
    const m = pathname.match(/^\/p\/([\w-]{8,})(\/.*)?$/);
    if (!m) return send(404, 'Not found');
    const v = db[m[1]];
    if (!v) return send(404, '这个预览链接不存在或已失效');
    if (!m[2]) { res.writeHead(302, { location: `/p/${m[1]}/` }); return res.end(); }
    const dir = live(v.dir);
    let rel; try { rel = decodeURIComponent(m[2]).replace(/^\/+/, ''); } catch { return send(400, 'Bad path'); }
    let p = path.resolve(dir, rel || (v.only || 'index.html'));
    if (!inside(p, dir)) return send(403, 'Forbidden');
    if (v.only && path.relative(dir, p) !== v.only) return send(403, '这个链接只能打开一个页面');
    if (fs.existsSync(p) && fs.statSync(p).isDirectory()) {
      if (!pathname.endsWith('/')) { res.writeHead(302, { location: pathname + '/' }); return res.end(); }
      const idx = ['index.html', 'index.htm'].map((f) => path.join(p, f)).find((f) => fs.existsSync(f));
      if (!idx) { // no index page: list the pages in this folder
        const pages = fs.readdirSync(p).filter((f) => /\.html?$/i.test(f));
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' });
        return res.end(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${path.basename(p)}</title><body style="font:15px system-ui;padding:24px"><h3>${path.basename(p)}</h3>${pages.map((f) => `<p><a href="${encodeURIComponent(f)}">${f.replace(/</g, '&lt;')}</a></p>`).join('') || '没有网页文件'}</body>`);
      }
      p = idx;
    }
    if (path.basename(p).startsWith('.')) return send(403, 'Forbidden');
    const type = WEB[path.extname(p).slice(1).toLowerCase()];
    if (!type) return send(403, '预览只提供网页相关的文件');
    if (!fs.existsSync(p)) return send(404, 'Not found: ' + rel);
    const st = fs.statSync(p);
    res.writeHead(200, { 'content-type': type, 'content-length': st.size, 'cache-control': 'no-store',
      'referrer-policy': 'no-referrer', 'x-robots-tag': 'noindex, nofollow', 'x-content-type-options': 'nosniff' });
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(p).pipe(res);
  }

  return { tokenFor, link, listSites, stamp, handle, has: (t) => !!db[t] };
}
