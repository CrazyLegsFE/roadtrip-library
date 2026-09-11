# Installation

[Back to README](../README.md)

You need Docker Engine with the Compose plugin on Ubuntu, existing media folders on local storage or mounted network shares (NFS or SMB/CIFS), the Plex URL and token, and an HTTPS address trusted by the client computers.

The app copies original movie files. It does not transcode, remove DRM, or copy separate subtitles/extras. Multi-part Plex media is copied as separate numbered parts. Check that your tablet/VLC can play the chosen version. A filesystem with a 4 GB per-file limit cannot hold larger movies; use an appropriate filesystem supported by your tablet, commonly exFAT.

### 1. Configure your folders and Plex

Copy this `roadtrip` folder onto the Ubuntu server, or download it directly from GitHub with the commands below. For a first installation, paste this into a terminal on your Ubuntu server:

```sh
mkdir -p ~/docker &&
cd ~/docker &&
git clone https://github.com/CrazyLegsFE/roadtrip-library.git &&
cd roadtrip-library &&
cp .env.example .env &&
chmod 600 .env &&
nano .env
```

The `&&` separators stop the sequence if a command fails. These commands download the app into `~/docker/roadtrip-library`, create your private configuration file, and open it in Nano. If you already cloned the repository, open your existing `.env` instead of copying the template over it.

If `git` or `nano` is missing, install them first with `sudo apt update && sudo apt install -y git nano`, then run the commands above.

In Nano, save with **Ctrl+O**, press **Enter**, and exit with **Ctrl+X**. Complete the settings below and the HTTPS setup before starting the containers.

Edit `.env`:

| Setting | Meaning |
|---|---|
| `APP_PASSWORD` | Your own family password, at least 12 characters. |
| `APP_HOST` | The HTTPS hostname you will use, such as `roadtrip.home.arpa`. |
| `PLEX_URL` | URL reachable from the container. Default example reaches Plex on the Docker host. |
| `PLEX_TOKEN` | Your Plex authentication token; it stays on the server. |
| `PLEX_SECTION_IDS` | Optional comma-separated movie library section IDs. Blank includes all movie libraries. |
| `MEDIA_SOURCE` | Existing absolute movie folder path on the Ubuntu Docker host, on local storage or a mounted network share. |
| `MEDIA_PATH_MAPPINGS` | JSON mapping Plex's file-path prefix to the container's file-path prefix. |

For example, if Plex reports `/mnt/truenas/movies/Example (2024)/Example.mkv` and that folder is mounted into the container at `/media/movies`:

```dotenv
MEDIA_SOURCE=/mnt/truenas/movies
MEDIA_PATH_MAPPINGS='[{"plex":"/mnt/truenas/movies","local":"/media/movies","sentinel":".roadtrip-media-root"}]'
```

#### Local storage or network shares

Roadtrip supports both. Set `MEDIA_SOURCE` to an existing folder on the Docker host; a NAS is not required.

- **Local storage:** use your actual movie folder, for example `/srv/movies`. Confirm it contains your movies. A folder on Ubuntu's root filesystem is valid. If the folder is on a separately mounted disk, first verify that the expected disk is mounted.
- **Network storage:** mount the share on the Docker host first. NFS (`nfs`/`nfs4`) and Samba/SMB (`cifs`) both work. The path must be the host's mounted folder, not a NAS-internal path or an `smb://` URL.

For a network share or separately mounted local disk, inspect the mount first (replace the example path):

```sh
findmnt -T /mnt/truenas/movies
```

Check the output before continuing: it must show the expected NAS/export or local disk. If you expected a separate mount but see Ubuntu's root filesystem, restore the mount first. Root filesystem output is normal for media intentionally stored on that filesystem.

#### Create the marker for each source

The supplied mappings use a sentinel: an empty file named `.roadtrip-media-root`. Create it once in each configured source folder, whether local or network storage, after confirming that the folder contains the intended media and any required mount is present.

For the network example above:

```sh
touch /mnt/truenas/movies/.roadtrip-media-root
```

For local movies at `/srv/movies`, use this instead:

```sh
touch /srv/movies/.roadtrip-media-root
```

Use your own paths and repeat for every source folder. Do not create a marker in an empty mountpoint while its disk or share is disconnected. A missing configured marker blocks library refresh and preserves the cached catalog. The application never creates markers automatically.

If Plex itself runs in a container, its paths may differ from Ubuntu's paths. The `plex` prefix must match what Plex reports; `MEDIA_SOURCE` must be the Ubuntu host path; `local` must match the Roadtrip container mount. For multiple source folders, add read-only bind mounts in `compose.yaml` and corresponding mappings in the JSON array. Use a sentinel for each source folder. See [multiple source folders](configuration.md#multiple-source-folders).

The container runs as UID/GID 1000. Give it read and directory traversal permissions on the media. Use suitable local file permissions, NFS server permissions/UID mapping, or SMB mount ownership/modes, and a supplemental group where appropriate. Keep the container's media bind mounts read-only.

Plex documents token access at [Finding an authentication token](https://support.plex.tv/articles/204059436-finding-an-authentication-token-x-plex-token/).

### 2. Choose your HTTPS setup

Direct folder access and screen wake locks require a secure browser context. A plain LAN URL such as `http://192.168.1.10:8787` will not provide USB syncing. A certificate warning you click through is not a reliable substitute for a trusted HTTPS setup.

**If you already have a reverse proxy:**

```sh
docker compose config --quiet
docker compose up -d --build
```

Configure your existing proxy to serve `https://<APP_HOST>` and forward to `http://127.0.0.1:8787` on the Ubuntu host. If your proxy is in a different container, join it to the Compose network and use `http://roadtrip:8787`; its own `127.0.0.1` is not the Ubuntu host. Avoid opening the app directly to the internet. The public HTTPS origin must exactly match `APP_HOST`, including any nondefault port used in a custom configuration.

**If you do not have a reverse proxy:**

The optional Caddy service provides local HTTPS. It needs free ports 80 and 443 on Ubuntu.

```sh
docker compose config --quiet
docker compose --profile tls up -d --build
```

Make `roadtrip.home.arpa` (or your chosen `APP_HOST`) resolve to the Ubuntu server's LAN IP through your router/local DNS, or a hosts-file entry on each client.

Caddy's local certificate authority must be trusted on every client used for syncing. Export its **public root certificate** after startup:

```sh
docker compose cp https:/data/caddy/pki/authorities/local/root.crt ./roadtrip-root.crt
```

Install that certificate into the client's trusted root certificate store, then restart its browser if needed. Do not export or share Caddy's private keys. Windows uses the Trusted Root Certification Authorities certificate store; macOS uses Keychain Access; Linux trust configuration varies by distribution/browser. See [Caddy local HTTPS](https://caddyserver.com/docs/automatic-https#local-https).

If you already have a trusted certificate and domain, your existing proxy is usually the easier option. No external hosting service is involved.
