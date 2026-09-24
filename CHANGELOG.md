# Changelog

## 2026-09-24

- Select tablet quality in the trip list, prepare the trip on the server, and return later to transfer completed copies.
- Persistent conversion queue with CPU or optional NVIDIA NVENC, 720p/1080p H.264 copies, and selectable audio tracks.
- Configurable generated-copy retention: seven days before transfer and 24 hours after verified USB delivery by default.
- Protect active transfers from cache cleanup, preserve expired selections for regeneration, and wait for cache space before starting a conversion.
- Settings for encoder, server cache, retention, and optional SSD staging (off by default).
- Original media stays read-only; cache cleanup targets only generated conversion files.

## 0.1.0 — 2026-09-08

Initial public release.

- Plex catalog with artwork, search, genres, file versions and sizes.
- Shared trip picks, picker names, wishlist and saved USB catalogs.
- Browser-to-USB transfers with SHA-256 checks and durable resume checkpoints.
- Existing-file verification, explicit removals, pause/retry and wake locks.
- Read-only media mappings, mount sentinels, password sessions and server-side credentials.
- Docker Compose, optional Caddy HTTPS and isolated demo mode.
- Installation, configuration, usage, troubleshooting, operations, API and contributor guides.
- Cross-platform tests and Docker/configuration checks in GitHub Actions.

Known limits: original-file copies only; no transcoding, subtitle sidecars, automatic acquisition, separate accounts or guaranteed background operation. Direct USB sync targets desktop Chrome/Edge. Checkpoints require extra working space and may reduce flash-drive throughput.
