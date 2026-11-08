// Turns a Claude Code session transcript (.jsonl) into readable Markdown:
// user messages, Claude's replies, and one line per tool call (tool output is left out).
// Usage: node tools/export-transcript.mjs <in.jsonl> <out.md>
import fs from 'node:fs';

const [inFile, outFile] = process.argv.slice(2);
if (!inFile || !outFile) { console.error('usage: node tools/export-transcript.mjs <in.jsonl> <out.md>'); process.exit(1); }

const strip = (t) => t
  .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '')
  .replace(/<(command-name|command-message|command-args|local-command-stdout)>[\s\S]*?<\/\1>/g, '')
  .trim();
const toolLine = (b) => {
  const i = b.input || {};
  const arg = i.command || i.file_path || i.pattern || i.url || i.query || i.description || i.skill || '';
  return `- 🔧 **${b.name}** ${String(arg).split('\n')[0].slice(0, 160)}`;
};

const out = [`# 会话记录 ${inFile.split(/[\\/]/).pop()}`, ''];
let last = '';
for (const line of fs.readFileSync(inFile, 'utf8').split('\n')) {
  if (!line.trim()) continue;
  let e; try { e = JSON.parse(line); } catch { continue; }
  if (e.isSidechain || e.isMeta || (e.type !== 'user' && e.type !== 'assistant')) continue; // isMeta: injected skill text
  if (e.type === 'user' && e.isCompactSummary) { out.push('', '---', '_(上下文已压缩，以下为续接)_', '---', ''); continue; }
  const c = e.message?.content;
  const blocks = typeof c === 'string' ? [{ type: 'text', text: c }] : Array.isArray(c) ? c : [];
  const parts = [];
  for (const b of blocks) {
    if (b.type === 'text') { const t = strip(b.text || ''); if (t) parts.push(t); }
    else if (b.type === 'tool_use' && e.type === 'assistant') parts.push(toolLine(b));
  }
  if (!parts.length) continue;
  const who = e.type === 'user' ? '## 🧑 用户' : '## 🤖 Claude';
  if (who !== last) { out.push('', who, e.timestamp ? `_${e.timestamp}_` : '', ''); last = who; }
  out.push(parts.join('\n\n'), '');
}
fs.writeFileSync(outFile, out.join('\n'));
console.log(`wrote ${outFile}`);
