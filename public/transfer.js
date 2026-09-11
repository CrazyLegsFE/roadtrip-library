export const CHUNK_SIZE = 8 * 1024 * 1024;
export const CHECKPOINT_SIZE = 256 * 1024 * 1024;
export const MAX_MANIFEST_BYTES = 32 * 1024 * 1024;
export const REQUEST_TIMEOUT_MS = 45000;
const MANIFEST = '.roadtrip-drive.json';
export const digest = async bytes => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), b => b.toString(16).padStart(2, '0')).join('');
const aborted = signal => { if (signal?.aborted) throw new DOMException('Transfer paused.', 'AbortError'); };
const safeName = name => typeof name === 'string' && name.length > 0 && name.length < 240 && !/[\\/\x00-\x1f]/.test(name) && name !== '.' && name !== '..' && name !== MANIFEST;
const safeRelative = name => typeof name === 'string' && name.split('/').length <= 9 && name.split('/').every(safeName);
export async function maybeFile(directory, name) {
  try {
    const segments = name.split('/');
    for (const segment of segments.slice(0, -1)) directory = await directory.getDirectoryHandle(segment);
    return await directory.getFileHandle(segments.at(-1));
  } catch (e) { if (e.name === 'NotFoundError') return null; throw e; }
}
export function validateManifest(value) {
  if (value?.schema !== 1 || !/^[a-f0-9-]{36}$/.test(value.id) || !value.records || typeof value.records !== 'object' || Array.isArray(value.records)) throw new Error('This folder has an unreadable Roadtrip record. Preserve it and use a different folder, or restore its backup.');
  const filenames = new Set();
  for (const [id, record] of Object.entries(value.records)) {
    if (!id || ['__proto__', 'constructor', 'prototype'].includes(id) || !record || !safeRelative(record.filename) || typeof record.version !== 'string' || !Number.isSafeInteger(record.size) || record.size <= 0 || !Array.isArray(record.chunks) || !['partial', 'ready'].includes(record.status)) throw new Error('The Roadtrip transfer record is damaged. No files have been changed.');
    const filename = record.filename.toLowerCase();
    if (filenames.has(filename)) throw new Error('Two transfer records refer to the same file. No files have been changed.');
    filenames.add(filename);
    let offset = 0;
    for (const chunk of record.chunks) {
      if (!chunk || chunk.start !== offset || !Number.isSafeInteger(chunk.length) || chunk.length < 1 || chunk.length > CHUNK_SIZE || !/^[0-9a-f]{64}$/.test(chunk.hash)) throw new Error('The Roadtrip checkpoints are damaged. No files have been changed.');
      offset += chunk.length;
    }
    if (offset > record.size || (record.status === 'ready' && offset !== record.size)) throw new Error('The Roadtrip checkpoint size is invalid.');
  }
  return value;
}
export async function loadManifest(directory) {
  const handle = await maybeFile(directory, MANIFEST);
  if (!handle) return { schema: 1, id: crypto.randomUUID(), records: {} };
  const file = await handle.getFile();
  if (file.size > MAX_MANIFEST_BYTES) throw new Error('The Roadtrip record is too large to read safely.');
  let value;
  try { value = JSON.parse(await file.text()); } catch { throw new Error('The Roadtrip record is unreadable. No files have been changed.'); }
  return validateManifest(value);
}
export async function saveManifest(directory, manifest) {
  validateManifest(manifest);
  const serialized = JSON.stringify(manifest);
  if (new TextEncoder().encode(serialized).byteLength > MAX_MANIFEST_BYTES) throw new Error('This folder has reached its transfer-record limit. Use a second Movies folder; the current record is unchanged.');
  const handle = await directory.getFileHandle(MANIFEST, { create: true });
  const writer = await handle.createWritable();
  try { await writer.write(serialized); await writer.close(); } catch (e) { try { await writer.abort(); } catch {} throw e; }
}
export async function connectManifest(directory, locks = navigator.locks) {
  if (!locks) throw new Error('USB syncing requires a browser with Web Locks, such as desktop Chrome or Edge.');
  // All first-time folder connections share a short lock. Existing records are
  // never rewritten here, so another tab's active transfer keeps its checkpoints.
  return locks.request('roadtrip:initialize', async () => {
    const manifest = await loadManifest(directory);
    if (!await maybeFile(directory, MANIFEST)) await saveManifest(directory, manifest);
    return manifest;
  });
}
export function requestSignal(signal, timeout = REQUEST_TIMEOUT_MS) {
  const deadline = AbortSignal.timeout(timeout);
  return signal ? AbortSignal.any([signal, deadline]) : deadline;
}
export async function scanDirectory(directory, manifest) {
  const files = [];
  async function walk(folder, prefix = '', depth = 0) {
    if (depth > 8) throw new Error('The folder tree is too deep. Select the Movies folder on your stick.');
    for await (const [name, handle] of folder.entries()) {
      if (name === MANIFEST || name.startsWith('.') || name === 'System Volume Information' || name === '$RECYCLE.BIN') continue;
      if (handle.kind === 'directory') { await walk(handle, prefix + name + '/', depth + 1); continue; }
      if (!/\.(mkv|mp4|m4v|avi|mov|wmv|webm|mpg|mpeg|ts|m2ts|bin)$/i.test(name)) continue;
      if (files.length >= 5000) throw new Error('More than 5,000 files found. Select a smaller Movies folder.');
      const file = await handle.getFile();
      const entry = Object.entries(manifest.records).find(([, r]) => r.filename === prefix + name);
      files.push({ name: prefix + name, size: file.size, partId: entry?.[0] || '', status: entry && entry[1].size === file.size && entry[1].status === 'ready' ? 'ready' : entry ? 'partial' : 'existing' });
    }
  }
  await walk(directory);
  return files;
}
async function fetchPart(part, start, end, signal, checksumOnly = false) {
  let last;
  for (let attempt = 0; attempt < 4; attempt++) {
    aborted(signal);
    try {
      const response = await fetch(`/api/files/${encodeURIComponent(part.id)}?version=${encodeURIComponent(part.version)}${checksumOnly ? '&digest=1' : ''}`, { headers: { Range: `bytes=${start}-${end}` }, signal: requestSignal(signal) });
      if (response.status !== 206) {
        const message = (await response.json().catch(() => ({}))).error || `Transfer failed (HTTP ${response.status}).`;
        const error = new Error(message); error.permanent = response.status < 500 && response.status !== 429;
        throw error;
      }
      if (response.headers.get('Content-Range') !== `bytes ${start}-${end}/${part.size}` || response.headers.get('ETag') !== `"${part.version}"`) throw Object.assign(new Error('The server returned a different source range. Transfer stopped.'), { permanent: true });
      const expected = response.headers.get('X-Chunk-SHA256');
      if (!/^[0-9a-f]{64}$/.test(expected || '')) throw Object.assign(new Error('The server did not provide a valid checksum.'), { permanent: true });
      if (checksumOnly) { await response.arrayBuffer(); return { hash: expected }; }
      const buffer = await response.arrayBuffer();
      if (buffer.byteLength !== end - start + 1 || await digest(buffer) !== expected) throw new Error('A network chunk failed verification.');
      return { buffer, hash: expected };
    } catch (e) {
      if (signal?.aborted || e.name === 'AbortError' || e.permanent) throw e;
      last = e;
      if (attempt < 3) await new Promise((resolve, reject) => {
        const cancel = () => { clearTimeout(timer); reject(new DOMException('Transfer paused.', 'AbortError')); };
        const timer = setTimeout(() => { signal?.removeEventListener('abort', cancel); resolve(); }, 1000 * 2 ** attempt);
        signal?.addEventListener('abort', cancel, { once: true });
      });
    }
  }
  throw last;
}
export async function verifyRecord(handle, record, signal, onProgress = () => {}) {
  const file = await handle.getFile();
  const committed = record.chunks.reduce((sum, c) => sum + c.length, 0);
  if (file.size < committed || file.size > record.size || (record.status === 'ready' && file.size !== record.size)) throw new Error(`“${record.filename}” has changed on the drive. Remove its incomplete copy explicitly before retrying.`);
  for (const chunk of record.chunks) {
    aborted(signal);
    if (await digest(await file.slice(chunk.start, chunk.start + chunk.length).arrayBuffer()) !== chunk.hash) throw new Error(`“${record.filename}” failed its saved checkpoint check. No existing data was overwritten.`);
    onProgress({ phase: 'Checking saved data', completed: chunk.start + chunk.length, total: record.size, filename: record.filename });
  }
  return committed;
}
export async function adoptExisting(directory, manifest, part, filename, signal, onProgress = () => {}) {
  if (!safeRelative(filename)) throw new Error('The existing file path is unsafe.');
  const handle = await maybeFile(directory, filename);
  if (!handle) throw new Error('The existing movie is no longer on the USB stick.');
  const file = await handle.getFile();
  if (file.size !== part.size) throw new Error('The existing movie has a different size.');
  const chunks = [];
  for (let offset = 0; offset < file.size; offset += CHUNK_SIZE) {
    aborted(signal);
    const end = Math.min(file.size, offset + CHUNK_SIZE) - 1;
    const expected = await fetchPart(part, offset, end, signal, true);
    if (await digest(await file.slice(offset, end + 1).arrayBuffer()) !== expected.hash) throw new Error(`The existing “${filename}” differs from the Plex source. It was left untouched. Move it to a different folder if you want to copy this version.`);
    chunks.push({ start: offset, length: end - offset + 1, hash: expected.hash });
    onProgress({ phase: 'Verifying existing movie', completed: end + 1, total: file.size, filename });
  }
  const record = { filename, size: part.size, version: part.version, adopted: true, status: 'ready', chunks };
  await saveManifest(directory, { ...manifest, records: { ...manifest.records, [part.id]: record } });
  manifest.records[part.id] = record;
}
export async function transferPart(directory, manifest, part, signal, onProgress = () => {}, { checkpointSize = CHECKPOINT_SIZE } = {}) {
  aborted(signal);
  if (!safeName(part.filename)) throw new Error('The server supplied an unsafe filename.');
  const info = await fetch(`/api/files/${encodeURIComponent(part.id)}?version=${encodeURIComponent(part.version)}&info=1`, { signal: requestSignal(signal) });
  if (!info.ok) throw new Error((await info.json()).error || 'The source file is unavailable.');
  const source = await info.json();
  if (source.size !== part.size || source.version !== part.version) throw new Error('The source changed. Refresh the library.');
  let record = manifest.records[part.id];
  if (record && (record.version !== part.version || record.size !== part.size || (record.filename !== part.filename && !(record.adopted && record.status === 'ready')))) throw new Error(`The source for “${part.filename}” changed. Remove the old managed copy from On the drive, then sync again.`);
  let handle = await maybeFile(directory, record?.filename || part.filename);
  if (handle && !record) throw new Error(`“${part.filename}” already exists and is not managed by Roadtrip. It has been left untouched. Move it aside or choose a different folder.`);
  if (!handle && record?.chunks.length) throw new Error(`“${part.filename}” is missing from this folder. Remove its saved record from On the drive before retrying.`);
  if (!record) {
    record = { filename: part.filename, version: part.version, size: part.size, status: 'partial', chunks: [] };
    manifest.records[part.id] = record;
    await saveManifest(directory, manifest);
  }
  handle ||= await directory.getFileHandle(part.filename, { create: true });
  let offset = await verifyRecord(handle, record, signal, onProgress);
  if (record.status === 'ready') return { skipped: true };
  let writer = null;
  try {
    while (offset < part.size) {
      aborted(signal);
      writer = await handle.createWritable({ keepExistingData: offset > 0 });
      await writer.truncate(offset);
      await writer.seek(offset);
      // Reopening with keepExistingData copies the entire committed prefix.
      // Grow checkpoints with that prefix to keep cumulative copying linear.
      const pending = [], limit = Math.min(part.size, offset + Math.max(checkpointSize, offset));
      while (offset < limit) {
        aborted(signal);
        const end = Math.min(part.size, offset + CHUNK_SIZE) - 1;
        const chunk = await fetchPart(part, offset, end, signal);
        await writer.write(chunk.buffer);
        pending.push({ start: offset, length: chunk.buffer.byteLength, hash: chunk.hash });
        offset = end + 1;
        onProgress({ phase: 'Copying', completed: offset, total: part.size, filename: part.filename });
      }
      aborted(signal);
      onProgress({ phase: 'Saving checkpoint', completed: offset, total: part.size, filename: part.filename });
      await writer.close(); writer = null;
      // Close commits file data; verify the committed bytes before recording them.
      const committedFile = await handle.getFile();
      for (const chunk of pending) {
        if (await digest(await committedFile.slice(chunk.start, chunk.start + chunk.length).arrayBuffer()) !== chunk.hash) throw new Error('The USB copy failed verification. Its last verified checkpoint is preserved.');
      }
      const next = { ...record, chunks: [...record.chunks, ...pending] };
      const candidate = { ...manifest, records: { ...manifest.records, [part.id]: next } };
      await saveManifest(directory, candidate);
      manifest.records[part.id] = record = next;
    }
    const final = await handle.getFile();
    if (final.size !== part.size) throw new Error('The copied file has the wrong size.');
    const finalInfo = await fetch(`/api/files/${encodeURIComponent(part.id)}?version=${encodeURIComponent(part.version)}&info=1`, { signal: requestSignal(signal) });
    if (!finalInfo.ok) throw new Error('The source changed or became unavailable. Reconnect and retry before marking this movie ready.');
    const ready = { ...record, status: 'ready' };
    await saveManifest(directory, { ...manifest, records: { ...manifest.records, [part.id]: ready } });
    manifest.records[part.id] = ready;
    onProgress({ phase: 'Ready', completed: part.size, total: part.size, filename: part.filename });
    return { skipped: false };
  } catch (e) { if (writer) try { await writer.abort(); } catch {} throw e; }
}

export class WakeGuard {
  constructor(onStatus = () => {}) {
    this.onStatus = onStatus; this.active = false; this.lock = null; this.pending = null;
    this.visibility = () => { if (this.active && document.visibilityState === 'visible') void this.acquire(); };
  }
  async acquire() {
    if (this.lock || this.pending || !this.active) return;
    if (!navigator.wakeLock) { this.onStatus('Wake lock unavailable — keep your computer awake'); return; }
    try {
      this.pending = navigator.wakeLock.request('screen');
      const lock = await this.pending;
      if (!this.active) { await lock.release(); return; }
      this.lock = lock; this.onStatus('Keeping this screen awake');
      lock.addEventListener('release', () => { if (this.lock === lock) this.lock = null; if (this.active) this.onStatus('Wake lock released — return to this tab'); });
    } catch { this.onStatus('Wake lock unavailable — keep your computer awake'); }
    finally { this.pending = null; }
  }
  async start() { this.active = true; document.addEventListener('visibilitychange', this.visibility); await this.acquire(); }
  async stop() { this.active = false; document.removeEventListener('visibilitychange', this.visibility); if (this.lock) try { await this.lock.release(); } catch {} this.lock = null; this.onStatus(''); }
}
