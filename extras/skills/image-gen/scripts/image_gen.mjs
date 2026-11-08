#!/usr/bin/env node
// Generate images with the local Codex CLI's built-in image generation tool (ChatGPT sign-in), for Claude.
//
// CLI:   node image_gen.mjs --prompt "..." [--out DIR] [--name base] [--aspect square|landscape|portrait|16:9|...]
//                             [--n 1-4] [--ref image.png ...] [--model gpt-5.6-luna] [--timeout 300]
//        prints one JSON line: {"ok":true,"files":[...],"seconds":..} or {"ok":false,"error":"..."}
// Module: import { generateImage } from './image_gen.mjs'
//
// How it works: runs `codex exec --json` with a short instruction to call its image tool, reads the thread id
// from the event stream, then copies the images Codex saved under $CODEX_HOME/generated_images/<thread>/ to --out.
// Notes for this PC: an old OPENAI_API_KEY / CODEX_API_KEY in the environment would override the ChatGPT login
// (401), so they are removed for the Codex process only; the config's default model may not be allowed with a
// ChatGPT account, so a model is passed explicitly and the user config is not loaded.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const CODEX_HOME = process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
// The model only drives the call (the picture itself comes from Codex's image tool). Tried in order: a model the
// account doesn't allow fails within seconds and the next one is used.
const MODELS = [...new Set([process.env.CODEX_IMAGE_MODEL, 'gpt-6.1-sol', 'gpt-6-astra', 'gpt-5.6-luna'].filter(Boolean))];
const MODEL_REFUSED = /model_not_found|model is not supported|not supported when using Codex|does not exist|unknown model/i;
const ASPECTS = {
  square: '1:1 square', landscape: '16:9 landscape (wide)', portrait: '9:16 portrait (tall)', wide: '16:9 landscape (wide)', tall: '9:16 portrait (tall)',
};

// Find how to start Codex without a shell (prompts go through stdin, so nothing needs quoting).
function codexCommand() {
  if (process.env.CODEX_BIN) return { cmd: process.env.CODEX_BIN, pre: [] };
  if (process.platform === 'win32') {
    const roots = [process.env.APPDATA && path.join(process.env.APPDATA, 'npm', 'node_modules'), process.env.npm_config_prefix && path.join(process.env.npm_config_prefix, 'node_modules')].filter(Boolean);
    for (const r of roots) {
      const js = path.join(r, '@openai', 'codex', 'bin', 'codex.js');
      if (fs.existsSync(js)) return { cmd: process.execPath, pre: [js] };
    }
    return { cmd: 'codex.cmd', pre: [], shell: true };
  }
  return { cmd: 'codex', pre: [] };
}

function instruction({ prompt, aspect, n, refs }) {
  const ar = aspect ? (ASPECTS[aspect] || aspect) : null;
  return [
    `Use your image generation tool to create ${n} image${n > 1 ? 's' : ''}. Call the image tool directly.`,
    'Do not run shell commands, do not write or edit files, do not search the web.',
    refs.length ? `The attached image${refs.length > 1 ? 's are' : ' is'} the reference/input: follow the request below about how to use or edit ${refs.length > 1 ? 'them' : 'it'}.` : '',
    ar ? `Aspect ratio: ${ar}.` : '',
    n > 1 ? `Make the ${n} images distinct variations of the same request.` : '',
    '',
    'Image request (follow it faithfully; keep any text in the image exactly as written):',
    '<<<',
    prompt.trim(),
    '>>>',
    '',
    'When the image generation is finished, reply with only the word DONE.',
  ].filter((l) => l !== null).join('\n');
}

// onProgress({ stage, text, model, done, total, elapsed }) is called as the work advances. Stages:
// start → model (switching model) → generating → image (each finished picture) → saving → done | error.
export async function generateImage(opts = {}) {
  const models = opts.model ? [opts.model] : MODELS;
  const tried = [];
  const t0 = Date.now();
  const total = Math.max(1, Math.min(4, Number(opts.n) || 1));
  const progress = (p) => { try { opts.onProgress?.({ total, elapsed: Math.round((Date.now() - t0) / 1000), ...p }); } catch {} };
  progress({ stage: 'start', text: '正在启动 Codex', done: 0 });
  for (const model of models) {
    try {
      const r = { ...(await generateWith({ ...opts, model, progress })), ...(tried.length ? { skippedModels: tried } : {}) };
      progress({ stage: 'done', text: `完成，共 ${r.files.length} 张`, done: r.files.length, model, files: r.files });
      return r;
    } catch (e) {
      if (!MODEL_REFUSED.test(String(e?.message)) || model === models.at(-1)) { progress({ stage: 'error', text: String(e?.message || e).slice(0, 300), model }); throw e; }
      tried.push(model); // this account can't use it: try the next model
      progress({ stage: 'model', text: `${model} 不可用，改用 ${models[models.indexOf(model) + 1]}`, model, done: 0 });
    }
  }
}

