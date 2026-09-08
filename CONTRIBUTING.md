# Contributing

Start with an issue for substantial workflow or architecture changes so scope can be discussed before implementation.

## Local setup

Use Node.js 24 or newer. No dependency installation or compilation is needed.

Linux/macOS:

```sh
DEMO_MODE=true DATA_DIR=./demo-data node server.mjs
```

PowerShell:

```powershell
$env:DEMO_MODE = 'true'
$env:DATA_DIR = './demo-data'
node server.mjs
```

Open `http://localhost:8787`. Demo binds to loopback unless `HOST` is explicitly set. Clear demo variables before trying a real configuration. The demo's files are non-playable test data.

## Validation

```sh
node scripts/check.mjs
node --test
```

Checks cover syntax and relative documentation links. Tests cover server behavior, path containment, persistence and transfer recovery, using a transactional filesystem adapter plus real HTTP integration. Keep tests independent of private Plex access and physical USB hardware.

With Docker available:

```sh
docker compose --env-file .env.example --profile tls config --quiet
docker compose -f compose.demo.yaml up --build
```

Run `node scripts/smoke-demo.mjs` in another terminal. CI also builds/smoke-tests Docker, validates Caddy, and tests Node on Linux and Windows.

## Change guidelines

- Preserve ready, incomplete and unverified-existing states.
- Never advance checkpoints before committed data passes verification.
- Do not overwrite unrelated files or silently remove movies to make room.
- Keep movie-payload memory bounded and test interrupted writes/boundaries.
- Keep credentials server-side; treat metadata, filenames and manifests as untrusted.
- Update configuration, architecture and recovery docs when behavior changes.
- Keep the single-process deployment simple unless a concrete need justifies change.
- Add meaningful regression coverage; state which real-browser/USB checks were actually performed.

Explain the problem, resulting behavior and validation in a PR. Use synthetic fixtures; do not submit copyrighted movies, private metadata, tokens or personal configuration. Contributions use the [MIT license](LICENSE).
