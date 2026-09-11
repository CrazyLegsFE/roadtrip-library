import { loadManifest, saveManifest, connectManifest, scanDirectory, transferPart, adoptExisting, WakeGuard, maybeFile } from './transfer.js';
import { stagedTransfer, clearStaging } from './staging.js';

let stagingDirectory = null;
document.addEventListener('DOMContentLoaded', () => {
  $('#stage-folder').addEventListener('click', () => void guarded(async () => {
    if (model.syncing) throw new Error('Stop the transfer before changing staging folders.');
    const folder = await window.showDirectoryPicker({ id: 'roadtrip-staging', mode: 'readwrite' });
    if (model.directory && (await folder.isSameEntry(model.directory) || await folder.resolve(model.directory) !== null || await model.directory.resolve(folder) !== null)) throw new Error('Choose an SSD folder separate from the USB folder.');
    await connectManifest(folder);
    stagingDirectory = folder;
    $('#stage-folder').textContent = `SSD folder: ${folder.name}`;
    $('#stage-enabled').checked = true;
  }));
  $('#stage-clear').addEventListener('click', () => void guarded(async () => {
    if (model.syncing) throw new Error('Stop the transfer before clearing staging.');
    if (!stagingDirectory) throw new Error('Choose your staging folder first.');
    if (!await confirmAction('Clear temporary movies?', 'Remove Roadtrip-managed movies from the selected staging folder? Unrelated files and the USB copies are kept.')) return;
    const manifest = await loadManifest(stagingDirectory);
    await navigator.locks.request(`roadtrip:${manifest.id}`, { ifAvailable: true }, async lock => {
      if (!lock) throw new Error('Another tab is using this staging folder.');
      await clearStaging(stagingDirectory, await loadManifest(stagingDirectory));
    });
    notice('Temporary movies cleared.');
  }));
});

