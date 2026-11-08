// Builds the connector as single-file executables for macOS (Apple silicon + Intel) and Windows into connector/dist,
// with Bun's cross-compiler (fetched through npx, nothing installed globally). Run: node connector/build.mjs
// The binaries are not committed to Git (large); run this once on every machine that serves the relay.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const dist = path.join(here, 'dist');
fs.mkdirSync(dist, { recursive: true });
const targets = [
  ['bun-darwin-arm64', 'connector-mac-arm64'],
  ['bun-darwin-x64', 'connector-mac-x64'],
  ['bun-windows-x64', 'connector-win-x64.exe'],
];
const only = process.argv[2]; // optional: build one target, e.g. "windows"
for (const [target, out] of targets) {
  if (only && !target.includes(only)) continue;
  console.log(`building ${out} (${target})…`);
  execFileSync(process.platform === 'win32' ? 'npx.cmd' : 'npx', ['-y', 'bun@1', 'build', '--compile', '--minify', `--target=${target}`,
    path.join(here, 'connector.mjs'), '--outfile', path.join(dist, out)], { stdio: 'inherit', shell: process.platform === 'win32' });
  console.log(`  → ${(fs.statSync(path.join(dist, out)).size / 1e6).toFixed(1)} MB`);
}
