import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { setTimeout } from 'node:timers/promises';

const base = new URL(process.argv[2] || 'http://localhost:8787');
let ready = false;
for (let attempt = 0; attempt < 30; attempt++) {
  try { if ((await fetch(new URL('/health', base), { signal: AbortSignal.timeout(1000) })).ok) { ready = true; break; } } catch {}
  await setTimeout(1000);
}
assert.ok(ready, 'Demo server did not become healthy.');
assert.equal((await fetch(base)).status, 200);
const library = await (await fetch(new URL('/api/library', base))).json();
assert.equal(library.demo, true, 'Run this check only against demo mode.');
assert.equal(library.movies.length, 6);
const part = library.movies[0].variants[0].parts[0];
const route = new URL(`/api/files/${encodeURIComponent(part.id)}?version=${part.version}`, base);
const response = await fetch(route, { headers: { Range: 'bytes=0-1023' } });
assert.equal(response.status, 206);
const data = Buffer.from(await response.arrayBuffer());
assert.equal(data.length, 1024);
assert.equal(response.headers.get('x-chunk-sha256'), createHash('sha256').update(data).digest('hex'));
console.log('Container health, demo catalog, byte range and SHA-256 verification pass.');