const $ = selector => document.querySelector(selector);
const bytes = n => n >= 1e9 ? `${(n / 1e9).toFixed(1)} GB` : n >= 1e6 ? `${(n / 1e6).toFixed(1)} MB` : `${n.toLocaleString()} bytes`;
const date = value => value ? new Date(value).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : 'Never';
const model = { library: { movies: [] }, state: { picks: [], wishes: [], drives: [] }, view: 'library', limit: 36, directory: null, manifest: null, files: [], driveId: '', syncing: false, controller: null };
function element(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = value;
    else if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
    else if (value !== null && value !== undefined) node.setAttribute(key, value);
  }
  for (const child of children) if (child) node.append(typeof child === 'string' ? document.createTextNode(child) : child);
  return node;
}
const button = (text, action, className = 'secondary') => element('button', { text, class: className, onclick: () => void guarded(action) });
function notice(message, error = false) { $('#notice').textContent = message; $('#notice').className = `notice${error ? ' error' : ''}`; $('#notice').hidden = !message; }
async function guarded(action) { try { return await action(); } catch (e) { notice(e.message || 'Something went wrong. Please try again.', true); } }
async function api(route, data) {
  const response = await fetch(`/api/${route}`, data === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
  const result = await response.json();
  if (!response.ok) {
    if (response.status === 401 && route !== 'login') { $('#shell').hidden = true; $('#login').hidden = false; }
    throw new Error(result.error || 'The request failed.');
  }
  return result;
}
function who() { return $('#who').value.trim() || 'Family'; }
function picked(movieId) { return model.state.picks.some(p => p.movieId === movieId); }
function selectedParts() {
  const result = new Map();
  for (const pick of model.state.picks) {
    const movie = model.library.movies.find(m => m.id === pick.movieId);
    const variant = movie?.variants.find(v => v.id === pick.variantId);
    if (variant?.available) for (const part of variant.parts) result.set(part.id, part);
  }
  return [...result.values()];
}
function drive() { return model.state.drives.find(d => d.id === model.driveId) || model.state.drives[0]; }
function ready(movie, inventory = drive()) {
  return movie.variants.some(v => v.parts.length && v.parts.every(p => inventory?.files.some(f => f.partId === p.id && f.status === 'ready')));
}
function poster(movie, index = 0) {
  const container = element('div', { class: `poster tone-${index % 6}` }, [element('span', { class: 'poster-label', text: model.library.demo ? 'DEMO COLLECTION' : 'MOVIE LIBRARY' }), element('span', { class: 'poster-title', text: movie.title }), element('span', { class: 'poster-year', text: String(movie.year || 'FILM') })]);
  if (movie.poster) {
    const img = element('img', { src: movie.poster, alt: '', loading: 'lazy', decoding: 'async' });
    img.addEventListener('error', () => img.remove(), { once: true }); container.append(img);
  }
  return container;
}
async function addPick(movie, variantId) {
  const variant = movie.variants.find(v => v.id === variantId) || movie.variants.find(v => v.available);
  if (!variant) throw new Error('This movie’s file is unavailable. Check the server mount and refresh the library.');
  model.state = await api('picks', { movieId: movie.id, variantId: variant.id, who: who() });
  render(); notice(`${movie.title} is on the trip list.`);
}
function card(movie, index, driveMode = false) {
  const open = button('', () => showDetails(movie), 'poster-button');
  open.setAttribute('aria-label', `Details for ${movie.title}`); open.append(poster(movie, index));
  if (ready(movie)) open.append(element('span', { class: 'badge', text: '✓ On the drive' }));
  else if (!movie.available) open.append(element('span', { class: 'badge', text: 'File unavailable' }));
  const variant = movie.variants.find(v => v.available);
  const result = element('article', { class: 'movie-card' }, [open, element('h3', { text: movie.title, title: movie.title }), element('div', { class: 'movie-meta' }, [element('span', { text: `${movie.year || '—'} · ${movie.duration || '?'} min` }), element('span', { text: variant ? bytes(variant.size) : 'Unavailable' })])]);
  if (!driveMode) {
    const add = button(picked(movie.id) ? '✓ On the trip list' : '+ Add to trip', () => movie.variants.filter(v => v.available).length > 1 ? showDetails(movie) : addPick(movie), `add-button${picked(movie.id) ? ' selected' : ''}`);
    add.disabled = !movie.available; result.append(add);
  }
  return result;
}
function empty(title, text) { return element('div', { class: 'empty' }, [element('h2', { text: title }), element('p', { text })]); }
function renderLibrary() {
  const query = $('#search').value.toLowerCase().trim(), genre = $('#genre').value, sort = $('#sort').value;
  const movies = model.library.movies.filter(m => (!genre || m.genres.includes(genre)) && `${m.title} ${m.year} ${m.genres.join(' ')}`.toLowerCase().includes(query));
  movies.sort(sort === 'year' ? (a, b) => b.year - a.year : sort === 'size' ? (a, b) => (a.variants[0]?.size ?? Infinity) - (b.variants[0]?.size ?? Infinity) : (a, b) => a.title.localeCompare(b.title));
  $('#results-title').textContent = `${movies.length.toLocaleString()} movie${movies.length === 1 ? '' : 's'} to choose from`;
  $('#updated').textContent = model.library.updatedAt ? `Library updated ${date(model.library.updatedAt)}` : '';
  $('#movie-grid').replaceChildren(...movies.slice(0, model.limit).map((m, i) => card(m, i)));
  if (!movies.length) $('#movie-grid').append(empty(model.library.movies.length ? 'No matches this time' : 'Your library starts here', model.library.movies.length ? 'Try a different title or clear the genre filter.' : model.library.configured ? 'Click Refresh library to bring in your Plex movies and artwork.' : 'Set the Plex connection and media folder mappings in the server configuration, then click Refresh library.'));
  $('#more').hidden = movies.length <= model.limit;
}
function renderTrip() {
  const picks = model.state.picks, parts = selectedParts();
  const total = parts.reduce((sum, p) => sum + p.size, 0);
  const remaining = parts.reduce((sum, p) => {
    const r = model.manifest?.records[p.id];
    return sum + (r?.version === p.version ? p.size - r.chunks.reduce((n, c) => n + c.length, 0) : p.size);
  }, 0);
  $('#trip-total').textContent = `${picks.length} selection${picks.length === 1 ? '' : 's'} · ${bytes(total)}`;
  $('#trip-space').textContent = model.directory ? `${bytes(remaining)} left to copy, plus temporary working space.` : 'Connect your USB folder to check what’s already there.';
  $('#sync').disabled = model.syncing || !picks.length;
  $('#trip-list').replaceChildren(...picks.map(pick => {
    const movie = model.library.movies.find(m => m.id === pick.movieId), variant = movie?.variants.find(v => v.id === pick.variantId);
    const icon = movie?.poster ? element('img', { class: 'mini-poster', src: movie.poster, alt: '' }) : element('div', { class: 'mini-poster', text: '▸' });
    return element('div', { class: 'list-row' }, [icon, element('div', { class: 'row-text' }, [element('h3', { text: movie?.title || 'Movie removed from library' }), element('p', { text: `${variant?.label || 'Version unavailable'}${variant ? ` · ${bytes(variant.size)}` : ''} · Picked by ${pick.people.join(', ')}` }), !variant?.available ? element('p', { text: 'This selection cannot be synced until its file is available.' }) : null]), button('Remove from trip', async () => { model.state = await api('picks/remove', { key: pick.key }); render(); }, 'text-button')]);
  }));
  if (!picks.length) $('#trip-list').append(empty('A trip worth watching', 'Add movies from the library. Everyone’s choices will appear here.'));
}
function renderDrive() {
  const selected = drive();
  $('#drive-select').replaceChildren(...model.state.drives.map(d => element('option', { value: d.id, text: `${d.name || 'USB folder'} · ${date(d.scannedAt)}` })));
  if (selected) { model.driveId = selected.id; $('#drive-select').value = selected.id; }
  $('#drive-status').textContent = selected ? `${model.directory && model.manifest.id === selected.id ? 'Connected folder' : 'Last known contents'} · Scanned ${date(selected.scannedAt)} · ${bytes(selected.files.reduce((sum, f) => sum + f.size, 0))} in listed files. Existing files have not been verified against Plex.` : 'Connect a USB folder to see what’s already packed. Its catalog stays here when you unplug it.';
  $('#rescan').disabled = !model.directory || model.syncing;
  const matched = model.library.movies.filter(m => m.variants.some(v => v.parts.some(p => selected?.files.some(f => f.partId === p.id))));
  $('#drive-movies').replaceChildren(...matched.map((m, i) => card(m, i, true)));
  $('#drive-files').replaceChildren(...(selected?.files || []).map(file => {
    const movie = model.library.movies.find(m => m.variants.some(v => v.parts.some(p => p.id === file.partId)));
    const row = element('div', { class: 'list-row' }, [element('div', { class: 'row-text' }, [element('h3', { text: movie?.title || file.name }), element('p', { text: `${bytes(file.size)} · ${file.status === 'ready' ? 'Verified at transfer completion' : file.status === 'partial' ? 'Incomplete — resume from the trip list' : 'Existing file — left untouched'}${movie ? ` · ${file.name}` : ''}` })])]);
    if (file.partId && model.directory && model.manifest.id === selected.id && model.manifest.records[file.partId]) {
      const remove = button('Remove from USB', () => removeManaged(file.partId), 'text-button'); remove.disabled = model.syncing; row.append(remove);
    }
    return row;
  }));
  if (!selected?.files.length) $('#drive-files').append(empty('Nothing on the list yet', 'Connect your Movies folder, or add a few picks and sync your trip.'));
  if (model.manifest && selected?.id === model.manifest.id) {
    for (const [id, record] of Object.entries(model.manifest.records)) if (!model.files.some(f => f.partId === id)) {
      const forget = button('Forget missing-file record', () => removeManaged(id), 'text-button'); forget.disabled = model.syncing;
      $('#drive-files').append(element('div', { class: 'list-row' }, [element('div', { class: 'row-text' }, [element('h3', { text: record.filename }), element('p', { text: 'The transfer record exists, but the file is missing.' })]), forget]));
    }
  }
}
function renderWishes() {
  $('#wish-list').replaceChildren(...model.state.wishes.map(wish => element('div', { class: 'list-row' }, [element('div', { class: 'mini-poster', text: '☆' }), element('div', { class: 'row-text' }, [element('h3', { text: wish.title }), element('p', { text: `Requested by ${wish.who} · ${date(wish.createdAt)}` })]), button('Remove request', async () => { model.state = await api('wishes/remove', { id: wish.id }); render(); }, 'text-button')])));
  if (!model.state.wishes.length) $('#wish-list').append(empty('Something missing?', 'Add a title above so the family knows what to look for next.'));
}
function render() {
  $('#library-count').textContent = model.library.movies.length;
  $('#trip-count').textContent = model.state.picks.length;
  $('#wish-count').textContent = model.state.wishes.length;
  $('#drive-count').textContent = drive()?.files.length || 0;
  $('#demo-banner').hidden = !model.library.demo;
  $('#footer-drive').textContent = model.directory ? `USB folder: ${model.directory.name}` : 'No USB folder connected';
  $('#connect').textContent = model.directory ? `▣ ${model.directory.name} · Change folder` : '▣ Connect USB folder';
  $('#connect').disabled = model.syncing;
  $('#refresh').disabled = model.syncing;
  $('#logout').disabled = model.syncing;
  renderLibrary(); renderTrip(); renderDrive(); renderWishes();
}
const views = {
  library: ['A LITTLE SOMETHING FOR EVERYONE', 'What’s coming along?', 'Find a favorite. Add it to the trip. We’ll handle the packing.'],
  trip: ['THE FAMILY’S PICKS', 'Our next movie marathon.', 'One shared list. A little room for everyone’s favorites.'],
  drive: ['READY FOR THE ROAD', 'Already packed.', 'Your USB movie catalog, even when the stick is away.'],
  wishlist: ['FOR ANOTHER MOVIE NIGHT', 'Put it on the wishlist.', 'The movies we’d love to add to the collection.'],
};
function changeView(view) {
  model.view = view;
  for (const name of Object.keys(views)) $(`#${name}-view`).hidden = name !== view;
  for (const node of document.querySelectorAll('[data-view]')) { node.classList.toggle('active', node.dataset.view === view); node.setAttribute('aria-current', node.dataset.view === view ? 'page' : 'false'); }
  const [eyebrow, title, description] = views[view];
  $('#view-eyebrow').textContent = eyebrow; $('#view-title').textContent = title; $('#view-description').textContent = description;
}
function showDetails(movie) {
  const select = element('select', { id: 'version', 'aria-label': 'Movie file version' }, movie.variants.map(v => element('option', { value: v.id, text: `${v.label} · ${bytes(v.size)}${v.available ? '' : ' · Unavailable'}`, ...(v.available ? {} : { disabled: '' }) })));
  select.value = movie.variants.find(v => v.available)?.id || '';
  const add = button('Add this version to the trip +', async () => { await addPick(movie, select.value); $('#details').close(); }, 'primary'); add.disabled = !movie.available;
  $('#details-body').replaceChildren(element('div', { class: 'detail-layout' }, [poster(movie), element('div', {}, [element('p', { class: 'eyebrow', text: `${movie.year || ''} · ${movie.rating || 'Not rated'} · ${movie.duration || '?'} MIN` }), element('h2', { text: movie.title }), element('p', { text: movie.summary || 'No description available from Plex.' }), element('p', { class: 'muted', text: movie.genres.join(' · ') }), element('label', { for: 'version', text: 'Version to copy' }), select, add]) ]));
  $('#details').showModal();
}
function confirmAction(title, text, label = 'Remove') {
  $('#confirm-title').textContent = title; $('#confirm-body').textContent = text; $('#confirm-yes').textContent = label;
  const dialog = $('#confirm'); dialog.returnValue = ''; dialog.showModal();
  return new Promise(resolve => dialog.addEventListener('close', () => resolve(dialog.returnValue === 'yes'), { once: true }));
}
async function persistInventory() {
  model.files = await scanDirectory(model.directory, model.manifest);
  const parts = model.library.movies.flatMap(m => m.variants.flatMap(v => v.parts));
  for (const file of model.files) if (!file.partId) {
    const matches = parts.filter(p => p.size === file.size && [p.filename, p.originalName].some(n => n && n.toLowerCase() === file.name.split('/').at(-1).toLowerCase()));
    if (matches.length === 1) file.partId = matches[0].id;
  }
  model.state = await api('drives', { id: model.manifest.id, name: model.directory.name, files: model.files });
  model.driveId = model.manifest.id;
  render();
}
async function connect() {
  if (model.syncing) return;
  if (!window.isSecureContext || !window.showDirectoryPicker) throw new Error('Direct USB syncing needs desktop Chrome or Edge over HTTPS (or localhost). Open the secure home address on the computer with your USB stick.');
  let directory;
  try { directory = await window.showDirectoryPicker({ id: 'roadtrip-usb', mode: 'readwrite', startIn: 'documents' }); } catch (e) { if (e.name === 'AbortError') return; throw e; }
  const manifest = await connectManifest(directory);
  model.directory = directory; model.manifest = manifest;
  await persistInventory();
  notice(`Connected to “${directory.name}”. Existing files will be left untouched. Choose your trip list to start syncing.`);
}
async function removeManaged(id) {
  if (model.syncing || !model.directory) return;
  const record = model.manifest.records[id]; if (!record) return;
  if (!await confirmAction('Remove this copy from the USB?', `This removes “${record.filename}” from the connected folder and forgets its transfer checkpoints. The Plex source and trip list stay available.`)) return;
  await withDriveLock(async () => {
    model.manifest = await loadManifest(model.directory);
    const latest = model.manifest.records[id];
    if (!latest || latest.filename !== record.filename) throw new Error('The drive record changed. Rescan and try again.');
    if (await maybeFile(model.directory, record.filename)) {
      let parent = model.directory;
      const segments = record.filename.split('/');
      for (const segment of segments.slice(0, -1)) parent = await parent.getDirectoryHandle(segment);
      await parent.removeEntry(segments.at(-1));
    }
    delete model.manifest.records[id]; await saveManifest(model.directory, model.manifest);
    await persistInventory(); notice('The USB copy has been removed.');
  });
}
async function withDriveLock(action) {
  if (!navigator.locks) throw new Error('This browser cannot safely coordinate USB transfers. Use an up-to-date desktop Chrome or Edge.');
  return navigator.locks.request(`roadtrip:${model.manifest.id}`, { ifAvailable: true }, lock => {
    if (!lock) throw new Error('Another tab is working with this USB folder. Finish or pause it first.');
    return action();
  });
}
async function sync() {
  if (model.syncing) return;
  if (!model.directory) { await connect(); if (!model.directory) return; }
  const parts = selectedParts();
  if (!parts.length) throw new Error('There are no available files in the trip list.');
  const useStaging = $('#stage-enabled').checked;
  const stageBudget = Number($('#stage-budget').value) * 1e9;
  if (useStaging && !stagingDirectory) throw new Error('Choose a dedicated temporary folder on your SSD first.');
  if (useStaging && (await stagingDirectory.isSameEntry(model.directory) || await stagingDirectory.resolve(model.directory) !== null || await model.directory.resolve(stagingDirectory) !== null)) throw new Error('The SSD staging folder and USB folder must be separate, not nested.');
  for (const pick of model.state.picks) if (!model.library.movies.find(m => m.id === pick.movieId)?.variants.find(v => v.id === pick.variantId)?.available) throw new Error('The trip list contains unavailable selections. Remove them or refresh the library before syncing.');
  await withDriveLock(async () => {
    model.manifest = await loadManifest(model.directory);
    const remaining = parts.reduce((sum, p) => { const r = model.manifest.records[p.id]; return sum + (r?.version === p.version ? p.size - r.chunks.reduce((s, c) => s + c.length, 0) : p.size); }, 0);
    const workingSpace = Math.max(...parts.map(p => model.manifest.records[p.id]?.status === 'ready' ? 0 : p.size));
    if ($('#free-space').value && Number($('#free-space').value) * 1e9 < remaining + workingSpace) throw new Error(`Allow about ${bytes(remaining + workingSpace)} free space for the remaining files and browser checkpoint working space. Remove movies explicitly or shorten the list.`);
    model.syncing = true; model.controller = new AbortController();
    $('#sync-panel').hidden = false; $('#pause').disabled = false; $('#cancel').disabled = false;
    $('#sync-title').textContent = 'Checking your trip list…'; $('#sync-progress').value = 0;
    const guard = new WakeGuard(text => { $('#wake-status').textContent = text; });
    const preventClose = e => { e.preventDefault(); e.returnValue = ''; };
    window.addEventListener('beforeunload', preventClose);
    try {
      render(); await guard.start();
      for (const [index, part] of parts.entries()) {
        const onProgress = progress => {
          if (model.controller.signal.aborted) return;
          $('#sync-title').textContent = progress.filename;
          $('#sync-progress').value = Math.round(100 * progress.completed / progress.total);
          $('#sync-detail').textContent = `${index + 1} of ${parts.length} files · ${progress.phase} · ${bytes(progress.completed)} / ${bytes(progress.total)}`;
        };
        if (!model.manifest.records[part.id]) {
          const candidate = model.files.find(f => f.size === part.size && (f.partId === part.id || [part.filename, part.originalName].some(n => n && n.toLowerCase() === f.name.split('/').at(-1).toLowerCase())));
          if (candidate) await adoptExisting(model.directory, model.manifest, part, candidate.name, model.controller.signal, onProgress);
        }
        if (useStaging && model.manifest.records[part.id]?.status !== 'ready') {
          const stageManifest = await loadManifest(stagingDirectory);
          await navigator.locks.request(`roadtrip:${stageManifest.id}`, { ifAvailable: true }, async lock => {
            if (!lock) throw new Error('Another tab is using this staging folder.');
            await stagedTransfer(stagingDirectory, model.directory, model.manifest, part, stageBudget, model.controller.signal, onProgress);
          });
        } else await transferPart(model.directory, model.manifest, part, model.controller.signal, onProgress);
      }
      $('#sync-title').textContent = 'All packed. Enjoy the trip.';
      $('#sync-detail').textContent = `${parts.length} files checked and ready. Eject your USB stick using your computer’s file manager.`;
      notice('Your trip list is on the drive. All copied data passed its checks.');
    } catch (e) {
      const paused = model.controller.signal.aborted || e.name === 'AbortError';
      const cancelled = model.controller.signal.reason === 'cancel';
      $('#sync-title').textContent = cancelled ? 'Transfer cancelled.' : paused ? 'Paused. Your checkpoints are saved.' : 'Transfer stopped safely.';
      $('#sync-detail').textContent = 'Click Sync trip to USB to check saved data and continue.';
      notice(cancelled ? 'No more movies will be copied. Completed movies and verified partial copies are kept. Use On the drive to remove unwanted copies.' : paused ? 'Completed checkpoints are kept. The current unsaved checkpoint will be copied again.' : `${e.message} Completed movies and saved checkpoints are kept.`, !paused);
    } finally {
      window.removeEventListener('beforeunload', preventClose); await guard.stop();
      model.syncing = false; $('#pause').disabled = true; $('#cancel').disabled = true;
      try { model.manifest = await loadManifest(model.directory); await persistInventory(); } catch (e) { notice(`Transfer ended, but the drive catalog could not be updated: ${e.message}`, true); }
      render();
    }
  });
}
async function initialize() {
  const session = await api('session');
  $('#login').hidden = session.authenticated; $('#shell').hidden = !session.authenticated;
  if (!session.authenticated) return;
  [model.library, model.state] = await Promise.all([api('library'), api('state')]);
  const genres = [...new Set(model.library.movies.flatMap(m => m.genres))].sort();
  $('#genre').replaceChildren(element('option', { value: '', text: 'All genres' }), ...genres.map(g => element('option', { value: g, text: g })));
  render();
}
$('#login-form').addEventListener('submit', e => { e.preventDefault(); void (async () => { try { await api('login', { password: $('#password').value }); $('#password').value = ''; $('#login-error').textContent = ''; await initialize(); } catch (error) { $('#login-error').textContent = error.message; } })(); });
$('#logout').addEventListener('click', () => void guarded(async () => { await api('logout', {}); await initialize(); }));
for (const node of document.querySelectorAll('[data-view]')) node.addEventListener('click', () => changeView(node.dataset.view));
$('#search').addEventListener('input', () => { model.limit = 36; renderLibrary(); });
for (const id of ['genre', 'sort']) $(`#${id}`).addEventListener('change', () => { model.limit = 36; renderLibrary(); });
$('#more').addEventListener('click', () => { model.limit += 36; renderLibrary(); });
$('#refresh').addEventListener('click', () => void guarded(async () => { $('#refresh').disabled = true; $('#refresh').textContent = 'Refreshing…'; notice('Reading your movie libraries from Plex…'); try { await api('refresh', {}); await initialize(); notice('Your Plex library is up to date.'); } finally { $('#refresh').disabled = false; $('#refresh').textContent = '↻ Refresh library'; } }));
$('#connect').addEventListener('click', () => void guarded(connect));
$('#rescan').addEventListener('click', () => void guarded(async () => { model.manifest = await loadManifest(model.directory); await persistInventory(); notice('USB catalog updated.'); }));
$('#drive-select').addEventListener('change', e => { model.driveId = e.target.value; render(); });
$('#sync').addEventListener('click', () => void guarded(sync));
function stopTransfer(reason) {
  if (!model.syncing || model.controller?.signal.aborted) return;
  model.controller.abort(reason);
  $('#pause').disabled = true; $('#cancel').disabled = true;
  $('#sync-title').textContent = reason === 'cancel' ? 'Cancelling transfer…' : 'Pausing transfer…';
  $('#sync-detail').textContent = 'Waiting for the current USB operation to finish safely. Keep the drive connected; browser disk operations can take time to stop.';
}
$('#pause').addEventListener('click', () => stopTransfer('pause'));
$('#cancel').addEventListener('click', () => stopTransfer('cancel'));
$('#wish-form').addEventListener('submit', e => { e.preventDefault(); void guarded(async () => { model.state = await api('wishes', { title: $('#wish-title').value, who: who() }); $('#wish-title').value = ''; render(); notice('Added to the family wishlist.'); }); });
$('.dialog-close').addEventListener('click', () => $('#details').close());
$('#confirm-no').addEventListener('click', () => $('#confirm').close('no'));
$('#confirm-yes').addEventListener('click', () => $('#confirm').close('yes'));
try { $('#who').value = localStorage.getItem('roadtrip-name') || ''; } catch {}
$('#who').addEventListener('change', () => { try { localStorage.setItem('roadtrip-name', $('#who').value); } catch {} });
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && !model.syncing && !$('#shell').hidden) void guarded(async () => { model.state = await api('state'); render(); }); });
void guarded(initialize);

