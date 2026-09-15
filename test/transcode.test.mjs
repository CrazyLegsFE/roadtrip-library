import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createTranscoder, encodeArgs } from '../transcode.mjs';

const metadata = { format: { duration: '10' }, streams: [{ index: 0, codec_type: 'video', codec_name: 'h264' }, { index: 1, codec_type: 'audio', tags: { language: 'eng' }, disposition: { default: 1 } }] };
test('encoder arguments use explicit streams and tone mapping without shell commands', () => {
  const args = encodeArgs('/movies/name;echo bad.mkv', '/cache/out.mp4', metadata, '720p', 'nvidia', 'default');
  assert.ok(args.includes('h264_nvenc')); assert.ok(args.includes('0:1')); assert.ok(args.includes('-sn'));
  assert.ok(args.includes('/movies/name;echo bad.mkv'));
  const hdr = structuredClone(metadata); hdr.streams[0].color_transfer = 'smpte2084';
  assert.match(encodeArgs('in', 'out', hdr, '1080p', 'cpu', 'default').join(' '), /tonemap=tonemap=hable/);
  assert.throws(() => encodeArgs('in', 'out', metadata, '4k', 'cpu', 'default'), /Invalid/);
  assert.throws(() => encodeArgs('in', 'out', metadata, '720p', 'cpu', '999'), /audio track/);
  hdr.streams[0].side_data_list = [{ side_data_type: 'DOVI configuration record' }];
  assert.throws(() => encodeArgs('in', 'out', hdr, '720p', 'cpu', 'default'), /Dolby Vision/);
});

async function fixture(t, { fail = false, slow = false, changed = false } = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'roadtrip-encode-'));
  let active = 0, maxActive = 0, encodes = 0, checks = 0;
  const spawnProcess = (command, args, options) => {
    assert.equal(options.shell, false);
    const process = new EventEmitter(); process.stdout = new EventEmitter(); process.stderr = new EventEmitter();
    let closed = false;
    const close = code => { if (closed) return; closed = true; if (command === 'ffmpeg') active--; process.emit('close', code); };
    process.kill = () => { queueMicrotask(() => close(1)); };
    if (command === 'ffmpeg') { active++; maxActive = Math.max(active, maxActive); encodes++; }
    setTimeout(async () => {
      if (closed) return;
      if (command === 'ffprobe') process.stdout.emit('data', Buffer.from(JSON.stringify(metadata)));
      else if (fail) { process.stderr.emit('data', Buffer.from('Encoder failed')); close(1); return; }
      else { await fs.writeFile(args.at(-1), 'encoded test movie'); process.stdout.emit('data', Buffer.from('out_time_us=10000000\nprogress=end\n')); }
      close(0);
    }, slow && command === 'ffmpeg' ? 100 : 2);
    return process;
  };
  const config = { directory, enabled: true, spawnProcess, versionOf: () => 'encoded-version', resolveSource: async () => { checks++; if (changed && checks >= 3) throw new Error('Source changed'); return { local: '/movie.mkv' }; } };
  const queue = await createTranscoder(config);
  t.after(async () => { await queue.stop(); await new Promise(r => setTimeout(r, 120)); await fs.rm(directory, { recursive: true, force: true }); });
  const enqueue = (preset = '720p') => queue.enqueue({ movieId: 'movie', sourceId: 'part', sourceVersion: 'v1', preset, title: 'Test', filename: 'Test.mkv' });
  return { queue, enqueue, directory, config, counts: () => ({ encodes, maxActive }) };
}
async function settle(queue) {
  for (let i = 0; i < 300; i++) { const jobs = queue.publicState().jobs; if (jobs.length && jobs.every(j => !['queued', 'running', 'cancelling'].includes(j.status))) return jobs; await new Promise(r => setTimeout(r, 10)); }
  throw new Error('Queue did not settle');
}
test('queue serializes encodes, reuses completed jobs, persists settings and serves output variants', async t => {
  const f = await fixture(t);
  await f.queue.settings({ encoder: 'nvidia', cacheGB: 8 });
  await Promise.all([f.enqueue('720p'), f.enqueue('1080p')]);
  const jobs = await settle(f.queue); assert.ok(jobs.every(j => j.status === 'ready'));
  assert.equal(f.counts().maxActive, 1);
  await f.enqueue('720p'); assert.equal(f.counts().encodes, 2);
  assert.equal(f.queue.variants('movie').length, 2);
  assert.ok(!JSON.stringify(f.queue.publicState()).includes('local'));
  const saved = JSON.parse(await fs.readFile(path.join(f.directory, 'queue.json')));
  assert.equal(saved.encoder, 'nvidia'); assert.equal(saved.jobs.length, 2);
  await f.queue.remove(jobs[0].id); assert.equal(f.queue.variants('movie').length, 1);
});
test('failed encode never becomes downloadable and cleans partial output', async t => {
  const f = await fixture(t, { fail: true }); await f.enqueue();
  assert.equal((await settle(f.queue))[0].status, 'failed'); assert.equal(f.queue.variants('movie').length, 0);
  assert.ok(!(await fs.readdir(f.directory)).some(n => n.endsWith('.partial')));
});
test('source change rejects completed encode', async t => {
  const f = await fixture(t, { changed: true }); await f.enqueue();
  assert.equal((await settle(f.queue))[0].status, 'failed'); assert.equal(f.queue.variants('movie').length, 0);
});
test('cancel terminates running job without publishing it', async t => {
  const f = await fixture(t, { slow: true }); await f.enqueue();
  await new Promise(r => setTimeout(r, 20));
  await f.queue.cancel(f.queue.publicState().jobs[0].id);
  assert.equal((await settle(f.queue))[0].status, 'cancelled'); assert.equal(f.queue.variants('movie').length, 0);
});
test('restart recovers interrupted jobs and disabled mode rejects conversion', async t => {
  const f = await fixture(t); await f.enqueue(); await settle(f.queue); await f.queue.stop();
  const state = JSON.parse(await fs.readFile(path.join(f.directory, 'queue.json'))); state.jobs[0].status = 'running';
  await fs.writeFile(path.join(f.directory, 'queue.json'), JSON.stringify(state));
  const disabled = await createTranscoder({ ...f.config, enabled: false });
  assert.equal(disabled.publicState().jobs[0].status, 'queued');
  await assert.rejects(disabled.enqueue({}), /Enable/); await disabled.stop();
  const recovered = await createTranscoder(f.config); await settle(recovered); assert.equal(recovered.publicState().jobs[0].status, 'ready'); await recovered.stop();
});
