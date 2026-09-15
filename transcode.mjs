import { promises as fs } from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';

export const PRESETS = { '720p': { height: 720, width: 1280, rate: 2000000 }, '1080p': { height: 1080, width: 1920, rate: 4000000 } };
const error = message => Object.assign(new Error(message), { status: 400 });
export function encodeArgs(input, output, probe, preset, encoder, audioIndex) {
  const p = PRESETS[preset];
  if (!p || !['cpu', 'nvidia'].includes(encoder)) throw error('Invalid conversion preset or encoder.');
  const video = probe.streams?.find(s => s.codec_type === 'video' && !s.disposition?.attached_pic);
  if (!video) throw error('No video stream found.');
  if (video.side_data_list?.some(s => /dovi/i.test(s.side_data_type))) throw error('Dolby Vision conversion is not supported yet. Choose an SDR or HDR10 source.');
  const audio = probe.streams.filter(s => s.codec_type === 'audio');
  const selected = audioIndex === 'default' ? audio.find(s => s.disposition?.default) || audio[0] : audio.find(s => String(s.index) === String(audioIndex));
  if (audioIndex !== 'default' && !selected) throw error('That audio track is no longer available.');
  const hdr = ['smpte2084', 'arib-std-b67'].includes(video.color_transfer);
  const filters = [];
  if (hdr) filters.push('zscale=t=linear:npl=100', 'format=gbrpf32le', 'zscale=p=bt709', 'tonemap=tonemap=hable', 'zscale=t=bt709:m=bt709:r=tv');
  filters.push(`scale=w='min(iw,${p.width})':h='min(ih,${p.height})':force_original_aspect_ratio=decrease:force_divisible_by=2`, 'setsar=1', 'format=yuv420p');
  return ['-nostdin', '-hide_banner', '-loglevel', 'error', '-y', '-threads', '2', '-filter_threads', '2', '-i', input,
    '-map', `0:${video.index}`, ...(selected ? ['-map', `0:${selected.index}`] : ['-an']), '-sn', '-dn', '-map_metadata', '-1',
    '-vf', filters.join(','), '-c:v', encoder === 'nvidia' ? 'h264_nvenc' : 'libx264', '-preset', encoder === 'nvidia' ? 'p4' : 'fast',
    '-b:v', String(p.rate), '-maxrate', String(p.rate * 1.5), '-bufsize', String(p.rate * 2), '-threads', '2',
    ...(hdr ? ['-color_primaries', 'bt709', '-color_trc', 'bt709', '-colorspace', 'bt709'] : []),
    ...(selected ? ['-c:a', 'aac', '-b:a', '128k', '-ac', '2'] : []), '-movflags', '+faststart', '-progress', 'pipe:1', '-f', 'mp4', output];
}

