import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promises as fs } from 'node:fs';
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MiB = 1024 * 1024;
export const CHUNK_SIZE = 8 * MiB;
const hash = value => createHash('sha256').update(value).digest('hex');
const fail = (status, message) => Object.assign(new Error(message), { status });
const cleanText = (value, max = 120) => String(value ?? '').trim().slice(0, max);

export function within(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith('..' + path.sep));
}
export function mapPlexPath(filename, mappings) {
  const normalized = filename.replaceAll('\\', '/');
  const ordered = [...mappings].sort((a, b) => b.plex.length - a.plex.length);
  for (const mapping of ordered) {
    const prefix = mapping.plex.replaceAll('\\', '/').replace(/\/$/, '');
    if (normalized === prefix || normalized.startsWith(prefix + '/')) {
      const target = path.resolve(mapping.local, normalized.slice(prefix.length).replace(/^\//, ''));
      if (!within(path.resolve(mapping.local), target)) throw fail(403, 'Media path escapes the configured folder.');
      return target;
    }
  }
  throw fail(503, 'No media path mapping matches this movie.');
}
export async function safeMedia(filename, roots) {
  const candidate = await fs.realpath(filename);
  for (const root of roots) {
    const realRoot = await fs.realpath(root);
    if (within(realRoot, candidate)) return candidate;
  }
  throw fail(403, 'Media is outside the configured folders.');
}
export function sourceVersion(stat) {
  return hash(`${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}:${stat.ino}`).slice(0, 32);
}
export function parseRange(header, size, max = CHUNK_SIZE) {
  const match = /^bytes=(\d+)-(\d+)$/.exec(header || '');
  if (!match) throw fail(416, 'An explicit byte range is required.');
  const start = Number(match[1]), end = Number(match[2]);
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start || end >= size || end - start + 1 > max) throw fail(416, 'Invalid or oversized byte range.');
  return { start, end };
}
export function filenameFor(title, year, id, original, part = 0) {
  const stem = `${title}${year ? ` (${year})` : ''}`.normalize('NFKC').replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/^[. ]+|[. ]+$/g, '').slice(0, 100) || 'Movie';
  const ext = path.extname(original).toLowerCase();
  if (!/^\.[a-z0-9]{1,8}$/.test(ext)) throw fail(400, 'Unsupported file extension.');
  return `${stem} [${hash(id).slice(0, 8)}]${part ? ` - Part ${part}` : ''}${ext}`;
}
async function atomicJson(filename, value) {
  const temporary = filename + '.tmp';
  const handle = await fs.open(temporary, 'w', 0o600);
  try { await handle.writeFile(JSON.stringify(value)); await handle.sync(); } finally { await handle.close(); }
  await fs.rename(temporary, filename);
}
async function readJson(filename, fallback) {
  try { return JSON.parse(await fs.readFile(filename, 'utf8')); } catch (e) { if (e.code === 'ENOENT') return fallback; throw e; }
}

