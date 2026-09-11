import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../server.mjs';
import { loadManifest, saveManifest, connectManifest, requestSignal, validateManifest, transferPart, adoptExisting, WakeGuard, CHUNK_SIZE } from '../public/transfer.js';

// Transactional adapter models browser writes: bytes commit only on close;
// abort and write failures leave the previous committed file untouched.
class Directory {
  constructor() { this.files = new Map(); this.failAfter = Infinity; this.written = 0; this.failManifest = false; this.preservedBytes = 0; }
  async getFileHandle(name, { create = false } = {}) {
    if (!this.files.has(name)) { if (!create) throw new DOMException('Missing', 'NotFoundError'); this.files.set(name, Buffer.alloc(0)); }
    const directory = this;
    return {
      async getFile() { return new Blob([directory.files.get(name)]); },
      async createWritable({ keepExistingData = false } = {}) {
        if (keepExistingData && name !== '.roadtrip-drive.json') directory.preservedBytes += directory.files.get(name).length;
        let staged = keepExistingData ? Buffer.from(directory.files.get(name)) : Buffer.alloc(0), offset = 0, closed = false;
        return {
          async truncate(size) { const next = Buffer.alloc(size); staged.copy(next, 0, 0, size); staged = next; },
          async seek(position) { offset = position; },
          async write(data) {
            if (closed) throw new Error('Closed');
            const buffer = Buffer.from(data);
            if (name !== '.roadtrip-drive.json') { directory.written += buffer.length; if (directory.written > directory.failAfter) throw new DOMException('Disk full', 'QuotaExceededError'); }
            if (name === '.roadtrip-drive.json' && directory.failManifest) throw new DOMException('Cannot save manifest', 'QuotaExceededError');
            if (offset + buffer.length > staged.length) { const next = Buffer.alloc(offset + buffer.length); staged.copy(next); staged = next; }
            buffer.copy(staged, offset); offset += buffer.length;
          },
          async close() { directory.files.set(name, staged); closed = true; },
          async abort() { closed = true; },
        };
      },
    };
  }
}
function source(t, size = CHUNK_SIZE * 3 + 97) {
  const content = Buffer.alloc(size);
  for (let i = 0; i < content.length; i += 4096) content[i] = (i / 4096) % 251;
  const part = { id: 'movie:1', filename: 'Test Movie.mkv', size, version: 'source-version' };
  const requests = [];
  let changed = false, corrupt = false;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options = {}) => {
    if (options.signal?.aborted) throw new DOMException('Paused', 'AbortError');
    if (changed) return new Response(JSON.stringify({ error: 'The source movie changed.' }), { status: 409, headers: { 'Content-Type': 'application/json' } });
    if (String(url).includes('info=1')) return Response.json(part);
    const [, first, last] = /bytes=(\d+)-(\d+)/.exec(options.headers.Range);
    const start = Number(first), end = Number(last); requests.push(start);
    const chunk = content.subarray(start, end + 1);
    const hash = createHash('sha256').update(chunk).digest('hex');
    return new Response(String(url).includes('digest=1') ? Buffer.alloc(0) : chunk, { status: 206, headers: { 'Content-Range': `bytes ${start}-${end}/${size}`, ETag: '"source-version"', 'X-Chunk-SHA256': corrupt ? 'x' : hash } });
  };
  t.after(() => { globalThis.fetch = originalFetch; });
  return { part, content, requests, change: () => { changed = true; }, corrupt: () => { corrupt = true; } };
}
test('a completed transfer matches source bytes and records committed checksums', async t => {
  const src = source(t), directory = new Directory(), manifest = await loadManifest(directory);
  await transferPart(directory, manifest, src.part, undefined, () => {}, { checkpointSize: CHUNK_SIZE * 2 });
  assert.deepEqual(directory.files.get(src.part.filename), src.content);
  const saved = await loadManifest(directory);
  assert.equal(saved.records[src.part.id].status, 'ready');
  assert.equal(saved.records[src.part.id].chunks.length, 4);
  src.requests.length = 0;
  const result = await transferPart(directory, saved, src.part);
  assert.equal(result.skipped, true); assert.equal(src.requests.length, 0);
});
test('growing checkpoints bound repeated USB copying and resume after a later failure', async t => {
  const src = source(t, CHUNK_SIZE * 9 + 97), directory = new Directory();
  directory.failAfter = CHUNK_SIZE * 6;
  await assert.rejects(transferPart(directory, await loadManifest(directory), src.part, undefined, () => {}, { checkpointSize: CHUNK_SIZE }), { name: 'QuotaExceededError' });
  const saved = await loadManifest(directory);
  assert.equal(saved.records[src.part.id].chunks.length, 4);
  assert.equal(directory.files.get(src.part.filename).length, CHUNK_SIZE * 4);
  directory.failAfter = Infinity; directory.preservedBytes = 0; src.requests.length = 0;
  await transferPart(directory, saved, src.part, undefined, () => {}, { checkpointSize: CHUNK_SIZE });
  assert.equal(src.requests[0], CHUNK_SIZE * 4);
  assert.deepEqual(directory.files.get(src.part.filename), src.content);
  assert.ok(directory.preservedBytes < 2 * src.part.size);
  assert.equal((await loadManifest(directory)).records[src.part.id].status, 'ready');
});
test('disk full preserves committed checkpoint; a fresh session resumes at that offset', async t => {
  const src = source(t), directory = new Directory(), manifest = await loadManifest(directory);
  directory.failAfter = CHUNK_SIZE * 2;
  await assert.rejects(transferPart(directory, manifest, src.part, undefined, () => {}, { checkpointSize: CHUNK_SIZE * 2 }), { name: 'QuotaExceededError' });
  assert.equal(directory.files.get(src.part.filename).length, CHUNK_SIZE * 2);
  const restored = await loadManifest(directory);
  assert.equal(restored.records[src.part.id].status, 'partial');
  assert.equal(restored.records[src.part.id].chunks.length, 2);
  directory.failAfter = Infinity; src.requests.length = 0;
  await transferPart(directory, restored, src.part, undefined, () => {}, { checkpointSize: CHUNK_SIZE * 2 });
  assert.equal(src.requests[0], CHUNK_SIZE * 2);
  assert.deepEqual(directory.files.get(src.part.filename), src.content);
});
test('pause aborts the open checkpoint and permits later retry', async t => {
  const src = source(t), directory = new Directory(), manifest = await loadManifest(directory), controller = new AbortController();
  await assert.rejects(transferPart(directory, manifest, src.part, controller.signal, p => { if (p.phase === 'Copying') controller.abort(); }), { name: 'AbortError' });
  assert.equal(directory.files.get(src.part.filename).length, 0);
  assert.equal((await loadManifest(directory)).records[src.part.id].chunks.length, 0);
  await transferPart(directory, await loadManifest(directory), src.part);
  assert.deepEqual(directory.files.get(src.part.filename), src.content);
});
test('changed source and changed USB checkpoints are rejected without overwrite', async t => {
  const src = source(t, 50), directory = new Directory(), manifest = await loadManifest(directory);
  await transferPart(directory, manifest, src.part);
  const original = Buffer.from(directory.files.get(src.part.filename));
  directory.files.get(src.part.filename)[0] ^= 1;
  await assert.rejects(transferPart(directory, manifest, src.part), /checkpoint check/);
  directory.files.set(src.part.filename, original); src.change();
  await assert.rejects(transferPart(directory, manifest, src.part), /source movie changed/);
  assert.deepEqual(directory.files.get(src.part.filename), original);
});
test('unmanaged name collision is never overwritten', async t => {
  const src = source(t, 100), directory = new Directory();
  directory.files.set(src.part.filename, Buffer.from('An unrelated file'));
  await assert.rejects(transferPart(directory, await loadManifest(directory), src.part), /already exists/);
  assert.equal(directory.files.get(src.part.filename).toString(), 'An unrelated file');
});
test('existing matching file is adopted only after content verification', async t => {
  const src = source(t, 100), directory = new Directory(), manifest = await loadManifest(directory);
  directory.files.set('Original Film.mkv', Buffer.from(src.content));
  await adoptExisting(directory, manifest, src.part, 'Original Film.mkv');
  assert.equal(manifest.records[src.part.id].adopted, true);
  assert.equal((await transferPart(directory, manifest, src.part)).skipped, true);
  assert.ok(!directory.files.has(src.part.filename));
});
test('existing different file is preserved and not adopted', async t => {
  const src = source(t, 100), directory = new Directory(), manifest = await loadManifest(directory);
  directory.files.set('Original Film.mkv', Buffer.alloc(100, 7));
  await assert.rejects(adoptExisting(directory, manifest, src.part, 'Original Film.mkv'), /differs from/);
  assert.equal(manifest.records[src.part.id], undefined);
  assert.deepEqual(directory.files.get('Original Film.mkv'), Buffer.alloc(100, 7));
});
test('manifest save failure never advances the durable checkpoint', async t => {
  const src = source(t, 100), directory = new Directory(), manifest = await loadManifest(directory);
  await assert.rejects(transferPart(directory, manifest, src.part, undefined, p => { if (p.phase === 'Saving checkpoint') directory.failManifest = true; }), { name: 'QuotaExceededError' });
  const restored = await loadManifest(directory);
  assert.equal(restored.records[src.part.id].chunks.length, 0);
  assert.equal(restored.records[src.part.id].status, 'partial');
  directory.failManifest = false;
  await transferPart(directory, restored, src.part);
  assert.deepEqual(directory.files.get(src.part.filename), src.content);
});
test('invalid server checksum does not commit payload bytes', async t => {
  const src = source(t, 100), directory = new Directory(), manifest = await loadManifest(directory); src.corrupt();
  await assert.rejects(transferPart(directory, manifest, src.part), /valid checksum/);
  assert.equal(directory.files.get(src.part.filename).length, 0);
});
test('manifest rejects path traversal and noncontiguous checkpoints', async () => {
  const directory = new Directory(), manifest = await loadManifest(directory);
  const record = { filename: '../outside.mkv', version: '1', size: 10, status: 'partial', chunks: [] };
  manifest.records.bad = record;
  assert.throws(() => validateManifest(manifest), /damaged/);
  record.filename = 'safe.mkv'; record.chunks = [{ start: 1, length: 1, hash: '0'.repeat(64) }];
  assert.throws(() => validateManifest(manifest), /damaged/);
});
test('wake lock is released on stop and reacquired on return to a visible tab', async t => {
  const oldNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator'), oldDocument = globalThis.document;
  const doc = new EventTarget(); doc.visibilityState = 'visible';
  const locks = [];
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { wakeLock: { request: async () => { const lock = new EventTarget(); lock.release = async () => { lock.released = true; lock.dispatchEvent(new Event('release')); }; locks.push(lock); return lock; } } } });
  globalThis.document = doc;
  t.after(() => { if (oldNavigator) Object.defineProperty(globalThis, 'navigator', oldNavigator); else delete globalThis.navigator; if (oldDocument) globalThis.document = oldDocument; else delete globalThis.document; });
  const statuses = [], guard = new WakeGuard(value => statuses.push(value));
  await guard.start(); assert.equal(locks.length, 1);
  await locks[0].release(); assert.ok(statuses.at(-1).includes('released'));
  doc.dispatchEvent(new Event('visibilitychange')); await new Promise(resolve => setImmediate(resolve));
  assert.equal(locks.length, 2);
  await guard.stop(); assert.equal(locks[1].released, true);
  doc.dispatchEvent(new Event('visibilitychange')); assert.equal(locks.length, 2);
});
test('real HTTP server and browser transfer engine agree on bytes, versions and digests', async t => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'roadtrip-wire-'));
  const app = await createApp({ dataDir, demo: true, origin: 'http://localhost:8787' });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const originalFetch = globalThis.fetch;
  t.after(async () => {
    globalThis.fetch = originalFetch;
    await new Promise(resolve => { app.server.close(resolve); app.server.closeAllConnections(); });
    assert.ok(path.dirname(dataDir) === await fs.realpath(os.tmpdir()) || path.dirname(dataDir) === os.tmpdir());
    await fs.rm(dataDir, { recursive: true, force: true });
  });
  globalThis.fetch = (url, options) => originalFetch(new URL(url, base), options);
  const library = await (await fetch('/api/library')).json();
  const part = library.movies[0].variants[0].parts[0];
  const directory = new Directory(), manifest = await loadManifest(directory);
  await transferPart(directory, manifest, part);
  assert.deepEqual(directory.files.get(part.filename), Buffer.alloc(part.size, 1));
  const existingDir = new Directory(), existingManifest = await loadManifest(existingDir);
  existingDir.files.set('Existing.bin', directory.files.get(part.filename));
  await adoptExisting(existingDir, existingManifest, part, 'Existing.bin');
  assert.equal(existingManifest.records[part.id].status, 'ready');
});
test('simultaneous first connections receive one persistent drive ID', async () => {
  const directory = new Directory();
  let tail = Promise.resolve();
  const locks = { request(_name, action) { const next = tail.then(action); tail = next.catch(() => {}); return next; } };
  const [a, b] = await Promise.all([connectManifest(directory, locks), connectManifest(directory, locks)]);
  assert.equal(a.id, b.id);
  assert.equal((await loadManifest(directory)).id, a.id);
  const before = Buffer.from(directory.files.get('.roadtrip-drive.json'));
  await connectManifest(directory, locks);
  assert.deepEqual(directory.files.get('.roadtrip-drive.json'), before);
});
test('duplicate filenames and null checkpoint entries are rejected', async () => {
  const manifest = await loadManifest(new Directory());
  const record = { filename: 'film.mkv', version: 'v1', size: 1, status: 'partial', chunks: [] };
  manifest.records.a = record;
  manifest.records.b = { ...record, filename: 'FILM.mkv' };
  assert.throws(() => validateManifest(manifest), /same file/);
  delete manifest.records.b;
  record.chunks = [null]; assert.throws(() => validateManifest(manifest), /damaged/);
  manifest.records.a = null; assert.throws(() => validateManifest(manifest), /damaged/);
});
test('request deadline aborts a stalled operation and preserves manual cancellation', async () => {
  const deadline = requestSignal(undefined, 10);
  await new Promise(resolve => setTimeout(resolve, 25));
  assert.equal(deadline.aborted, true);
  assert.equal(deadline.reason.name, 'TimeoutError');
  const controller = new AbortController(), combined = requestSignal(controller.signal, 1000);
  controller.abort(); assert.equal(combined.aborted, true);
  assert.equal(combined.reason.name, 'AbortError');
});
test('synchronous wake-lock rejection does not leave transfer lifecycle stuck', async t => {
  const oldNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator'), oldDocument = globalThis.document;
  globalThis.document = new EventTarget();
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { wakeLock: { request() { throw new DOMException('Denied', 'NotAllowedError'); } } } });
  t.after(() => { if (oldNavigator) Object.defineProperty(globalThis, 'navigator', oldNavigator); else delete globalThis.navigator; if (oldDocument) globalThis.document = oldDocument; else delete globalThis.document; });
  const statuses = [], guard = new WakeGuard(s => statuses.push(s));
  await guard.start(); assert.equal(guard.pending, null);
  assert.ok(statuses.at(-1).includes('unavailable'));
  await guard.stop(); assert.equal(guard.active, false);
});
