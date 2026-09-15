# Using Roadtrip

[Back to README](../README.md)

## Optional SSD staging

Open **Settings**, turn on **Use SSD staging**, and select a dedicated empty folder on your computer's SSD (not on the USB). Staging is off by default; your choice and budget are remembered in this browser. Set a temporary-space budget in GB; 16 GB is a useful starting point. The budget accounts for about twice a movie's size plus existing staging files and metadata because browsers may create working copies. It does not reserve disk space or measure free space. Check available SSD space in your file manager. Re-select the same staging folder after reloading to resume a staged download. Choosing a folder does not automatically turn staging on.

For smaller movie files, see [tablet copies and transcoding](transcoding.md).

Movies are downloaded and verified on SSD one at a time, then copied to USB in a single write transaction and verified there. Only after USB verification succeeds is that staged movie removed. If the budget is too small, increase it, clear old temporary files, or disable staging for direct copying. Unrelated files are never removed by **Clear temporary files**.

Pausing or cancelling preserves staged downloads. An interrupted final USB write restarts from its previous saved checkpoint (from zero for a new movie); it does not save new intermediate USB checkpoints. FAT32 file-size limits still apply. Select physically separate SSD and USB folders; the browser cannot determine which physical disk holds a selected folder. Staging is optional and its speed benefit depends on the drives. Initial verification uses automated filesystem simulations; physical USB/browser performance still needs testing.

1. Open the configured HTTPS address and sign in with the family password.
2. Click **Refresh library**. This imports movie metadata and file versions. Posters are cached as they are viewed.
3. Enter your name under **Who's picking?** Browse movies and add selections to **Our trip list**.
4. Add unavailable titles to **Wishlist**.
5. Plug the USB stick into a laptop or desktop. Open the app there in Chrome or Edge.
6. Click **Connect USB folder**, choose a dedicated Movies folder on the stick, and grant write access. Browsers may reject selecting the root of a drive, so use a folder.
7. Open **Our trip list** and click **Sync trip to USB**. Optionally enter free space from your file manager; the browser cannot measure the stick's actual free space.
8. Keep the tab and laptop lid open. Wait for **All packed**, then eject the stick through your operating system.

You can use any browser to browse and choose movies. Desktop Chrome/Edge with trusted HTTPS is the supported direct-sync target; mobile devices and other browsers are not promised to support folder writing.

## Transfer integrity and recovery

The server sends at most 8 MiB per request and hashes each chunk with SHA-256. The browser checks the received checksum, writes data, closes the file at a checkpoint, then reads back the committed bytes before saving their hashes in `.roadtrip-drive.json`.

- The first checkpoint is at 256 MiB. Subsequent intervals grow with the committed file size (256 MiB, 512 MiB, 1 GiB, and so on), with a final checkpoint at EOF. This reduces repeated copying of existing USB data. An interruption late in a large movie can require repeating a larger unsaved interval; completed checkpoints remain resumable.
- A pause, disconnect, refresh, or sleep can discard the current **uncommitted** checkpoint. Previously committed checkpoints are kept.
- To resume, reconnect the same Movies folder, open the trip list, and click Sync. The app verifies all saved checkpoints before continuing.
- If a movie is already complete, its saved checksums are checked before it is skipped.
- Source identity includes size, modification time, change time, and inode. If the source changes, transfer stops instead of combining different versions.
- Existing files that match Plex's original filename and size are fully compared to the source before adoption. Same-size mismatches stop with an explanation; they are not overwritten.
- A partial file uses the final movie filename and may appear in VLC. Only entries marked ready by Roadtrip have completed verification. Finish syncing before taking the stick.
- If a partial copy is damaged, use **On the drive → Remove from USB**, confirm the named file, and sync again. Missing files have a separate **Forget missing-file record** action.
- Preserve `.roadtrip-drive.json`. Do not edit it or use two different browsers/computers to write the same folder at once. Tabs within the same browser coordinate through a Web Lock, but separate browsers cannot share that lock.
- If the record is unreadable, the app stops without replacing it. Restore a known-good copy, or use a different folder; do not delete movie files as a first troubleshooting step.

Browser checkpoint writes may make a temporary copy of the existing file. This makes resuming reliable but can be slower on USB flash storage and may need working space up to another movie's size. The space estimate conservatively includes that allowance. Do not use browser quota estimates as USB free-space measurements.

A screen wake lock is best-effort. Closing the lid, suspending the computer, battery policies, changing tabs, or closing the browser can interrupt a transfer. Recovery protects completed work; it does not turn a browser tab into a background service.