export async function createApp(options = {}) {
  const config = {
    dataDir: process.env.DATA_DIR || path.join(HERE, 'data'),
    plexUrl: process.env.PLEX_URL || '', plexToken: process.env.PLEX_TOKEN || '',
    password: process.env.APP_PASSWORD || '', origin: process.env.APP_ORIGIN || 'http://localhost:8787',
    mappings: JSON.parse(process.env.MEDIA_PATH_MAPPINGS || '[]'),
    sections: (process.env.PLEX_SECTION_IDS || '').split(',').filter(Boolean),
    demo: process.env.DEMO_MODE === 'true', ...options,
  };
  if (!config.demo && (config.password.length < 12 || config.password === 'replace-with-your-own-long-family-password')) throw new Error('Set APP_PASSWORD to your own password of at least 12 characters.');
  const appUrl = new URL(config.origin);
  if (!['http:', 'https:'].includes(appUrl.protocol) || appUrl.username || appUrl.password || appUrl.pathname !== '/' || appUrl.search || appUrl.hash) throw new Error('APP_ORIGIN must be an HTTP(S) origin without credentials, path, query, or fragment.');
  const origin = appUrl.origin;
  if (!Array.isArray(config.mappings) || config.mappings.some(m => !m.plex || !m.local || !path.isAbsolute(m.local))) throw new Error('MEDIA_PATH_MAPPINGS must contain absolute plex/local folder mappings.');
  await fs.mkdir(config.dataDir, { recursive: true });
  await fs.mkdir(path.join(config.dataDir, 'art'), { recursive: true });
  const stateFile = path.join(config.dataDir, 'state.json'), catalogFile = path.join(config.dataDir, 'catalog.json');
  let state = await readJson(stateFile, { picks: [], wishes: [], drives: [] });
  let catalog = await readJson(catalogFile, { updatedAt: null, movies: [] });
  let refreshBusy = false, activeChunks = 0, commitQueue = Promise.resolve();
  let secret;
  try { secret = await fs.readFile(path.join(config.dataDir, 'session.key')); }
  catch (e) { if (e.code !== 'ENOENT') throw e; secret = randomBytes(32); await fs.writeFile(path.join(config.dataDir, 'session.key'), secret, { mode: 0o600 }); }
  const authKey = createHmac('sha256', secret).update(config.password).digest();
  const sign = data => createHmac('sha256', authKey).update(data).digest('hex');
  const safeEqual = (a, b) => timingSafeEqual(createHash('sha256').update(a).digest(), createHash('sha256').update(b).digest());
  const authenticated = req => {
    if (config.demo) return true;
    const token = /(?:^|; )roadtrip=([^;]+)/.exec(req.headers.cookie || '')?.[1] || '';
    const [expires, sig] = token.split('.');
    return Number(expires) > Date.now() && Number(expires) < Date.now() + 8 * 86400000 && !!sig && safeEqual(sign(expires), sig);
  };
  const attempts = new Map();
  function mutate(fn) {
    const operation = commitQueue.then(async () => {
      const next = structuredClone(state);
      fn(next);
      await atomicJson(stateFile, next);
      state = next;
      return state;
    });
    commitQueue = operation.catch(() => {});
    return operation;
  }
  async function plex(route, json = true) {
    if (!config.plexUrl || !config.plexToken) throw fail(503, 'Configure the Plex URL, token, and media folder mappings on the server.');
    if (!route.startsWith('/') || route.startsWith('//')) throw fail(400, 'Invalid Plex resource.');
    const target = new URL(route, config.plexUrl);
    if (target.origin !== new URL(config.plexUrl).origin) throw fail(400, 'Invalid Plex resource origin.');
    const response = await fetch(target, {
      headers: { 'X-Plex-Token': config.plexToken, Accept: json ? 'application/json' : 'image/jpeg' },
      redirect: 'error', signal: AbortSignal.timeout(30000),
    });
    if (!response.ok) throw fail(502, `Plex returned HTTP ${response.status}. Check its connection and token.`);
    return json ? response.json() : response;
  }
  async function refresh() {
    if (refreshBusy) throw fail(409, 'A library refresh is already running.');
    if (config.demo) return catalog;
    refreshBusy = true;
    try {
      if (!config.mappings.length) throw fail(503, 'Configure at least one media folder mapping.');
      for (const mapping of config.mappings) {
        try {
          const root = await fs.realpath(mapping.local);
          if (!(await fs.stat(root)).isDirectory()) throw new Error();
          if (mapping.sentinel) {
            const marker = path.resolve(root, mapping.sentinel);
            if (!within(root, marker)) throw new Error();
            await fs.access(marker);
          }
        } catch { throw fail(503, 'A configured media mount or its sentinel is missing. The previous catalog has been kept.'); }
      }
      const sections = (await plex('/library/sections')).MediaContainer?.Directory || [];
      const movies = [];
      for (const section of sections.filter(s => s.type === 'movie' && (!config.sections.length || config.sections.includes(String(s.key))))) {
        for (let offset = 0; ; ) {
          const result = (await plex(`/library/sections/${encodeURIComponent(section.key)}/all?type=1&X-Plex-Container-Start=${offset}&X-Plex-Container-Size=200`)).MediaContainer || {};
          const batch = result.Metadata || [];
          for (const movie of batch) {
            const variants = [];
            for (const media of movie.Media || []) {
              const parts = [];
              let problem = '';
              for (const [index, part] of (media.Part || []).entries()) {
                const id = `${movie.ratingKey}:${media.id}:${part.id}`;
                try {
                  const local = mapPlexPath(part.file, config.mappings);
                  const real = await safeMedia(local, config.mappings.map(m => m.local));
                  const stat = await fs.stat(real);
                  if (!stat.isFile() || stat.size === 0) throw new Error('empty');
                  parts.push({ id, local, originalName: path.posix.basename(part.file.replaceAll('\\', '/')), size: stat.size, version: sourceVersion(stat), filename: filenameFor(movie.title, movie.year, id, part.file, media.Part.length > 1 ? index + 1 : 0) });
                } catch { problem = 'File unavailable: check the media mount and path mapping.'; }
              }
              if (parts.length) variants.push({ id: String(media.id), label: `${media.videoResolution || '?'}p · ${media.container || 'video'}`, parts, available: !problem, problem, size: parts.reduce((sum, part) => sum + part.size, 0) });
            }
            variants.sort((a, b) => Number(b.available) - Number(a.available) || a.size - b.size);
            movies.push({ id: String(movie.ratingKey), title: movie.title, year: movie.year || null, summary: movie.summary || '', duration: Math.round((movie.duration || 0) / 60000), rating: movie.contentRating || '', genres: (movie.Genre || []).map(g => g.tag), thumb: movie.thumb || '', variants, available: variants.some(v => v.available), library: section.title });
          }
          offset += batch.length;
          if (!batch.length || offset >= Number(result.totalSize ?? offset)) break;
        }
      }
      const next = { updatedAt: new Date().toISOString(), movies };
      await atomicJson(catalogFile, next);
      catalog = next;
      return next;
    } finally { refreshBusy = false; }
  }
  if (config.demo) {
    const titles = ['The Long Way Home', 'A Weekend on Mars', 'Summer at the Lake', 'The Midnight Express', 'Tiny Great Adventures', 'Beyond the Pines'];
    const demoDir = path.join(config.dataDir, 'demo');
    await fs.mkdir(demoDir, { recursive: true });
    config.mappings = [{ plex: '/demo', local: demoDir }];
    catalog = { updatedAt: new Date().toISOString(), movies: [] };
    for (const [i, title] of titles.entries()) {
      const local = path.join(demoDir, `sample-${i}.bin`);
      try { await fs.access(local); } catch { await fs.writeFile(local, Buffer.alloc(MiB * (i + 1), i + 1)); }
      const stat = await fs.stat(local), id = `demo-${i}`;
      catalog.movies.push({ id, title, year: 2020 + i, summary: 'A fictional catalog entry for trying trip lists and USB transfers. The downloadable file is test data, not a playable movie.', duration: 90 + i * 7, rating: 'DEMO', genres: ['Sample'], thumb: '', library: 'Demo library', available: true, variants: [{ id: 'sample', label: 'Test file', size: stat.size, available: true, parts: [{ id, local, size: stat.size, version: sourceVersion(stat), filename: `${title} [demo].bin` }] }] });
    }
  }
  const publicCatalog = () => ({ ...catalog, movies: catalog.movies.map(({ thumb, ...movie }) => ({ ...movie, poster: thumb ? `/api/art/${encodeURIComponent(movie.id)}` : null, variants: movie.variants.map(variant => ({ ...variant, parts: variant.parts.map(({ local, ...part }) => part) })) })) });
  const locate = id => catalog.movies.flatMap(m => m.variants.flatMap(v => v.parts)).find(p => p.id === id);
  const cookie = value => `roadtrip=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${value ? 604800 : 0}${origin.startsWith('https:') ? '; Secure' : ''}`;
  async function body(req) {
    let size = 0, chunks = [];
    for await (const chunk of req) { size += chunk.length; if (size > 2 * MiB) throw fail(413, 'Request is too large.'); chunks.push(chunk); }
    try {
      const input = JSON.parse(Buffer.concat(chunks).toString() || '{}');
      if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error();
      return input;
    } catch { throw fail(400, 'A JSON object is required.'); }
  }
  function json(res, status, data) { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(data)); }
  const server = http.createServer(async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'same-origin');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
    res.setHeader('Permissions-Policy', 'screen-wake-lock=(self)');
    try {
      const url = new URL(req.url, origin);
      if (req.method === 'POST') {
        if (req.headers.origin !== origin) throw fail(403, 'Open the app using its configured APP_ORIGIN address.');
        if (!req.headers['content-type']?.startsWith('application/json')) throw fail(415, 'JSON content type is required.');
      }
      if (req.method === 'GET' && url.pathname === '/health') return json(res, 200, { ok: true });
      if (req.method === 'GET' && url.pathname === '/api/session') return json(res, 200, { authenticated: authenticated(req), demo: config.demo });
      if (req.method === 'POST' && url.pathname === '/api/login') {
        const ip = req.socket.remoteAddress;
        const now = Date.now();
        for (const [key, entry] of attempts) if (entry.until < now) attempts.delete(key);
        const attempt = attempts.get(ip) || { count: 0, until: now + 60000 };
        if (attempt.count >= 10) throw fail(429, 'Too many attempts. Try again in one minute.');
        const input = await body(req);
        if (!safeEqual(String(input.password || ''), config.password)) { attempt.count++; attempts.set(ip, attempt); throw fail(401, 'That password did not match.'); }
        attempts.delete(ip);
        const expiry = String(now + 7 * 86400000);
        res.setHeader('Set-Cookie', cookie(`${expiry}.${sign(expiry)}`));
        return json(res, 200, { ok: true });
      }
      if (url.pathname.startsWith('/api/') && !authenticated(req)) throw fail(401, 'Sign in to your family library.');
      if (req.method === 'POST' && url.pathname === '/api/logout') { res.setHeader('Set-Cookie', cookie('')); return json(res, 200, { ok: true }); }
      if (req.method === 'GET' && url.pathname === '/api/library') return json(res, 200, { ...publicCatalog(), configured: !!config.plexUrl && !!config.plexToken && !!config.mappings.length, refreshing: refreshBusy, demo: config.demo, chunkSize: CHUNK_SIZE });
      if (req.method === 'POST' && url.pathname === '/api/refresh') { await refresh(); return json(res, 200, publicCatalog()); }
      if (req.method === 'GET' && url.pathname === '/api/state') return json(res, 200, state);
      if (req.method === 'POST' && url.pathname === '/api/picks') {
        const input = await body(req), who = cleanText(input.who, 40) || 'Family';
        const movie = catalog.movies.find(m => m.id === input.movieId);
        if (!movie) throw fail(404, 'Movie is no longer in the library.');
        const variant = movie.variants.find(v => v.id === input.variantId);
        if (!variant?.available) throw fail(400, 'Choose an available version.');
        return json(res, 200, await mutate(next => {
          const key = `${movie.id}:${variant.id}`;
          let pick = next.picks.find(p => p.key === key);
          if (!pick) { if (next.picks.length >= 1000) throw fail(400, 'The trip list is full.'); pick = { key, movieId: movie.id, variantId: variant.id, people: [] }; next.picks.push(pick); }
          if (!pick.people.includes(who)) pick.people.push(who);
        }));
      }
      if (req.method === 'POST' && url.pathname === '/api/picks/remove') {
        const input = await body(req);
        return json(res, 200, await mutate(next => { next.picks = next.picks.filter(p => p.key !== input.key); }));
      }
      if (req.method === 'POST' && url.pathname === '/api/wishes') {
        const input = await body(req), title = cleanText(input.title), who = cleanText(input.who, 40) || 'Family';
        if (!title) throw fail(400, 'Enter a movie title.');
        return json(res, 200, await mutate(next => { if (next.wishes.length >= 1000) throw fail(400, 'The wishlist is full.'); next.wishes.push({ id: randomBytes(12).toString('hex'), title, who, createdAt: new Date().toISOString() }); }));
      }
      if (req.method === 'POST' && url.pathname === '/api/wishes/remove') {
        const input = await body(req);
        return json(res, 200, await mutate(next => { next.wishes = next.wishes.filter(w => w.id !== input.id); }));
      }
      if (req.method === 'POST' && url.pathname === '/api/drives') {
        const input = await body(req);
        if (!/^[a-f0-9-]{36}$/.test(input.id || '') || !Array.isArray(input.files) || input.files.length > 5000 || input.files.some(f => !f || typeof f !== 'object' || typeof f.name !== 'string')) throw fail(400, 'Invalid drive inventory.');
        const drive = { id: input.id, name: cleanText(input.name, 80), scannedAt: new Date().toISOString(), files: input.files.map(f => ({ name: cleanText(f.name, 600), size: Number.isSafeInteger(f.size) && f.size >= 0 ? f.size : 0, partId: cleanText(f.partId, 100), status: ['ready', 'partial', 'existing'].includes(f.status) ? f.status : 'existing' })) };
        return json(res, 200, await mutate(next => { next.drives = [drive, ...next.drives.filter(d => d.id !== drive.id)].slice(0, 20); }));
      }
      if (req.method === 'GET' && url.pathname.startsWith('/api/art/')) {
        const id = decodeURIComponent(url.pathname.slice(9));
        const movie = catalog.movies.find(m => m.id === id);
        if (!movie?.thumb) throw fail(404, 'No artwork available.');
        const filename = path.join(config.dataDir, 'art', hash(id + movie.thumb) + '.img');
        let art;
        try { art = await fs.readFile(filename); }
        catch (e) {
          if (e.code !== 'ENOENT') throw e;
          const response = await plex(movie.thumb, false);
          const reader = response.body.getReader(), chunks = []; let size = 0;
          try { while (true) { const { done, value } = await reader.read(); if (done) break; size += value.length; if (size > 8 * MiB) throw fail(502, 'Artwork is too large.'); chunks.push(value); } } finally { await reader.cancel(); }
          art = Buffer.concat(chunks);
          if (!(art[0] === 0xff && art[1] === 0xd8) && !art.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) && !(art.toString('ascii', 0, 4) === 'RIFF' && art.toString('ascii', 8, 12) === 'WEBP')) throw fail(502, 'Unsupported poster format.');
          await fs.writeFile(filename, art);
        }
        const type = art[0] === 0xff ? 'image/jpeg' : art[0] === 137 ? 'image/png' : 'image/webp';
        res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'private, max-age=86400' }); return res.end(art);
      }
      if (req.method === 'GET' && url.pathname.startsWith('/api/files/')) {
        const id = decodeURIComponent(url.pathname.slice(11));
        const part = locate(id);
        if (!part) throw fail(404, 'File is no longer in the library. Refresh and try again.');
        const real = await safeMedia(part.local, config.mappings.map(m => m.local));
        const file = await fs.open(real, 'r');
        try {
          const stat = await file.stat(), version = sourceVersion(stat);
          if (!stat.isFile() || version !== part.version || url.searchParams.get('version') !== version) throw fail(409, 'The source movie changed. Refresh the library before transferring it.');
          if (url.searchParams.get('info') === '1') return json(res, 200, { size: stat.size, version, filename: part.filename });
          const { start, end } = parseRange(req.headers.range, stat.size);
          if (activeChunks >= 4) { res.setHeader('Retry-After', '2'); throw fail(503, 'The server is busy. Retrying shortly.'); }
          activeChunks++;
          try {
            const buffer = Buffer.alloc(end - start + 1); let read = 0;
            while (read < buffer.length) { const result = await file.read(buffer, read, buffer.length - read, start + read); if (!result.bytesRead) throw fail(409, 'The source file changed during transfer.'); read += result.bytesRead; }
            if (sourceVersion(await file.stat()) !== version) throw fail(409, 'The source file changed during transfer.');
            const payload = url.searchParams.get('digest') === '1' ? Buffer.alloc(0) : buffer;
            res.writeHead(206, { 'Content-Type': 'application/octet-stream', 'Content-Length': payload.length, 'Content-Range': `bytes ${start}-${end}/${stat.size}`, 'Accept-Ranges': 'bytes', ETag: `"${version}"`, 'X-Chunk-SHA256': hash(buffer) });
            await new Promise(resolve => { res.once('finish', resolve); res.once('close', resolve); res.end(payload); });
          } finally { activeChunks--; }
        } finally { await file.close(); }
        return;
      }
      const files = { '/': ['index.html', 'text/html'], '/app.js': ['app.js', 'text/javascript'], '/transfer.js': ['transfer.js', 'text/javascript'], '/staging.js': ['staging.js', 'text/javascript'], '/styles.css': ['styles.css', 'text/css'] };
      if (req.method === 'GET' && files[url.pathname]) {
        const [name, type] = files[url.pathname];
        res.writeHead(200, { 'Content-Type': type + '; charset=utf-8' }); return res.end(await fs.readFile(path.join(HERE, 'public', name)));
      }
      throw fail(404, 'Not found.');
    } catch (error) {
      if (res.headersSent) return res.destroy();
      const status = error.status || (['ENOENT', 'EACCES'].includes(error.code) ? 503 : 500);
      json(res, status, { error: error.status ? error.message : status === 503 ? 'The media folder is unavailable. Check the server mount.' : 'The server could not complete this request. Check its configuration and storage.' });
      if (status === 500) console.error('Request failed:', error.code || error.name);
    }
  });
  server.requestTimeout = 120000;
  server.headersTimeout = 15000;
  return { server, refresh, config };
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const app = await createApp();
  app.server.listen(Number(process.env.PORT || 8787), process.env.HOST || (app.config.demo ? '127.0.0.1' : '0.0.0.0'), () => console.log(`Roadtrip ready at ${app.config.origin}${app.config.demo ? ' (DEMO: fictional titles and test files)' : ''}`));
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => {
    app.server.close(() => process.exit(0));
    setTimeout(() => { app.server.closeAllConnections(); process.exit(0); }, 10000).unref();
  });
}