async function generateWith({ prompt, outDir, name, aspect, n = 1, refs = [], model, timeoutMs = 300_000, onEvent, progress = () => {} } = {}) {
  if (!prompt || !String(prompt).trim()) throw new Error('prompt is empty');
  n = Math.max(1, Math.min(4, Number(n) || 1));
  refs = (refs || []).map((r) => path.resolve(r));
  for (const r of refs) if (!fs.existsSync(r)) throw new Error('reference image not found: ' + r);
  outDir = path.resolve(outDir || path.join(process.cwd(), 'outputs', 'images'));
  fs.mkdirSync(outDir, { recursive: true });
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'image-gen-'));

  const env = { ...process.env };
  delete env.OPENAI_API_KEY; delete env.CODEX_API_KEY; // use the ChatGPT login in auth.json
  const args = ['exec', '--json', '--skip-git-repo-check', '--ignore-user-config', '-s', 'read-only', '-C', work,
    '-m', model, '-c', 'model_reasoning_effort="low"', ...refs.flatMap((r) => ['-i', r]), '-'];
  const { cmd, pre, shell } = codexCommand();
  const t0 = Date.now();
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, '').replace('T', '-');
  const base = (name || 'image').replace(/[\\/:*?"<>|\s]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 60) || 'image';

  // Each picture is copied to outDir as soon as Codex has finished writing it, and reported with its path, so the
  // caller can show it while the others are still being drawn. saved: Codex file -> our file (in creation order).
  const saved = new Map(), sizes = new Map();
  const listMade = (dir) => (fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => /\.(png|jpe?g|webp)$/i.test(f)).map((f) => path.join(dir, f))
    .sort((a, b) => fs.statSync(a).mtimeMs - fs.statSync(b).mtimeMs) : []);
  function saveReady(dir, final) {
    const fresh = [];
    for (const src of listMade(dir)) {
      if (saved.has(src)) continue;
      const size = fs.statSync(src).size;
      if (!final && (!size || sizes.get(src) !== size)) { sizes.set(src, size); continue; } // still being written: wait one more tick
      const k = saved.size + 1;
      const dst = path.join(outDir, `${base}-${stamp}${n > 1 || k > 1 ? '-' + k : ''}${path.extname(src).toLowerCase()}`);
      fs.copyFileSync(src, dst);
      saved.set(src, dst); fresh.push(dst);
    }
    return fresh;
  }

  const { threadId, errors, lastMessage } = await new Promise((resolve, reject) => {
    const child = spawn(cmd, [...pre, ...args], { env, cwd: work, shell: !!shell, windowsHide: true });
    let buf = '', threadId = null, lastMessage = '';
    const errors = [];
    // Codex reports no progress while drawing, but each finished picture is written to generated_images/<thread>/
    // right away: watch that folder to report (and save) "image k of n".
    const watch = setInterval(() => {
      if (!threadId) return;
      try {
        const fresh = saveReady(path.join(CODEX_HOME, 'generated_images', threadId), false);
        const k = saved.size;
        if (fresh.length) progress({ stage: 'image', text: `已生成第 ${k} 张${n > 1 ? `（共 ${n} 张）` : ''}`, model, done: k, file: fresh.at(-1), files: [...saved.values()] });
        else if (k >= n) progress({ stage: 'image', text: n > 1 ? `已生成 ${k} 张，正在收尾` : '图片已生成，正在收尾', model, done: k, files: [...saved.values()] });
        else progress({ stage: 'generating', text: n > 1 ? `正在生成第 ${k + 1} 张（共 ${n} 张）` : '正在生成图片', model, done: k, files: [...saved.values()] });
      } catch {}
    }, 1000);
    const timer = setTimeout(() => { child.kill(); reject(new Error(`codex timed out after ${Math.round(timeoutMs / 1000)}s`)); }, timeoutMs);
    child.stdout.on('data', (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
        if (!line.startsWith('{')) continue;
        let e; try { e = JSON.parse(line); } catch { continue; }
        onEvent?.(e);
        if (e.type === 'thread.started') threadId = e.thread_id;
        else if (e.type === 'turn.started') progress({ stage: 'generating', text: n > 1 ? `正在生成第 1 张（共 ${n} 张）` : '正在生成图片', model, done: 0 });
        else if (e.type === 'turn.failed') errors.push(e.error?.message || 'turn failed');
        else if (e.type === 'error' && !/^Reconnecting/.test(e.message || '')) errors.push(e.message);
        else if (e.type === 'item.completed' && e.item?.type === 'agent_message') lastMessage = e.item.text || '';
      }
    });
    let stderr = '';
    child.stderr.on('data', (d) => { stderr += d; if (stderr.length > 20000) stderr = stderr.slice(-20000); });
    child.on('error', (e) => { clearTimeout(timer); clearInterval(watch); reject(new Error('could not start codex: ' + e.message)); });
    child.on('close', (code) => {
      clearTimeout(timer); clearInterval(watch);
      if (code !== 0 && !threadId) return reject(new Error(`codex exited with ${code}: ${(errors.join('; ') || stderr).slice(-800)}`));
      resolve({ threadId, errors, lastMessage });
    });
    child.stdin.end(instruction({ prompt: String(prompt), aspect, n, refs }));
  });
  fs.rmSync(work, { recursive: true, force: true });

  // Codex has exited, so every picture is complete: save whatever the watcher hasn't copied yet.
  const genDir = threadId && path.join(CODEX_HOME, 'generated_images', threadId);
  if (genDir) {
    const before = saved.size;
    saveReady(genDir, true);
    if (saved.size > before) progress({ stage: 'saving', text: '正在保存图片', model, done: saved.size, file: [...saved.values()].at(-1), files: [...saved.values()] });
  }
  const files = [...saved.values()];
  if (!files.length) {
    const why = errors.map((e) => String(e).replace(/\{.*"message\\?":\\?"([^"\\]+).*/, '$1')).join('; ');
    throw new Error('codex did not produce an image' + (why ? ': ' + why.slice(0, 600) : lastMessage ? ` (codex said: ${lastMessage.slice(0, 300)})` : ''));
  }
  return { files, seconds: Math.round((Date.now() - t0) / 1000), threadId, model };
}

