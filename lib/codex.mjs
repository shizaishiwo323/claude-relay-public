// Codex (ChatGPT plan) quota for the usage panel: asks a short-lived `codex app-server` over JSON-RPC (stdio)
// for account/read and account/rateLimits/read, then closes it. Cached for a minute.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

function codexCommand() {
  if (process.env.CODEX_BIN) return { cmd: process.env.CODEX_BIN, pre: [] };
  if (process.platform === 'win32') {
    // Run the npm package's JS entry with node directly (no shell, no codex.cmd window).
    const roots = [process.env.APPDATA && path.join(process.env.APPDATA, 'npm', 'node_modules'), process.env.npm_config_prefix && path.join(process.env.npm_config_prefix, 'node_modules')].filter(Boolean);
    for (const r of roots) {
      const js = path.join(r, '@openai', 'codex', 'bin', 'codex.js');
      if (fs.existsSync(js)) return { cmd: process.execPath, pre: [js] };
    }
    return null;
  }
  return { cmd: 'codex', pre: [] };
}

function rpc(calls, timeoutMs = 20_000) {
  return new Promise((resolve, reject) => {
    const c = codexCommand();
    if (!c) return reject(new Error('本机没有安装 Codex'));
    const env = { ...process.env }; delete env.OPENAI_API_KEY; delete env.CODEX_API_KEY; // read the ChatGPT login
    const child = spawn(c.cmd, [...c.pre, 'app-server'], { env, windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] });
    const results = {}; let buf = '', pending = calls.length;
    const done = (err) => { clearTimeout(timer); try { child.kill(); } catch {} err ? reject(err) : resolve(results); };
    const timer = setTimeout(() => done(new Error('Codex 没有响应（超时）')), timeoutMs);
    child.on('error', (e) => done(new Error('无法启动 Codex：' + e.message)));
    child.stdout.on('data', (d) => {
      buf += d; let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1);
        let m; try { m = JSON.parse(line); } catch { continue; }
        if (typeof m.id !== 'number' || m.id < 1) continue;
        results[calls[m.id - 1]] = m.error ? { error: m.error.message || String(m.error) } : m.result;
        if (--pending === 0) done();
      }
    });
    const send = (o) => child.stdin.write(JSON.stringify(o) + '\n');
    send({ id: 0, method: 'initialize', params: { clientInfo: { name: 'claude-relay', version: '1' } } });
    send({ method: 'initialized' });
    calls.forEach((method, k) => send({ id: k + 1, method, params: {} }));
  });
}

let cache = null, inflight = null;
export async function codexUsage(force) {
  if (!force && cache && Date.now() - cache.at < 60_000) return cache.data;
  if (inflight) return inflight;
  inflight = (async () => {
    try {
      const r = await rpc(['account/read', 'account/rateLimits/read']);
      const acc = r['account/read']?.account || null;
      const rl = r['account/rateLimits/read'];
      const data = {
        loggedIn: !!acc || !!rl?.rateLimits,
        email: acc?.email || null,
        planType: rl?.rateLimits?.planType || acc?.planType || null,
        rateLimits: rl?.rateLimits || null,
        resetCredits: (rl?.rateLimitResetCredits?.credits || []).filter((c) => c.status === 'available').length,
        error: rl?.error || null,
        fetchedAt: Date.now(),
      };
      cache = { at: Date.now(), data };
      return data;
    } finally { inflight = null; }
  })();
  return inflight;
}
