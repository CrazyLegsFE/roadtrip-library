# Tablet copies and transcoding

[Back to README](../README.md)

Transcoding is optional. Originals remain read-only. The standard image works without FFmpeg; the transcoding image adds FFmpeg and a persistent, single-job conversion queue inside the Roadtrip service. Jobs keep running when the browser closes. Interrupted jobs restart from the beginning after server restart. Completed versions appear in the movie's version selector and use the existing verified USB transfer and optional SSD staging.

## Dependencies and hardware support

The standard app works without FFmpeg, GPU drivers, or a GPU. Library browsing, trip lists, wishlist, copying originals, verification, and SSD staging remain available. Transcoding is an optional server feature; it does not use the USB computer's GPU or Plex's transcoder.

- **CPU encoding:** supported on Intel and AMD CPUs. Add `compose.transcode.yaml`; its image installs FFmpeg inside the container. No host FFmpeg installation or GPU device passthrough is needed. Allow writable server storage for generated copies (50 GB cache budget by default, configurable).
- **NVIDIA encoding:** add both transcoding and NVIDIA overrides. The server needs an H.264 NVENC-capable GPU, a compatible NVIDIA driver, and the [NVIDIA Container Toolkit installed and configured for Docker](https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/latest/install-guide.html). A successful `nvidia-smi` confirms device visibility, but an actual NVENC encode is needed to confirm encoding works with the container's FFmpeg.
- **Intel and AMD GPUs:** hardware acceleration is not implemented in Roadtrip yet. There are no QSV/Quick Sync, VA-API, or AMD hardware encoder settings. Use **CPU** or copy original files. Installing GPU drivers or passing `/dev/dri` alone does not enable these encoders in the app.

Do not include `compose.nvidia.yaml` on a server without configured NVIDIA hardware: Docker may reject the GPU reservation before the app starts. Selecting NVENC does not silently fall back to CPU on an encoding failure. Select CPU and prepare again to retry without GPU encoding; newly queued jobs use that choice. CPU remains a working option on a server that also has a GPU.

## Enable on your server

Keep your existing `compose.yaml`, media mounts, `.env`, and HTTPS setup. Stop any USB transfer, update, then layer the supplied overrides onto your current file.

For CPU encoding (Intel or AMD; no GPU required):

```sh
git pull --ff-only &&
docker compose -f compose.yaml -f compose.transcode.yaml config --quiet &&
docker compose -f compose.yaml -f compose.transcode.yaml up -d --build
```

Leave **Settings → Video encoder** set to **CPU** and save if changing from NVIDIA.

For NVIDIA (including the Tesla P4 host where a basic NVENC encode was tested):

```sh
git pull --ff-only &&
docker compose -f compose.yaml -f compose.transcode.yaml -f compose.nvidia.yaml config --quiet &&
docker compose -f compose.yaml -f compose.transcode.yaml -f compose.nvidia.yaml up -d --build
```

For CPU encoding, omit `-f compose.nvidia.yaml`. If you use the original optional Caddy profile, add `--profile tls` before `up`; a custom Compose file with an always-on Caddy service needs no profile. These overrides do not change ports or media mounts. The image build downloads FFmpeg from Debian package repositories and therefore requires working outbound package access.

Use the same `-f` arguments on future updates. Alternatively, set `COMPOSE_FILE=compose.yaml:compose.transcode.yaml:compose.nvidia.yaml` in your Ubuntu `.env`; then ordinary `docker compose up -d --build` uses all three. Do not run `down -v`: that removes saved application data and certificates.

NVIDIA requires the host driver and NVIDIA Container Toolkit. The override exposes video/compute/utility driver capabilities. Select **Settings → Video encoder → NVIDIA GPU (NVENC)** and save. CPU is the default; changing this setting applies to newly queued jobs. Existing jobs keep their encoder choice. GPU encoding does not imply GPU decoding or GPU tone mapping: this first implementation uses software decoding, scaling and HDR processing, with two FFmpeg threads/filter threads. Benchmark a representative movie before preparing a large trip.

## Prepare and copy

