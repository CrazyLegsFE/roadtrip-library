import { promises as fs, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { createTranscoder } from '../transcode.mjs';
const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'roadtrip-transcode-smoke-'));
const input = path.join(directory, 'input.mp4');
let queue;
try {
  const source = spawnSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=24', '-f', 'lavfi', '-i', 'sine=frequency=440', '-t', '2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', input], { encoding: 'utf8', timeout: 30000 });
  assert.equal(source.status, 0, source.stderr);
  queue = await createTranscoder({ directory: path.join(directory, 'cache'), enabled: true, resolveSource: async () => ({ local: input }), versionOf: stat => String(stat.size) });
  await queue.enqueue({ movieId: 'test', sourceId: 'test', sourceVersion: '1', preset: '720p', title: 'Test', filename: 'Test.mp4' });
  for (let count = 0; count < 300; count++) {
    const job = queue.publicState().jobs[0];
    if (job.status === 'failed') throw new Error(job.error);
    if (job.status === 'ready') break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.equal(queue.publicState().jobs[0].status, 'ready');
  const output = queue.variants('test')[0].parts[0];
  assert.ok(statSync(output.local).size > 0);
  const decoded = spawnSync('ffmpeg', ['-v', 'error', '-i', output.local, '-f', 'null', '-'], { encoding: 'utf8', timeout: 30000 });
  assert.equal(decoded.status, 0, decoded.stderr);
  console.log('Real FFmpeg queue encode, probe, and playback decode passed.');
} finally { await queue?.stop(); await fs.rm(directory, { recursive: true, force: true }); }
