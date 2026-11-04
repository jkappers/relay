# ADR 0013: Container image and release flow

Status: accepted

## Decision

One image, `ghcr.io/jkappers/relay`, built in GitHub Actions for `linux/amd64` and `linux/arm64`. `latest` only moves by a manual, approved promotion of a version that was already built, scanned, and smoke tested. A release never rebuilds.

No new runtime dependencies. `tsx` moved from `devDependencies` to `dependencies` (same version) because every process starts with `node --import tsx`; the image installs with `--prod`.

New CI-only tools, run as containers pinned by digest (not as marketplace actions): Trivy 0.76.1 and gitleaks 8.30.1. Marketplace actions are pinned by commit SHA.

## Image

- Multi-stage. `prod-deps` (production install), `console` (full install + `pnpm build:console`), `runtime` (clean `node:24-slim`, non-root `node`, npm and corepack removed).
- One image, three processes. Default command is the HTTP server. Override the command for the worker, the gateway, and the migrator (see the Dockerfile comment).
- No `.env` is copied (`.dockerignore`). Configuration comes from the environment.
- The base image is pinned by digest. Dependabot (`docker`) opens the bump PRs.

## Tags

| Tag | Meaning | Moves |
|---|---|---|
| `cand-<sha12>` | Built from `main`. Untested. | never |
| `sha-<sha12>` | Passed source scan, image scan, and smoke test | never |
| `edge` | Latest tested `main` | every green build |
| `X.Y.Z`, `X.Y`, `X` | Released (stable) | `X.Y` and `X` move on patch/minor |
| `X.Y.Z-rc.N` | Release candidate | never |
| `latest` | Promoted stable | only by `promote` |

## Flow

1. **PR**: both architectures build (no push). gitleaks and Trivy fs run.
2. **Push to `main`**: per-arch builds push by digest (native runners, no QEMU). `merge` joins them into `cand-<sha12>` and attests build provenance (`actions/attest`, stored in the registry). Trivy scans the digest, and the smoke test migrates a Postgres, starts the server and worker, and checks `/healthz`, the console, non-root, and no `.env`, on both architectures. Then `tested` adds `sha-<sha12>` and `edge`.
3. **Tag `vX.Y.Z` or `vX.Y.Z-rc.N`** on a `main` commit: `release` requires `sha-<sha12>` to exist, verifies the attestation, adds the version tags with `imagetools create` (same digest), and creates the GitHub release.
4. **Promote**: run `promote` with a stable version. It needs approval from the `production` environment, verifies the attestation, rescans the digest, and points `latest` at it. Rolling back is promoting an older version.
5. **Nightly**: Trivy rescans `latest` and `edge`.

## Scanning

- gitleaks over full history, with `.gitleaks.toml` allowing the fake credentials in tests.
- Trivy `fs` (lockfile vulnerabilities, secrets, Dockerfile and workflow misconfig) and `image` (OS and app packages, secrets). Gate: HIGH or CRITICAL with a fix available.
- Findings in the image scan upload to code scanning as SARIF.
- Exceptions go in `.trivyignore`, one per line, with a reason and a date.

## Notes

- GHCR packages start private. After the first push, make the package public in its settings (not reversible). The `org.opencontainers.image.source` label links it to the repo.
- Provenance is a GitHub artifact attestation on the index digest, not a BuildKit attestation. The per-arch builds set `provenance: false` so the index merge stays flat.
- `latest` is never produced by `docker/metadata-action`, whose handling of pre-release tags is inconsistent in its README.
- Trivy and gitleaks digests in the workflows are not tracked by Dependabot. Bump them by hand.
