# Architecture and API

[Back to README](../README.md)

One Node.js 24 process serves a framework-free browser client. There are no third-party JavaScript runtime dependencies. Docker runs the same source as direct Node development.

## Server and state

`server.mjs` handles login, Plex refresh, cached posters, serialized state changes, and bounded range responses. It reads existing host media folders on local storage or mounted network shares. It does not mount disks, NFS exports, or SMB shares itself.

Plex tokens stay on the server. Resource URLs must remain on the configured Plex origin; redirects are rejected. Files are addressed by catalog part ID. Mapped paths and resolved symlink targets must remain inside configured media roots.

| Data path | Contents |
|---|---|
| `state.json` | Trip picks, wishlist, last-known USB inventories |
| `catalog.json` | Plex metadata and private source paths |
| `session.key` | Persistent random session-signing seed |
| `art/` | Plex posters cached on demand |

JSON writes go through a temporary file, sync, and rename. Shared-state mutations serialize inside one process. Run one replica per data directory; this is not a distributed database.

The password and random seed derive an HMAC session key. Cookies last seven days, with HttpOnly, SameSite=Strict, and Secure on HTTPS. Changing the password invalidates previous signatures. POST requires the configured Origin and a JSON object. Login rate limits use the socket address, which may be shared behind a proxy.

## Browser and transfers

`public/app.js` owns the interface. Shared data stays on the server; only the picker name is stored as a local preference. Metadata/user text is rendered as text, not HTML.

`public/transfer.js` handles folder access, manifests, hashing, checkpoints and wake locks. A short initialization Web Lock prevents two tabs from assigning different IDs to a new folder. A per-drive lock serializes writes within the same browser/origin; different browsers cannot share this lock.

1. Query current source size/version.
2. Check saved source identity and rehash the committed USB prefix before resuming.
3. Request an explicit range of at most 8 MiB.
4. Require HTTP 206, exact Content-Range, expected ETag, and `X-Chunk-SHA256`.
5. Hash received bytes before writing; commit every 256 MiB and at EOF.
6. Close the writable stream, read back committed chunks, and only then save checkpoint hashes.
7. At EOF, check output size and source availability/version before marking ready.

Source identity derives from size, mtime, ctime and inode, checked around each server read. It is not a whole-file content address. Integrity assumes a trusted server/filesystem and HTTPS connection.

Each chunk has a 45-second request deadline and up to four attempts with bounded backoff. Pause aborts fetch and the open writable stream. Uncommitted data may need repeating; failed manifest writes do not advance durable progress. Browser checkpoint writes may temporarily duplicate an existing file.

Existing filename/size candidates use `digest=1`: the server hashes ranges without sending the movie payload. The browser compares local bytes before adopting the existing file.

## USB manifest

`.roadtrip-drive.json` contains `schema: 1`, a UUID, and records keyed by part ID. Each record has a relative filename, version, size, partial/ready state, optional adopted flag, and contiguous chunk start/length/hash entries. Unsafe paths, duplicate filenames and invalid checkpoints are rejected. The 32 MiB limit is checked before replacing a manifest. Treat the format as internal during the early release series.

## HTTP API

All `/api/` routes except session/login require a family cookie, unless demo mode is explicitly enabled. POST bodies are JSON objects and require the correct Origin. Errors return `{ "error": "message" }`.

| Method | Path | Purpose/body |
|---|---|---|
| GET | `/health` | Process liveness, not a Plex/NAS probe |
| GET | `/api/session` | Authentication/demo state |
| POST | `/api/login` | `{password}` |
| POST | `/api/logout` | Clear cookie |
| GET | `/api/library` | Public catalog/configuration state |
| POST | `/api/refresh` | Refresh Plex and mounted media |
| GET | `/api/state` | Picks, wishes, inventories |
| POST | `/api/picks` | `{movieId, variantId, who}` |
| POST | `/api/picks/remove` | `{key}` |
| POST | `/api/wishes` | `{title, who}` |
| POST | `/api/wishes/remove` | `{id}` |
| POST | `/api/drives` | `{id, name, files}` |
| GET | `/api/art/:movieId` | Cached poster |
| GET | `/api/files/:partId?version=...&info=1` | Current source metadata |
| GET | `/api/files/:partId?version=...` | Explicit range and digest |
| GET | `/api/files/:partId?version=...&digest=1` | Range digest without payload |

URL-encode path IDs. Invalid ranges return 416, changed sources 409, and busy/unavailable sources 503. At most four range responses are active per process.

Optional WebMCP tools expose search and adding to the trip list. They do not grant filesystem access, start transfers or delete files. Real-browser WebMCP validation is separate from automated API tests.