export async function createTranscoder({ directory, enabled = false, resolveSource, versionOf, spawnProcess = spawn }) {
  await fs.mkdir(directory, { recursive: true });
  const statePath = path.join(directory, 'queue.json');
  let state = { encoder: 'cpu', cacheGB: 50, jobs: [] };
  try { state = JSON.parse(await fs.readFile(statePath, 'utf8')); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  let serial = Promise.resolve(), running = false, stopped = false, child = null, current = null;
  const save = () => { const snapshot = JSON.stringify(state); serial = serial.catch(() => {}).then(async () => { await fs.writeFile(statePath + '.tmp', snapshot); await fs.rename(statePath + '.tmp', statePath); }); return serial; };
  const outputPath = job => path.join(directory, `${job.id}.mp4`);
  for (const job of state.jobs) {
    if (!/^[a-f0-9]{32}$/.test(job.id)) throw new Error('Invalid transcode queue record.');
    if (['running', 'cancelling'].includes(job.status)) job.status = 'queued';
    if (job.status === 'ready') try { await fs.access(outputPath(job)); } catch { job.status = 'failed'; job.error = 'Cached movie is missing. Queue it again.'; }
    await fs.rm(outputPath(job) + '.partial', { force: true });
  }
  const publicState = () => ({ enabled, presets: PRESETS, encoder: state.encoder, cacheGB: state.cacheGB, jobs: state.jobs.map(({ source, part, ...j }) => j) });
  function run(command, args, signal, onText = () => {}) {
    return new Promise((resolve, reject) => {
      const process = spawnProcess(command, args, { stdio: ['ignore', 'pipe', 'pipe'], shell: false });
      child = process; let out = '', err = '', timer;
      const cancel = () => { process.kill('SIGTERM'); timer = setTimeout(() => process.kill('SIGKILL'), 3000); timer.unref?.(); };
      signal?.addEventListener('abort', cancel, { once: true });
      if (signal?.aborted) cancel();
      process.stdout.on('data', b => { out = (out + b).slice(-2e6); onText(String(b)); });
      process.stderr.on('data', b => { err = (err + b).slice(-4000); });
      process.once('error', reject);
      process.once('close', code => { clearTimeout(timer); signal?.removeEventListener('abort', cancel); child = null; if (signal?.aborted) reject(error('Conversion cancelled.')); else if (code) reject(error(`${command} failed: ${err || `exit ${code}`}`)); else resolve(out); });
    });
  }
  const probe = async (filename, signal) => JSON.parse(await run('ffprobe', ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', filename], signal ? AbortSignal.any([signal, AbortSignal.timeout(30000)]) : AbortSignal.timeout(30000)));
  async function usage() { let size = 0; for (const entry of await fs.readdir(directory)) if (/^[a-f0-9]{32}\.mp4(?:\.partial)?$/.test(entry)) size += (await fs.stat(path.join(directory, entry))).size; return size; }
  async function pump() {
    if (!enabled || running || stopped) return;
    running = true;
    try {
      for (let job; !stopped && (job = state.jobs.find(j => j.status === 'queued'));) {
        current = { job, controller: new AbortController() };
        const signal = current.controller.signal, partial = outputPath(job) + '.partial';
        try {
          job.status = 'running'; job.progress = 0; job.error = ''; await save();
          const source = await resolveSource(job.sourceId, job.sourceVersion);
          const data = await probe(source.local, signal);
          const duration = Number(data.format?.duration);
          if (!Number.isFinite(duration) || duration <= 0) throw error('Cannot determine movie duration.');
          // Reserve conservatively; enforce the budget during encoding as well.
          const reserve = Math.ceil(duration * (PRESETS[job.preset].rate * 1.5 + 128000) / 8 * 1.1);
          if (await usage() + reserve > state.cacheGB * 1e9) throw error('Server conversion cache budget is too small. Remove cached copies or increase it in Settings.');
          const disk = await fs.statfs(directory);
          if (disk.bavail * disk.bsize < reserve + 64 * 1024 * 1024) throw error('Not enough free space on the server for this conversion.');
          let buffer = '', quotaExceeded = false, monitoring = false;
          const monitor = setInterval(async () => {
            if (monitoring) return; monitoring = true;
            try { if (await usage() > state.cacheGB * 1e9) { quotaExceeded = true; current?.controller.abort(); } } catch { /* Encoder reports storage errors. */ } finally { monitoring = false; }
          }, 1000); monitor.unref();
          try {
            await run('ffmpeg', encodeArgs(source.local, partial, data, job.preset, job.encoder, job.audio), signal, text => {
              buffer += text; const lines = buffer.split('\n'); buffer = lines.pop();
              for (const line of lines) if (line.startsWith('out_time_us=')) job.progress = Math.min(99, Math.round(Number(line.split('=')[1]) / 1e6 / duration * 100)) || 0;
            });
          } finally { clearInterval(monitor); if (quotaExceeded) throw error('Server cache budget exceeded. Increase it or remove cached copies.'); }
          if (signal.aborted) throw error('Conversion cancelled.');
          await resolveSource(job.sourceId, job.sourceVersion);
          const check = await probe(partial, signal);
          if (!check.streams?.some(s => s.codec_type === 'video' && s.codec_name === 'h264') || !Number.isFinite(Number(check.format?.duration)) || Math.abs(Number(check.format?.duration) - duration) > Math.max(3, duration * 0.01) || (await fs.stat(partial)).size === 0) throw error('Converted file failed duration/codec validation.');
          if (signal.aborted) throw error('Conversion cancelled.');
          await fs.rename(partial, outputPath(job));
          const stat = await fs.stat(outputPath(job));
          job.part = { id: `tc:${job.id}`, local: outputPath(job), filename: job.filename, originalName: job.filename, size: stat.size, version: versionOf(stat) };
          job.status = 'ready'; job.progress = 100; job.size = stat.size;
        } catch (e) { job.status = stopped ? 'queued' : job.status === 'cancelling' ? 'cancelled' : 'failed'; job.error = e.code === 'ENOENT' ? 'FFmpeg is not installed. Enable the transcoding Docker image.' : String(e.message).slice(-1500); await fs.rm(partial, { force: true }); }
        finally { current = null; await save(); }
      }
    } finally { running = false; }
  }
  const kick = () => { void pump().catch(e => console.error('Transcode queue:', e.message)); };
  const timer = setTimeout(kick, 100); timer.unref();
  return {
    directory, publicState,
    async inspect(sourceId, version) {
      if (!enabled) throw error('Enable the transcoding Docker image first.');
      const source = await resolveSource(sourceId, version);
      const data = await probe(source.local, AbortSignal.timeout(30000));
      return { audio: data.streams.filter(s => s.codec_type === 'audio').map(s => ({ id: String(s.index), language: s.tags?.language || 'Unknown language', title: s.tags?.title || '', channels: s.channels, default: !!s.disposition?.default })), subtitles: data.streams.some(s => s.codec_type === 'subtitle') };
    },
    variants(movieId) { return state.jobs.filter(j => j.movieId === movieId && j.status === 'ready' && j.part).map(j => ({ id: `tc:${j.id}`, label: `Tablet ${j.preset} · MP4`, available: true, size: j.size, parts: [j.part] })); },
    async settings(input) {
      if (!['cpu', 'nvidia'].includes(input.encoder) || !Number.isFinite(input.cacheGB) || input.cacheGB < 1 || input.cacheGB > 10000) throw error('Choose a valid encoder and cache budget (1–10000 GB).');
      state.encoder = input.encoder; state.cacheGB = input.cacheGB; await save(); return publicState();
    },
    async enqueue({ movieId, sourceId, sourceVersion, preset, audio = 'default', title, filename }) {
      if (!enabled) throw error('Enable the transcoding Docker image first. See the transcoding guide.');
      if (!PRESETS[preset] || !/^(default|\d{1,4})$/.test(String(audio))) throw error('Invalid quality or audio track.');
      await resolveSource(sourceId, sourceVersion);
      const id = createHash('sha256').update(JSON.stringify([sourceId, sourceVersion, preset, String(audio), state.encoder])).digest('hex').slice(0, 32);
      let job = state.jobs.find(j => j.id === id);
      if (job && ['queued', 'running', 'ready', 'cancelling'].includes(job.status)) return publicState();
      if (state.jobs.length >= 500 && !job) throw error('Conversion queue is full. Remove old jobs first.');
      if (!job) { job = { id }; state.jobs.push(job); }
      Object.assign(job, { movieId, sourceId, sourceVersion, preset, audio: String(audio), title, encoder: state.encoder, filename: filename.replace(/\.[^.]+$/, '') + ` - tablet-${preset}-${id.slice(0, 8)}.mp4`, status: 'queued', progress: 0, error: '', createdAt: new Date().toISOString() });
      await save(); kick(); return publicState();
    },
    async cancel(id) { const job = state.jobs.find(j => j.id === id); if (!job) throw error('Job not found.'); if (current?.job === job) { job.status = 'cancelling'; current.controller.abort(); } else if (job.status === 'queued') job.status = 'cancelled'; await save(); return publicState(); },
    async remove(id) { const job = state.jobs.find(j => j.id === id); if (!job) throw error('Job not found.'); if (['running', 'queued', 'cancelling'].includes(job.status)) throw error('Cancel this conversion before removing it.'); await fs.rm(outputPath(job), { force: true }); state.jobs = state.jobs.filter(j => j.id !== id); await save(); return publicState(); },
    async stop() { stopped = true; clearTimeout(timer); if (current) { current.job.status = 'queued'; current.controller.abort(); } await serial; }
  };
}
