# Operations and updates

[Back to README](../README.md)

```sh
docker compose logs --tail=100 roadtrip
docker compose ps
```

The `/health` endpoint checks that the web service is running; it does not claim Plex or a TrueNAS mount is available. **Refresh library** checks source mount sentinels and Plex access. File transfer also checks that the current source is available and unchanged.

Back up the `app-data` volume for trip lists, wishlist entries, saved drive inventories, cached metadata/posters, and the session signing key. Caddy uses its own persistent volumes. Stopping/recreating containers preserves those volumes; do not remove volumes when updating. Rotate `APP_PASSWORD` and recreate the service to invalidate existing sessions.

No scheduled library scanning is enabled. Refresh manually after adding or changing movies in Plex. Saved USB catalogs show the most recent scan, not live contents of a disconnected stick. Names are labels under one shared family password, not separate accounts or parental controls.

## Update

Pause transfers first and back up the data volume. From your checkout:

```sh
git pull --ff-only
docker compose --profile tls up -d --build
```

Omit `--profile tls` if using an existing proxy. Preserve `.env` and Compose customizations. A fast-forward failure means local source changes need reviewing before updating. Do not force-reset a customized checkout. Pin a release tag if you prefer deliberate upgrades to following `main`.

## Backup and restore

Stop the app while making a consistent backup of its entire `/data` directory:

```sh
docker compose stop roadtrip
docker compose cp roadtrip:/data ./roadtrip-data-backup
docker compose start roadtrip
```

Store backups outside the repository with access restricted to administrators. The session key, server paths, viewing choices and cached artwork are sensitive. Also preserve `.env` privately and back up Caddy's volumes if using its local CA. Losing the CA requires retrusting its replacement on clients.

For restoration, stop the app, restore the saved data into its mounted data volume, ensure UID/GID 1000 can read/write it, then restart. Restore to a test deployment first when possible. Keep the old backup until you have confirmed lists, settings, and Plex access. Never remove Docker volumes as an update step.
