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

The [CI workflow](https://github.com/CrazyLegsFE/roadtrip-library/actions/workflows/ci.yml) runs tests on Linux and Windows, validates Compose, builds and smoke-tests the Docker image, and validates Caddy. Refer to the exact commit's run for its status; configuring a workflow is not proof that it passed.

## Not verified in this environment

- Docker is unavailable on the local development host. Docker and configuration execution is delegated to the linked CI workflow; its result must be checked before release.
- Real Plex/TrueNAS connection: server address, token, and host mount paths have not been supplied. Plex API tests use a local mock server; demo files are explicitly non-playable test data.
- Physical USB drive, desktop browser folder permissions, OS sleep/lid behavior, and client certificate trust. The filesystem test adapter models transactional commit/abort behavior; it is not a real browser or USB device.
- Browser rendering, keyboard interaction, or responsive visual inspection were not performed in the local validation pass.
- Optional WebMCP registration/execution in a supporting browser. Tools are feature-detected and omitted by unsupported browsers; their browser contract has not been verified.
- Caddy startup and local certificate installation, which must be performed on the Ubuntu server and client machines.

## First home validation

After configuring `.env`, run `docker compose config --quiet`, build/start the chosen Compose profile, and verify the HTTPS address is trusted in desktop Chrome or Edge. Refresh Plex, confirm a known movie and poster, and transfer one small file to a test folder on the USB drive. Pause and resume it, check that the app marks it ready, then open it in VLC. Only then prepare a full trip collection.

The user guide documents checkpoint working-space requirements, browser limitations, source/version checks, explicit removal, mount sentinels, and recovery from damaged or missing transfer records.
