import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { createHash } from 'node:crypto';
import { createApp, mapPlexPath, safeMedia, parseRange, sourceVersion, filenameFor, CHUNK_SIZE } from '../server.mjs';

const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`)));
const stop = server => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
async function fixture(t, { demo = false, thumb = '' } = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'roadtrip-test-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const media = path.join(directory, 'media'); await fs.mkdir(media);
  const file = path.join(media, 'Film.mkv'); await fs.writeFile(file, Buffer.from('This is test movie data.'));
  await fs.writeFile(path.join(media, '.mounted'), 'ready');
  let plexCalls = 0;
  const plex = http.createServer((req, res) => {
    plexCalls++;
    if (req.headers['x-plex-token'] !== 'test-token') { res.writeHead(401).end(); return; }
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/library/sections') return res.end(JSON.stringify({ MediaContainer: { Directory: [{ key: '1', type: 'movie', title: 'Movies' }, { key: '2', type: 'show', title: 'TV' }] } }));
    if (req.url.startsWith('/library/sections/1/all')) return res.end(JSON.stringify({ MediaContainer: { totalSize: 1, Metadata: [{ ratingKey: '42', title: 'Test Film', year: 2024, duration: 6000000, thumb, summary: 'A test description', Genre: [{ tag: 'Adventure' }], Media: [{ id: '1', videoResolution: '1080', container: 'mkv', Part: [{ id: '11', file: '/plex/movies/Film.mkv' }] }] }] } }));
    res.writeHead(404).end();
  });
  const plexUrl = await listen(plex); t.after(() => stop(plex));
  const config = { dataDir: path.join(directory, 'data'), password: 'test-family-password', origin: 'http://localhost:8787', plexUrl, plexToken: 'test-token', mappings: [{ plex: '/plex/movies', local: media, sentinel: '.mounted' }], demo };
  const app = await createApp(config), base = await listen(app.server); t.after(() => stop(app.server));
  const response = await fetch(base + '/api/login', { method: 'POST', headers: { Origin: config.origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ password: config.password }) });
  const cookie = response.headers.get('set-cookie').split(';')[0];
  const request = (route, input, headers = {}) => fetch(base + route, { method: input === undefined ? 'GET' : 'POST', headers: { Cookie: cookie, ...(input !== undefined ? { Origin: config.origin, 'Content-Type': 'application/json' } : {}), ...headers }, ...(input !== undefined ? { body: JSON.stringify(input) } : {}) });
  return { app, base, file, media, config, request, plexCalls: () => plexCalls };
}
test('path mapping uses longest boundary-aware prefix and rejects traversal', () => {
  const mappings = [{ plex: '/plex', local: path.resolve('outer') }, { plex: '/plex/movies', local: path.resolve('inner') }];
  assert.equal(mapPlexPath('/plex/movies/Film.mkv', mappings), path.resolve('inner/Film.mkv'));
  assert.throws(() => mapPlexPath('/plex/movies/../../escape.mkv', mappings), /escapes/);
  assert.throws(() => mapPlexPath('/plex2/Film.mkv', mappings), /No media path/);
});
test('range boundaries reject oversized, suffix, multiple and invalid ranges', () => {
  assert.deepEqual(parseRange('bytes=0-9', 10), { start: 0, end: 9 });
  for (const range of ['bytes=-9', 'bytes=0-', 'bytes=8-7', 'bytes=0-1,3-4', 'bytes=9007199254740992-9007199254740993', `bytes=0-${CHUNK_SIZE}`]) assert.throws(() => parseRange(range, CHUNK_SIZE + 5), { status: 416 });
  assert.throws(() => parseRange('bytes=0-10', 10), { status: 416 });
});
test('generated filenames are safe and distinguish conflicting titles', () => {
  const first = filenameFor('.. / CON : Film?', 2024, 'a', '/a/file.mkv');
  assert.ok(!/[<>:"/\\|?*]/.test(first));
  assert.notEqual(first, filenameFor('.. / CON : Film?', 2024, 'b', '/a/file.mkv'));
});
test('authentication, origin protection and persistent shared state', async t => {
  const f = await fixture(t);
  assert.equal((await fetch(f.base + '/api/library')).status, 401);
  assert.equal((await f.request('/api/wishes', { title: 'Movie' }, { Origin: 'https://evil.example' })).status, 403);
  assert.equal((await f.request('/api/refresh', {})).status, 200);
  const library = await (await f.request('/api/library')).json();
  assert.equal(library.movies.length, 1);
  assert.equal(library.movies[0].variants[0].parts[0].originalName, 'Film.mkv');
  assert.ok(!JSON.stringify(library).includes(f.media));
  assert.ok(!JSON.stringify(library).includes('test-token'));
  const responses = await Promise.all(Array.from({ length: 12 }, (_, i) => f.request('/api/wishes', { title: `Wish ${i}`, who: 'Family' })));
  assert.ok(responses.every(r => r.ok));
  await f.request('/api/picks', { movieId: '42', variantId: '1', who: 'A' });
  await f.request('/api/picks', { movieId: '42', variantId: '1', who: 'B' });
  const state = await (await f.request('/api/state')).json();
  assert.equal(state.wishes.length, 12); assert.deepEqual(state.picks[0].people, ['A', 'B']);
  const saved = JSON.parse(await fs.readFile(path.join(f.config.dataDir, 'state.json')));
  assert.deepEqual(saved, state);
  const restarted = await createApp(f.config), base = await listen(restarted.server); t.after(() => stop(restarted.server));
  const login = await fetch(base + '/api/login', { method: 'POST', headers: { Origin: f.config.origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ password: f.config.password }) });
  const restored = await (await fetch(base + '/api/state', { headers: { Cookie: login.headers.get('set-cookie').split(';')[0] } })).json();
  assert.deepEqual(restored, state);
});
test('file API verifies versions, ranges and chunk hashes', async t => {
  const f = await fixture(t); await f.app.refresh();
  const library = await (await f.request('/api/library')).json();
  const part = library.movies[0].variants[0].parts[0];
  const route = `/api/files/${encodeURIComponent(part.id)}?version=${part.version}`;
  const response = await f.request(route, undefined, { Range: 'bytes=0-7' });
  assert.equal(response.status, 206); assert.equal(response.headers.get('content-range'), `bytes 0-7/${part.size}`);
  const payload = Buffer.from(await response.arrayBuffer());
  assert.equal(payload.toString(), 'This is ');
  assert.equal(response.headers.get('x-chunk-sha256'), createHash('sha256').update(payload).digest('hex'));
  const digestOnly = await f.request(route + '&digest=1', undefined, { Range: 'bytes=0-7' });
  assert.equal(digestOnly.status, 206); assert.equal((await digestOnly.arrayBuffer()).byteLength, 0);
  assert.equal(digestOnly.headers.get('x-chunk-sha256'), response.headers.get('x-chunk-sha256'));
  assert.equal((await f.request(route, undefined, { Range: 'bytes=999-1000' })).status, 416);
  await fs.appendFile(f.file, 'changed');
  assert.equal((await f.request(route, undefined, { Range: 'bytes=0-7' })).status, 409);
});
test('missing mount sentinel preserves cached catalog', async t => {
  const f = await fixture(t); await f.app.refresh();
  await fs.unlink(path.join(f.media, '.mounted'));
  await assert.rejects(f.app.refresh(), /sentinel is missing/);
  assert.equal((await (await f.request('/api/library')).json()).movies.length, 1);
});
test('safe media rejects files outside roots and symlink escapes', async t => {
  const f = await fixture(t);
  assert.equal(await safeMedia(f.file, [f.media]), await fs.realpath(f.file));
  await assert.rejects(safeMedia(path.join(f.config.dataDir, 'session.key'), [f.media]), { status: 403 });
  const link = path.join(f.media, 'escape');
  try { await fs.symlink(f.config.dataDir, link, process.platform === 'win32' ? 'junction' : 'dir'); } catch (e) { if (e.code === 'EPERM') { t.diagnostic('Symlink creation unavailable on this host; containment checks still tested.'); return; } throw e; }
  await assert.rejects(safeMedia(path.join(link, 'session.key'), [f.media]), { status: 403 });
});
test('version includes size and modification identity', () => {
  assert.notEqual(sourceVersion({ size: 1, mtimeMs: 1, ctimeMs: 1, ino: 1 }), sourceVersion({ size: 1, mtimeMs: 2, ctimeMs: 1, ino: 1 }));
});
test('non-object JSON and malformed drive entries produce controlled client errors', async t => {
  const f = await fixture(t);
  for (const input of [null, [], 7, 'text']) assert.equal((await f.request('/api/wishes', input)).status, 400);
  assert.equal((await f.request('/api/drives', { id: 'a'.repeat(36), files: [null] })).status, 400);
});
test('Plex resource paths cannot redirect the token to a different origin', async t => {
  const f = await fixture(t, { thumb: '/\\untrusted.example/poster' });
  await f.app.refresh(); const before = f.plexCalls();
  assert.equal((await f.request('/api/art/42')).status, 400);
  assert.equal(f.plexCalls(), before);
});
test('placeholder passwords and non-origin application URLs are rejected', async () => {
  await assert.rejects(createApp({ demo: false, password: 'replace-with-your-own-long-family-password' }), /your own password/);
  for (const origin of ['https://example.com/path', 'https://user:pass@example.com', 'https://example.com?query=1']) await assert.rejects(createApp({ demo: true, origin }), /must be an HTTP/);
});
