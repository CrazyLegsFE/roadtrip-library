import { loadManifest, saveManifest, transferPart, maybeFile, digest } from './transfer.js';

export async function stagingUsage(directory) {
  let total = 0;
  for await (const [, handle] of directory.entries()) {
    if (handle.kind === 'directory') throw new Error('Choose a dedicated staging folder without subfolders.');
    total += (await handle.getFile()).size;
  }
  return total;
}

export async function clearStaging(directory, manifest) {
  for (const [id, record] of Object.entries(manifest.records)) {
    if (record.filename.includes('/')) throw new Error('Use a dedicated staging folder without nested records.');
    if (await maybeFile(directory, record.filename)) await directory.removeEntry(record.filename);
    delete manifest.records[id];
    await saveManifest(directory, manifest);
  }
}

export async function stagedTransfer(staging, destination, destinationManifest, part, budget, signal, progress = () => {}) {
  const manifest = await loadManifest(staging);
  const used = await stagingUsage(staging);
  const previous = manifest.records[part.id];
  const existing = previous && await maybeFile(staging, previous.filename);
  const existingSize = existing ? (await existing.getFile()).size : 0;
  // Include existing data, the growing file and its browser swap file, plus metadata.
  const required = used - existingSize + 2 * part.size + 1024 * 1024;
  if (!Number.isFinite(budget) || budget <= 0 || required > budget) throw new Error(`SSD staging needs a budget of at least ${(required / 1e9).toFixed(2)} GB for this movie and existing temporary files. Increase the budget, clear staging, or switch to direct copying.`);
  await transferPart(staging, manifest, part, signal, p => progress({ ...p, phase: `SSD: ${p.phase}` }));
  const record = manifest.records[part.id];
  const file = await (await maybeFile(staging, record.filename)).getFile();
  await transferPart(destination, destinationManifest, part, signal, p => progress({ ...p, phase: `USB: ${p.phase}` }), {
    checkpointSize: part.size,
    readChunk: async (_, start, end) => {
      const buffer = await file.slice(start, end + 1).arrayBuffer();
      const hash = await digest(buffer);
      const expected = record.chunks.find(c => c.start === start && c.length === buffer.byteLength);
      if (!expected || expected.hash !== hash) throw new Error('The SSD copy changed. USB transfer stopped.');
      return { buffer, hash };
    }
  });
  // Only remove our staged movie after the destination is verified and marked ready.
  await staging.removeEntry(record.filename);
  delete manifest.records[part.id];
  await saveManifest(staging, manifest);
}
