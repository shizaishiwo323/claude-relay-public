// Guest sub-links: each guest gets their own access key. A guest sees only their own conversations plus the
// conversations the owner chose to share with them (read-only), may use only Chat mode with restricted tools,
// and can be capped at a share of the owner's weekly quota.
// Stored in data/users.json: { users: { id: {...} }, meta: { kAuto, kManual } }.
import fs from 'node:fs';
import crypto from 'node:crypto';

// Fallback "dollars of API-equivalent cost per 1 % of the weekly quota" until the relay has calibrated it
// (deliberately low: guests are stopped early rather than late).
export const DEFAULT_K = 0.7;

export function createUsers({ file }) {
  let db = { users: {}, meta: {} };
  try { db = { users: {}, meta: {}, ...JSON.parse(fs.readFileSync(file, 'utf8')) }; } catch {}
  const save = () => fs.writeFileSync(file, JSON.stringify(db, null, 2));
  const newKey = () => 'g' + crypto.randomBytes(18).toString('base64url'); // 25 chars; the owner key is 32

  function byKey(key) {
    if (typeof key !== 'string' || !key) return null;
    const kb = Buffer.from(key);
    for (const u of Object.values(db.users)) {
      const ub = Buffer.from(u.key);
      if (ub.length === kb.length && crypto.timingSafeEqual(ub, kb)) return u;
    }
    return null;
  }
  const clean = (p = {}) => {
    const o = {};
    if (typeof p.note === 'string') o.note = p.note.trim().slice(0, 60) || '访客';
    if ('quotaPct' in p) { const q = p.quotaPct === null || p.quotaPct === '' ? null : Number(p.quotaPct); o.quotaPct = q === null ? null : Math.max(0, Math.min(100, q)); }
    if (Array.isArray(p.shared)) o.shared = [...new Set(p.shared.filter((x) => /^[\w-]{8,40}$/.test(String(x))).map(String))];
    if (typeof p.enabled === 'boolean') o.enabled = p.enabled;
    if (typeof p.code === 'boolean') o.code = p.code; // Code mode on the relay's computer allowed (off by default)
    if (typeof p.devices === 'boolean') o.devices = p.devices; // may connect their own computer (on by default)
    return o;
  };
  return {
    list: () => Object.values(db.users).sort((a, b) => b.createdAt - a.createdAt),
    get: (id) => db.users[id] || null,
    byKey,
    keys: () => Object.values(db.users).map((u) => u.key),
    create(p) {
      const id = crypto.randomBytes(6).toString('hex');
      db.users[id] = { id, key: newKey(), note: '访客', quotaPct: null, shared: [], enabled: true, code: false, createdAt: Date.now(), ...clean(p) };
      save(); return db.users[id];
    },
    update(id, p) { const u = db.users[id]; if (!u) return null; Object.assign(u, clean(p)); save(); return u; },
    rotate(id) { const u = db.users[id]; if (!u) return null; u.key = newKey(); save(); return u; },
    remove(id) { if (!db.users[id]) return false; delete db.users[id]; save(); return true; },
    touch(id) { const u = db.users[id]; if (u && Date.now() - (u.lastSeenAt || 0) > 60_000) { u.lastSeenAt = Date.now(); save(); } },
    // weekly-quota conversion: dollars of cost per 1 % of the weekly limit
    // kAuto and DEFAULT_K are both lower bounds of the true rate, so the larger one is the better estimate.
    k: () => db.meta.kManual || Math.max(db.meta.kAuto || 0, DEFAULT_K),
    meta: () => ({ ...db.meta, k: db.meta.kManual || Math.max(db.meta.kAuto || 0, DEFAULT_K), kDefault: DEFAULT_K }),
    setMeta(p) {
      if ('kManual' in p) { const v = p.kManual === null || p.kManual === '' ? null : Number(p.kManual); db.meta.kManual = v > 0 ? v : null; }
      if (p.sevenDay) db.meta.sevenDay = p.sevenDay;
      if (p.kAuto > 0) db.meta.kAuto = p.kAuto;
      save();
    },
  };
}
