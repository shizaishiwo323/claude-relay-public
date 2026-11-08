// Finds the files Claude produced during one reply (documents, figures, videos…) so the page can offer them for download.
// Sources, all limited to files created or changed while the reply was running:
//   1. anything new under <workdir>/outputs (where skills such as docx/pptx save their results),
//   2. targets of the Write tool,
//   3. absolute paths that appear in tool calls, tool results or the reply text.
import fs from 'node:fs';
import path from 'node:path';

// Documents, data, images, video/audio, archives. Source code and config (.js, .py, .json…) are build steps, not results.
export const DELIVERABLE = /\.(docx?|xlsx?|pptx?|pdf|odt|ods|odp|rtf|csv|tsv|md|txt|html?|png|jpe?g|gif|webp|svg|tiff?|bmp|eps|mp4|mov|webm|mkv|avi|m4v|mp3|wav|m4a|ogg|flac|zip|7z|tar|gz|tex|bib|ipynb)$/i;
// .claude / tool-results: Claude Code's own copies of tool output (e.g. an image a tool returned), not user deliverables.
const SKIP_DIR = /^(node_modules|\.git|\.cache|__pycache__|\.venv|venv|preview|tmp|temp|\.claude|\.codex|tool-results)$/i;
const MAX_FILES = 30;

const WIN = process.platform === 'win32';
const winPath = (p) => {
  if (WIN) p = p.replace(/^\/([a-z])\//i, (_, d) => d.toUpperCase() + ':\\'); // /c/Users/... (Git Bash) -> C:\Users\...
  return path.normalize(p);
};
// Absolute paths ending in a deliverable extension (stops at quotes, brackets, newlines):
// Windows / Git-Bash paths on Windows, /home/... style paths elsewhere (not the //host/... part of a URL).
const PATH_RE = WIN
  ? /(?:[A-Za-z]:[\\/]|\/[a-z]\/)[^\n\r"'`<>|*?()\[\]{}]*?\.[A-Za-z0-9]{1,5}(?=$|[\s"'`<>|)\]},;，。；：:！!？?])/g
  : /(?<![\w:/.~-])\/[^\s"'`<>|*?()\[\]{}]*?\.[A-Za-z0-9]{1,5}(?=$|[\s"'`<>|)\]},;，。；：:！!？?])/g;

function walk(dir, depth, out) {
  let ents; try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of ents) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (depth > 0 && !SKIP_DIR.test(e.name)) walk(p, depth - 1, out); }
    else if (e.isFile()) out.push(p);
  }
}

// turn: the assistant message ({ blocks, startedAt, result }); window: [from, to] in ms.
export function detectFiles(turn, { workdir, uploadDir, from, to }) {
  const cands = new Set();
  const outs = []; walk(path.join(workdir, 'outputs'), 4, outs); outs.forEach((p) => cands.add(p));
  const texts = [];
  for (const b of turn.blocks || []) {
    if (b?.type === 'tool') {
      const inp = b.input || {};
      if (/^(Write|Edit|NotebookEdit)$/.test(b.name) && inp.file_path) cands.add(winPath(String(inp.file_path)));
      texts.push(JSON.stringify(inp));
      if (typeof b.result === 'string') texts.push(b.result.slice(0, 20000));
    } else if (b?.type === 'text') texts.push(b.text || '');
  }
  for (const t of texts) for (const m of t.replace(/\\\\/g, '\\').matchAll(PATH_RE)) cands.add(winPath(m[0].trim()));

  const up = uploadDir && path.resolve(uploadDir).toLowerCase() + path.sep;
  const files = [];
  for (const p of cands) {
    if (files.length >= MAX_FILES) break;
    if (!DELIVERABLE.test(p)) continue;
    if (up && path.resolve(p).toLowerCase().startsWith(up)) continue; // the user's own uploads
    if (p.split(path.sep).some((s) => SKIP_DIR.test(s))) continue;
    let st; try { st = fs.statSync(p); } catch { continue; }
    if (!st.isFile() || st.mtimeMs < from - 2000 || st.mtimeMs > to + 2000) continue;
    files.push({ name: path.basename(p), path: p, size: st.size, mtime: Math.round(st.mtimeMs) });
  }
  return files.sort((a, b) => a.mtime - b.mtime);
}
