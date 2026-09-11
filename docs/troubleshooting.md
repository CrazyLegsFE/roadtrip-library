# Troubleshooting

[Back to README](../README.md)

## Cannot connect a USB folder

Use current desktop Chrome or Edge over trusted HTTPS, or localhost on the same machine. A plain LAN IP over HTTP does not qualify. Choose a Movies folder inside the stick; browsers may reject selecting a drive's root. Reconnect and grant write access if permission was revoked.

## Incorrect origin error

The address in the browser must match `APP_ORIGIN`, including protocol and port. Compose derives it from `APP_HOST`. Opening an IP address when configured for a hostname fails write requests. Correct the proxy/hostname and open the configured address.

## Plex refresh fails

Check the token and `PLEX_URL` from the Docker network. `localhost` inside a container is not the Ubuntu host. Use the supplied `host.docker.internal` mapping for Plex on the same host, or its reachable LAN/service address. Ensure `PLEX_SECTION_IDS` selects movie libraries; leave it blank to include all. Failed refreshes keep the previous catalog.

## Missing mount or sentinel

For network shares or separately mounted local disks, inspect the host mount with `findmnt -T /your/media/path` and confirm the expected share or disk is present. NFS (`nfs`/`nfs4`) and SMB (`cifs`) are both supported. Restore a missing mount before checking its marker; do not create a marker in an empty fallback mountpoint. Recreating the container may be necessary after remounting.

For media intentionally stored on the host's root filesystem, root filesystem output is normal. Verify the source folder contains your movies and the configured sentinel exists there. For either storage type, check that the container user can read the marker and traverse the directories.

## Posters appear but files are unavailable

Plex metadata access and source-file access are separate. Recheck the three paths in [configuration](configuration.md) and read/traversal permissions for UID/GID 1000. Keep the source read-only, then refresh.

## Cannot write a large movie

Check permission, connection and free space. FAT32 cannot hold a single file larger than 4 GB minus one byte. Use a filesystem your tablet supports for larger files. Formatting erases data; preserve important files before changing a filesystem.

## Transfer stops on sleep or tab changes

Wake locks are best-effort. Keep the tab visible, lid open and computer powered. Stalled chunk requests time out after 45 seconds and get up to four attempts. Reconnect the same folder and click Sync to verify checkpoints and continue.

## Slow transfers or unexpected space requirements

Roadtrip hashes received data, commits every 256 MiB, and reads back writes. Browser checkpoints can temporarily copy the existing file, reducing throughput on flash storage. Allow working space up to another movie's size. The optional free-space field is manual because browser quota APIs do not measure USB free space.

## Existing file differs from Plex

A filename/size match is only a candidate. A content mismatch stops without overwriting it. Choose the appropriate Plex version or move the existing file outside the selected folder before copying. Do not delete it unless you intend to remove it.

## Source changed or checkpoint verification failed

Refresh Plex. For a damaged/incomplete managed copy, use **On the drive → Remove from USB**, confirm the named file, then sync it again. Other completed movies remain. If you want to keep an old version, move it outside the selected folder first.

## File missing but its record remains

Use **Forget missing-file record** on the drive screen, then sync again. It clears only that movie's saved checkpoints, not the Plex source.

## Unreadable or oversized transfer record

Preserve `.roadtrip-drive.json` and all movies. Restore a known-good record or use another Movies folder. The 32 MiB record limit is checked before replacement. Do not hand-edit offsets or checksums.

## Unplugged movies still appear

This is the saved inventory. Read its **Last known contents** timestamp. Connect and rescan to update it. Scanning checks filenames/sizes; syncing verifies managed-file checksums before reuse.

## Report a problem

Include version, server/client OS, browser version, filesystem, proxy type, steps to reproduce, and sanitized errors. Try the demo to separate browser issues from Plex/mount setup. Never post tokens, passwords, cookies or data-volume backups in an issue. Use [Security](../SECURITY.md) for vulnerabilities.