1. Open a movie's details and choose a single-file original version.
2. Choose 720p (~2 Mbps video) or 1080p (~4 Mbps video). Estimates are about 1.9 GB and 3.7 GB for two hours, respectively, including 128 kbps stereo AAC. Variable bitrate and container overhead mean actual size differs. Movies are not upscaled.
3. Optionally load audio languages and select a track. Otherwise the default audio track, or first track if no default is set, is used.
4. Click **Add tablet selection to trip**. Repeat for other movies, then click **Prepare trip** in the trip list. Preparation runs on the server, so you can close the page. The trip list shows each selection's status; Settings also provides progress and cancellation.
5. Return later, connect your USB folder, and click **Transfer prepared trip** once every selection is ready. Keep the browser open during USB copying. Existing original-version picks are not silently replaced; remove them explicitly if you only want the smaller copy.

The output is H.264, 8-bit MP4 with stereo AAC. HDR10/HLG is tone-mapped to SDR using FFmpeg zscale and Hable tone mapping. **Subtitles, including forced subtitles, are not included.** Use the original for movies requiring subtitles. Dolby Vision sources and multi-part versions are rejected for conversion in this release; choose an SDR/HDR10 single-file version instead. Test picture, audio, seeking and any essential dialogue before travel.

## Server cache and recovery

The server cache defaults to 50 GB under `/data/transcodes` in the existing application volume. Settings controls its budget independently of the client SSD budget. A conservative space estimate and actual server free-space check run before encoding; the running job checks the cache limit periodically (so a small transient overshoot is possible). Jobs that cannot start due to insufficient space wait and retry periodically. Increase the budget or remove unused cached copies in Settings if needed.

Generated copies expire after **7 days**, or **24 hours after the browser reports a verified USB transfer**. Both periods are configurable in Settings; changes apply to future completions, transfer receipts, and extensions. Use **Extend retention** to keep a ready copy longer. Closing the page during preparation does not stop the queue. Closing it during a USB transfer does not count as successful delivery.

Cleanup runs approximately once a minute, with a ten-minute grace period after server startup. Active downloads and connected USB transfers protect their cached files; abandoned transfer protection expires after ten minutes without renewal. Cleanup and manual cache removal target only recorded, generated filenames in the dedicated conversion cache. Source media remains mounted read-only, and the server rejects a conversion cache overlapping configured media roots. USB copies are never removed by server cleanup.

Expired or removed copies retain their trip selections and preparation choices. Click **Prepare trip** to regenerate them. Cancel queued/running jobs or remove inactive cached copies in Settings. Retention deadlines do not override active transfer protection. Interrupted conversions restart from the beginning when the server comes back.

Completed outputs are checked for video codec and duration before becoming selectable. Download checksums protect the transferred bytes. A source fingerprint check rejects movies changed during conversion. This does not replace watching a sample for quality assessment.

## SSD staging settings

**Settings → Use SSD staging** is off for a fresh browser. The on/off choice and GB budget are remembered in that browser; folder permissions must be selected again after reopening the page. Choosing a folder does not automatically enable staging. Existing presets, custom budget, folder picker, and explicit cleanup remain available. Settings cannot change the active transfer's staging configuration.

## Validation and troubleshooting

Queue tests cover serialization, persisted settings, reuse, cancellation, restart recovery, invalid presets/tracks, changed sources, and failed-output cleanup. Existing USB and SSD tests still apply. The prior P4 test confirmed basic H.264 NVENC with Ubuntu FFmpeg; this new Debian image and real HDR media need deployment testing. No GPU or Docker daemon is available in the Windows development environment.

If a job reports FFmpeg missing, use the transcoding image. NVENC library/device errors usually require checking the GPU override, host driver and toolkit. Do not disable certificate verification to solve package-download errors. A failed job can be queued again from the movie; changing encoder generates a distinct cached version.

References: [FFmpeg filters](https://ffmpeg.org/ffmpeg-filters.html), [Docker GPU configuration](https://docs.docker.com/compose/how-tos/gpu-support/), [NVIDIA driver capabilities](https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/latest/docker-specialized.html#driver-capabilities).
