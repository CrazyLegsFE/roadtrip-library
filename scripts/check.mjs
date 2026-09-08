import { promises as fs } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const files = [];
async function walk(directory) {
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    if (['.git', 'data', 'demo-data', 'node_modules'].includes(entry.name)) continue;
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) await walk(target);
    else if (entry.isFile()) files.push(target);
  }
}
await walk(root);
let errors = 0;
for (const filename of files) {
  if (/\.(mjs|js)$/.test(filename)) {
    const check = spawnSync(process.execPath, ['--check', filename], { encoding: 'utf8' });
    if (check.status !== 0) { console.error(check.stderr); errors++; }
  }
  if (!filename.endsWith('.md')) continue;
  const content = await fs.readFile(filename, 'utf8');
  for (const match of content.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)) {
    const link = match[1].split('#')[0];
    if (!link || /^[a-z]+:/i.test(link)) continue;
    const target = path.resolve(path.dirname(filename), decodeURIComponent(link));
    try { await fs.access(target); } catch { console.error(`Broken documentation link: ${path.relative(root, filename)} -> ${link}`); errors++; }
  }
}
if (errors) process.exit(1);
console.log('JavaScript syntax and relative documentation links pass.');