// ---------- CLI ----------
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const a = process.argv.slice(2), opt = { refs: [] };
  for (let i = 0; i < a.length; i++) {
    const k = a[i], v = a[i + 1];
    if (k === '--prompt') { opt.prompt = v; i++; }
    else if (k === '--prompt-file') { opt.prompt = fs.readFileSync(v, 'utf8'); i++; }
    else if (k === '--out') { opt.outDir = v; i++; }
    else if (k === '--name') { opt.name = v; i++; }
    else if (k === '--aspect') { opt.aspect = v; i++; }
    else if (k === '--n') { opt.n = Number(v); i++; }
    else if (k === '--ref') { opt.refs.push(v); i++; }
    else if (k === '--model') { opt.model = v; i++; }
    else if (k === '--timeout') { opt.timeoutMs = Number(v) * 1000; i++; }
    else if (k === '-h' || k === '--help') { console.log(fs.readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').slice(1, 6).join('\n')); process.exit(0); }
    else if (!opt.prompt) opt.prompt = k;
  }
  let last = '';
  opt.onProgress = (p) => { // progress lines go to stderr; stdout keeps the single JSON result
    const line = `[image-gen] ${String(p.elapsed).padStart(3)}s  ${p.text}${p.model && p.stage !== 'done' ? `  (${p.model})` : ''}`;
    if (p.text !== last || p.elapsed % 10 === 0) { process.stderr.write(line + '\n'); last = p.text; }
  };
  generateImage(opt)
    .then((r) => { console.log(JSON.stringify({ ok: true, ...r })); })
    .catch((e) => { console.log(JSON.stringify({ ok: false, error: String(e?.message || e) })); process.exit(1); });
}