// Progressive enhancement: unsupported browsers simply use the visible interface.
if (document.modelContext?.registerTool) {
  const lifecycle = new AbortController();
  window.addEventListener('pagehide', () => lifecycle.abort(), { once: true });
  const tools = [
    { name: 'search_movie_library', description: 'Search the signed-in family library and show matching movies.', inputSchema: { type: 'object', properties: { query: { type: 'string', maxLength: 120 } }, required: ['query'], additionalProperties: false }, annotations: { readOnlyHint: true, untrustedContentHint: true }, execute: async input => { if (typeof input?.query !== 'string' || input.query.length > 120) throw new Error('A query of up to 120 characters is required.'); const library = await api('library'); model.library = library; $('#search').value = input.query; changeView('library'); render(); return library.movies.filter(m => m.title.toLowerCase().includes(input.query.toLowerCase())).slice(0, 30).map(m => ({ id: m.id, title: m.title, year: m.year, available: m.available })); } },
    { name: 'add_movie_to_trip', description: 'Add an available movie to the shared trip list using the name shown in the interface. Does not transfer files.', inputSchema: { type: 'object', properties: { movieId: { type: 'string' } }, required: ['movieId'], additionalProperties: false }, annotations: { readOnlyHint: false, untrustedContentHint: true }, execute: async input => { if (typeof input?.movieId !== 'string') throw new Error('A movie ID is required.'); const movie = model.library.movies.find(m => m.id === input.movieId); if (!movie) throw new Error('Movie not found.'); await addPick(movie); changeView('trip'); return { added: movie.id, title: movie.title }; } },
  ];
  for (const tool of tools) try { Promise.resolve(document.modelContext.registerTool(tool, { signal: lifecycle.signal })).catch(() => {}); } catch {}
}
