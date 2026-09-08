# Configuration

[Back to README](../README.md)

Compose reads `.env`; Node reads process environment variables. Keep real configuration and data volumes out of Git.

| Variable | Description |
|---|---|
| `APP_PASSWORD` | Your own password of at least 12 characters. The example placeholder is rejected. |
| `APP_HOST` | Browser-facing HTTPS hostname. Compose derives `APP_ORIGIN=https://<APP_HOST>`. |
| `PLEX_URL` | Plex URL reachable inside Docker. The included `host.docker.internal` mapping can reach Plex on the Docker host. |
| `PLEX_TOKEN` | Server-side Plex authentication token. |
| `PLEX_SECTION_IDS` | Optional comma-separated movie-library IDs. Blank includes all movie libraries; TV is ignored. |
| `MEDIA_SOURCE` | Existing absolute media mount on the Docker host, exposed at `/media/movies`. |
| `MEDIA_PATH_MAPPINGS` | JSON array of `plex`, `local`, and optional `sentinel` values. |

## The three paths

Suppose a NAS share is mounted on Ubuntu at `/mnt/nas/films`, while Plex runs in a container that sees the same share as `/movies`:

| Location | Example movie path |
|---|---|
| Plex | `/movies/Example (2024)/Example.mkv` |
| Ubuntu | `/mnt/nas/films/Example (2024)/Example.mkv` |
| Roadtrip container | `/media/movies/Example (2024)/Example.mkv` |

Configure:

```dotenv
MEDIA_SOURCE=/mnt/nas/films
MEDIA_PATH_MAPPINGS='[{"plex":"/movies","local":"/media/movies","sentinel":".roadtrip-media-root"}]'
```

Use the path reported by Plex's media information, not an `smb://` URL. The longest matching prefix at a directory boundary wins. Resolved symlinks must remain inside configured media roots.

## Multiple shares

Add another read-only bind to `roadtrip.volumes` in `compose.yaml`:

```yaml
- type: bind
  source: /mnt/nas/kids
  target: /media/kids
  read_only: true
  bind:
    create_host_path: false
```

Then include both mappings:

```dotenv
MEDIA_PATH_MAPPINGS='[{"plex":"/movies","local":"/media/movies","sentinel":".roadtrip-media-root"},{"plex":"/kids","local":"/media/kids","sentinel":".roadtrip-media-root"}]'
```

Create each sentinel deliberately on its mounted source share. A missing marker blocks refresh and preserves the old catalog. Do not create markers in empty local mountpoints to silence an unavailable-NAS error.

## Direct Node settings

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `8787` | HTTP port behind the proxy |
| `HOST` | `0.0.0.0`; `127.0.0.1` in demo | Bind address; demo Compose explicitly uses `0.0.0.0` inside its loopback-published container |
| `DATA_DIR` | App's `data/` | Writable state directory; Docker sets `/data` |
| `APP_ORIGIN` | `http://localhost:8787` | Exact browser-facing HTTP(S) origin, including nondefault port; no path, query, fragment or credentials |
| `DEMO_MODE` | `false` | Only `true` enables fictional test data and bypasses login |

Direct Node startup does not translate `APP_HOST` into `APP_ORIGIN`. Set the full origin in a custom deployment. Do not enable demo mode for real household data.

## Versions and permissions

The smallest available Plex version is the default. Open movie details to select another. A missing part makes a multi-part version unavailable. Refresh after source changes.

The container runs as UID/GID 1000. Grant read/traversal access to media through Samba mount options or a suitable supplemental group. The media sources should remain read-only. Run one application replica per data directory.
