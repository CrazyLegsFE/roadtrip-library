# Changelog

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
