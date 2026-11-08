// "My computer": users connect their own Mac / Windows PC with the connector (connector/connector.mjs), then Code mode
// can run on that computer. This module keeps the device list (data/devices.json), one-time pairing codes, and the
// live connector sockets, and sends file / command requests to a device and waits for the answer.
// Device tokens are stored only as SHA-256 hashes.
import fs from 'node:fs';
import crypto from 'node:crypto';

const hash = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I

export function createDevices({ file }) {
  let db = { devices: {} };
  try { db = { devices: {}, ...JSON.parse(fs.readFileSync(file, 'utf8')) }; } catch {}
  const save = () => fs.writeFileSync(file, JSON.stringify(db, null, 2));
  const codes = new Map();   // code -> { owner, expiresAt }
  const live = new Map();    // device id -> { ws, info, since }
  const calls = new Map();   // call id -> { resolve, reject, timer, deviceId }

  const pub = (d) => d && ({ id: d.id, owner: d.owner, name: d.name, os: d.os, arch: d.arch, hostname: d.hostname, user: d.user, root: d.root,
    policy: d.policy || 'confirm', recent: d.recent || [], createdAt: d.createdAt, lastSeenAt: live.has(d.id) ? Date.now() : d.lastSeenAt, online: live.has(d.id), version: d.version });

  return {
    // ---------- pairing ----------
    newCode(owner) {
      for (const [c, v] of codes) if (v.expiresAt < Date.now()) codes.delete(c);
      let code; do { code = Array.from(crypto.randomBytes(8), (b) => CODE_CHARS[b % CODE_CHARS.length]).join(''); } while (codes.has(code));
      const expiresAt = Date.now() + 10 * 60_000;
      codes.set(code, { owner, expiresAt });
      return { code, expiresAt };
    },
    // Exchanges a pairing code for a device token (the token is returned once, kept only as a hash here).
    pair({ code, os, arch, hostname, user, root, version }) {
      const c = codes.get(String(code || '').toUpperCase());
      if (!c || c.expiresAt < Date.now()) throw new Error('配对码无效或已过期，请回到网页重新生成');
      codes.delete(String(code).toUpperCase());
      const token = 'dev_' + crypto.randomBytes(24).toString('base64url');
      const id = crypto.randomBytes(6).toString('hex');
      const osName = os === 'darwin' ? 'Mac' : os === 'win32' ? 'Windows' : String(os || '电脑');
      const name = `${String(hostname || osName).replace(/\.local$/, '').slice(0, 40)}`;
      db.devices[id] = { id, owner: c.owner, tokenHash: hash(token), name, os, arch, hostname, user, root, version, policy: 'confirm', createdAt: Date.now() };
      save();
      return { token, deviceId: id, name };
    },
    pending: (owner) => [...codes.values()].some((v) => v.owner === owner && v.expiresAt > Date.now()),

    // ---------- list / manage ----------
    list: (owner) => Object.values(db.devices).filter((d) => owner === undefined || d.owner === owner).map(pub).sort((a, b) => b.createdAt - a.createdAt),
    get: (id) => pub(db.devices[id]),
    update(id, p) {
      const d = db.devices[id]; if (!d) return null;
      if (typeof p.name === 'string' && p.name.trim()) d.name = p.name.trim().slice(0, 40);
      if (p.policy === 'confirm' || p.policy === 'auto') d.policy = p.policy;
      save(); return pub(d);
    },
    // The connector switched its work folder: remember the old one among the recent folders (for one-click switching back).
    setRoot(id, root) {
      const d = db.devices[id]; if (!d) return null;
      if (d.root && d.root !== root) d.recent = [d.root, ...(d.recent || []).filter((x) => x !== d.root && x !== root)].slice(0, 6);
      else d.recent = (d.recent || []).filter((x) => x !== root);
      d.root = root; save(); return pub(d);
    },
    remove(id) {
      if (!db.devices[id]) return false;
      const l = live.get(id); if (l) { try { l.ws.send(JSON.stringify({ type: 'revoked' })); l.ws.close(4401, 'revoked'); } catch {} }
      delete db.devices[id]; save(); return true;
    },
    byToken(token) { if (!token) return null; const h = hash(token); return Object.values(db.devices).find((d) => d.tokenHash === h) || null; },
    online: (id) => live.has(id),

    // ---------- live connector sockets ----------
    attach(id, ws, info, onChange) {
      const old = live.get(id); if (old && old.ws !== ws) { try { old.ws.close(4000, 'replaced'); } catch {} }
      const d = db.devices[id];
      Object.assign(d, { root: info.root || d.root, os: info.os || d.os, arch: info.arch || d.arch, hostname: info.hostname || d.hostname, user: info.user || d.user, version: info.version || d.version, lastSeenAt: Date.now() });
      save();
      live.set(id, { ws, info, since: Date.now() });
      ws.send(JSON.stringify({ type: 'ready', name: d.name }));
      ws.on('message', (raw) => {
        let m; try { m = JSON.parse(raw); } catch { return; }
        if (m.type === 'result') {
          const c = calls.get(m.id); if (!c) return;
          clearTimeout(c.timer); calls.delete(m.id);
          m.ok ? c.resolve(m.result) : c.reject(new Error(m.error || '执行失败'));
        }
      });
      ws.on('close', () => {
        if (live.get(id)?.ws !== ws) return;
        live.delete(id);
        if (db.devices[id]) { db.devices[id].lastSeenAt = Date.now(); save(); }
        for (const [cid, c] of calls) if (c.deviceId === id) { clearTimeout(c.timer); calls.delete(cid); c.reject(new Error('电脑已断开连接（连接器窗口被关闭或网络中断）')); }
        onChange?.();
      });
      onChange?.();
    },
    ping() { for (const { ws } of live.values()) try { ws.send('{"type":"ping"}'); } catch {} },

    // Sends one request to a device and waits for the answer. signal: abort -> the running command is stopped.
    call(id, op, args, { timeoutMs = 120_000, signal } = {}) {
      const l = live.get(id);
      if (!l) return Promise.reject(new Error('这台电脑现在不在线：请在那台电脑上打开连接器（运行网页「我的电脑」里给出的命令）'));
      const cid = crypto.randomUUID();
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { calls.delete(cid); try { l.ws.send(JSON.stringify({ type: 'cancel', id: cid })); } catch {} reject(new Error('电脑没有在规定时间内返回结果')); }, timeoutMs);
        calls.set(cid, { resolve, reject, timer, deviceId: id });
        signal?.addEventListener('abort', () => { try { l.ws.send(JSON.stringify({ type: 'cancel', id: cid })); } catch {} });
        l.ws.send(JSON.stringify({ type: 'call', id: cid, op, args }));
      });
    },
  };
}
