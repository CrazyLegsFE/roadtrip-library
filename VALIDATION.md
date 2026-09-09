# Validation record

Release: 0.1.0. Date: 2026-09-08. Local runtime: Node.js 24.19.0 on Windows.

## Passed

- `node --test`: **27 passed, 0 failed, 0 skipped**.
- `node scripts/check.mjs`: JavaScript syntax and relative documentation links pass.
- Local HTTP smoke check: the demo page returned HTTP 200.
- Real HTTP integration: the browser transfer engine retrieved demo bytes from the actual server, verified checksums, committed the destination through a transactional adapter, and adopted an existing matching file through server digest requests.
- Authentication, cross-origin write rejection, serialized shared state updates, persistence after application recreation, and credentials/paths excluded from public catalog responses.
- Byte-range boundaries, chunk digests, changed-source detection, missing-mount catalog preservation, path traversal rejection, and symlink containment.
- Successful transfer, checkpoint resume after disk-full failure, pause/abort, modified USB content rejection, unmanaged filename collision protection, matching/mismatching existing-file adoption, failed manifest writes, invalid checksums, and damaged checkpoint rejection.
- Wake-lock acquisition, release, and visibility-triggered reacquisition using simulated browser APIs.
- Simultaneous drive initialization, duplicate/null manifest entries, stalled-request deadlines, synchronous wake-lock rejection, malformed JSON bodies, cross-origin Plex resources, and unsafe startup configuration.

## Continuous integration

The [first public CI run](https://github.com/CrazyLegsFE/roadtrip-library/actions/runs/34292475291) passed all three jobs for implementation commit `8b7838a14b7bb2ac73b46b8ebafd487430cb886b`:

- All 27 tests and documentation/syntax checks on Ubuntu.
- All 27 tests and documentation/syntax checks on Windows.
- Production/demo Compose validation, Docker image build, demo-container HTTP/range/checksum smoke test, and Caddy configuration validation.

This record was updated after that run; the subsequent change is documentation only. Refer to the [workflow history](https://github.com/CrazyLegsFE/roadtrip-library/actions/workflows/ci.yml) for later commits.

## Not verified in this environment

- Real Plex/TrueNAS connection: server address, token, and host mount paths have not been supplied. Plex API tests use a local mock server; demo files are explicitly non-playable test data.
- Physical USB drive, desktop browser folder permissions, OS sleep/lid behavior, and client certificate trust. The filesystem test adapter models transactional commit/abort behavior; it is not a real browser or USB device.
- Browser rendering, keyboard interaction, or responsive visual inspection were not performed in the local validation pass.
- Optional WebMCP registration/execution in a supporting browser. Tools are feature-detected and omitted by unsupported browsers; their browser contract has not been verified.
- Caddy serving a real household hostname and client certificate installation. Configuration validation passed in CI, but certificate trust must be configured on actual clients.

## First home validation

After configuring `.env`, run `docker compose config --quiet`, build/start the chosen Compose profile, and verify the HTTPS address is trusted in desktop Chrome or Edge. Refresh Plex, confirm a known movie and poster, and transfer one small file to a test folder on the USB drive. Pause and resume it, check that the app marks it ready, then open it in VLC. Only then prepare a full trip collection.

The user guide documents checkpoint working-space requirements, browser limitations, source/version checks, explicit removal, mount sentinels, and recovery from damaged or missing transfer records.
