// Turns a Word .docx into Markdown text plus its embedded images, so Claude can read it.
// (Claude's Read tool cannot open .docx: it is a zip archive.) Like claude.ai, the text is handed to Claude
// directly; images are saved next to it and referenced in the text as 「图 N」 at the place they appear.
import fs from 'node:fs';
import path from 'node:path';
import mammoth from 'mammoth';
import TurndownService from 'turndown';
import { gfm } from 'turndown-plugin-gfm';

const EXT = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp', 'image/bmp': 'bmp',
  'image/x-emf': 'emf', 'image/x-wmf': 'wmf', 'image/tiff': 'tif', 'image/svg+xml': 'svg' };
export const READABLE_IMAGE = /^image\/(png|jpeg|gif|webp)$/;

// Returns { dir, mdPath, markdown, images: [{ n, file, type, size, readable }], messages }.
// Results are cached in <file>.extracted/ and reused while the .docx is unchanged.
export async function extractDocx(file) {
  const dir = file + '.extracted';
  const mdPath = path.join(dir, 'document.md');
  const metaPath = path.join(dir, 'meta.json');
  const stat = fs.statSync(file);
  if (fs.existsSync(metaPath)) {
    try {
      const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
      if (meta.mtime === stat.mtimeMs && meta.size === stat.size && fs.existsSync(mdPath))
        return { dir, mdPath, markdown: fs.readFileSync(mdPath, 'utf8'), images: meta.images, messages: meta.messages };
    } catch {}
  }
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });

  const images = [];
  const convertImage = mammoth.images.imgElement(async (img) => {
    const n = images.length + 1;
    const type = img.contentType || 'application/octet-stream';
    const buf = await img.read();
    const name = `image-${String(n).padStart(2, '0')}.${EXT[type] || 'bin'}`;
    fs.writeFileSync(path.join(dir, name), buf);
    images.push({ n, file: path.join(dir, name), type, size: buf.length, readable: READABLE_IMAGE.test(type) });
    return { src: name, alt: `图 ${n}` };
  });
  const { value: html, messages } = await mammoth.convertToHtml({ path: file }, { convertImage });

  const td = new TurndownService({ headingStyle: 'atx', codeBlockStyle: 'fenced', bulletListMarker: '-' });
  td.use(gfm);
  // Images become a visible marker with the file name, so text and pictures can be matched up.
  td.addRule('docxImage', { filter: 'img', replacement: (_, node) => `\n\n[${node.getAttribute('alt')}：${node.getAttribute('src')}]\n\n` });
  // Tables whose first row isn't a header row are dropped by the gfm plugin: keep them as tables anyway.
  td.addRule('anyTable', {
    filter: (node) => node.nodeName === 'TABLE',
    replacement: (_, node) => {
      const cell = (c) => td.turndown(c.innerHTML || '').replace(/\n+/g, ' ').replace(/\|/g, '\\|').trim();
      const rows = Array.from(node.getElementsByTagName('tr'))
        .map((tr) => Array.from(tr.childNodes).filter((c) => c.nodeName === 'TD' || c.nodeName === 'TH').map(cell));
      if (!rows.length) return '';
      const w = Math.max(...rows.map((r) => r.length));
      const line = (r) => '| ' + Array.from({ length: w }, (_, i) => r[i] || '').join(' | ') + ' |';
      return '\n\n' + [line(rows[0]), '|' + ' --- |'.repeat(w), ...rows.slice(1).map(line)].join('\n') + '\n\n';
    },
  });
  const markdown = td.turndown(html).replace(/\n{3,}/g, '\n\n').trim();
  fs.writeFileSync(mdPath, markdown);
  const msgs = messages.filter((m) => m.type === 'error').map((m) => m.message).slice(0, 5);
  fs.writeFileSync(metaPath, JSON.stringify({ mtime: stat.mtimeMs, size: stat.size, images, messages: msgs }));
  return { dir, mdPath, markdown, images, messages: msgs };
}
