# Tealbrick platform

The one enforced CI/CD template for every Tealbrick repo, the signed release registry (index, offers, harness options, Portal root and key-set statements), the signer, the deploy and promote scripts, the status page, the database backup job, and the operations runbooks.

- Repository: `Tealbrick/opt2-tealbrick-platform` (GitHub organisation `Tealbrick`)
- Status: main `9512b0a`. CI template `ci-v9.9` (also the minimum, `ci/MIN_TEMPLATE`). Signed index with 197 releases (app 127, package 38, bridge 29, desktop 3) and 10 offers. Live runs from the org repos; the status page watches live and dev.
- Visibility target: PUBLIC and it must stay public (C181): every repo's pipeline fetches the CI runner from it anonymously, Core and the installers read the index from it, and a private repo would bill about 5,700 Actions minutes a month.
- Licence: public repository with no licence file (`package.json` is `private`). The repo holds no secrets and no product source.

## No secrets policy

This repository is public. It must never contain secrets or personal data:

- No API keys, tokens, passwords, private keys (the release signing key and the root keys included), deployment secrets, `.env` files or connection strings. Use placeholder values only.
- Runtime secrets live in the deployment platform (Railway variables, GitHub Actions environment `registry`) and are copied between services without printing them. The Woodpecker pipelines hold no secrets.
- No personal names, private agent configurations or customer data, in the code, issues or pull requests.
- Every push runs a secret scan (gitleaks, the first step of `.woodpecker/ci.yaml`). GitHub secret scanning with push protection is enabled. Optional local guard: `pre-commit install`.
- If a secret is committed anyway: rotate it first, then remove it from history.

## What this repo is and is not

Platform is three things in one repo: (a) `ci/`, the CI standard and the registry signer logic; (b) `registry/`, the signed index and its inputs; (c) `ops/`, deploy, promote, backup, status, key tools and runbooks.

It is NOT a place for customer data or product code. Git is its store.

## Quick start

```sh
corepack enable && pnpm install --frozen-lockfile --ignore-scripts
pnpm typecheck && pnpm lint && pnpm test    # some tests fetch pinned tarballs: network needed
pnpm stamp                                  # write the runner sha256 into the template and .woodpecker/ci.yaml
```

Operator tools need the operator Mac's Railway CLI login (`~/.railway/config.json`) and `gh` login. They read no variable values.

```sh
node ops/railway-deploy.ts --service <name> --repo opt2-tealbrick-<x> --sha <40-hex> [--dockerfile <p>] [--environment production|live]
node ops/promote.ts --set <dir>/RS-<n>.json [--dry-run]         # release set to live
node ops/promote.ts --rollback --set <dir>/RS-<n-1>.json        # re-promote an older set
node ci/tb-ci.ts adopt ../opt2-tealbrick-<name> --kind <kind>   # adopt the template in a repo
```

## Layout

| Path | Purpose |
|---|---|
| `ci/tb-ci.ts` | The CI runner and signer logic (setup, install, run, gen, pre-release, plan-images, release-record, registry-sync, registry-sign, registry-add-source, registry-add-desktop, pin-tarballs, package-pack, gh-build, gh-publish, audit-templates, adopt, stamp). Start at `ci/README.md` |
| `ci/woodpecker/ci.yaml`, `ci/github/opt2-release.yml` | The templates copied byte for byte into every repo |
| `ci/tealbrick-ci.schema.json`, `ci/MIN_TEMPLATE` | Per-repo config schema; minimum allowed template (`ci-v9.9`) |
| `registry/index.json`, `index.jws`, `keys.json` | Signed release index and the public release-index key set (`registry/README.md`) |
| `registry/offers.json`, `harnesses.json`, `products.json` | Reviewed inputs: offers, harness options, product to repo and kind binding (GTP-01) |
| `registry/portal-root-keys.dev.json` | PUBLIC dev root keys |
| `registry/portal-keyset.jws`, `portal-keyset.live.jws` (+ `.request.json`) | Root-signed key-set statements for dev Core and live Core |
| `ops/railway-deploy.ts`, `promote.ts`, `prod-secrets.ts`, `root-key.ts`, `woodpecker-activate.ts` | Operator tools |
| `ops/status/`, `ops/db-backup/` | Status page service; nightly dump and restore test |
| `ops/RUNBOOK.md`, `ENVIRONMENTS.md`, `BACKUPS.md`, `KEYS.md`, `ROTATION-LOG.md` | Runbooks |
| `.github/workflows/registry-sync.yml` | The signer |
| `.woodpecker/ci.yaml`, `template-audit.yaml` | Own CI and the daily template audit |

## Configuration

Operator environment and files (names only): `GITHUB_TOKEN`, `RELEASE_SIGNING_KEY` (Actions environment `registry`), `TB_PRIVATE_READ_TOKEN`, `TB_MANIFEST_MODULE` or `TB_MANIFEST_PKG` + `TB_MANIFEST_INTEGRITY` + `TB_SPEC_PKG` + `TB_SPEC_INTEGRITY`, `TB_DIST_BASE_URL`, `TB_CI_REF`, `WOODPECKER_URL`. Services: db-backup `DATABASE_URL`, `BACKUP_DIR`, `KEEP`, `HEARTBEAT_URL`; status `PORT`, `INTERVAL_S`. `TB_REGISTRY_UNSIGNED` is documented as retired but still read: with `1` the index is published UNSIGNED. Never set it.

## Language

New code is TypeScript (Node 24 or later, run directly without a build step).

## How it ships

Template releases are tags `ci-vN.M` (latest `ci-v9.9`). The registry is published as assets of the `registry` release by the `registry-sync` workflow. `db-backup` and `status` are Railway services built from this repo at a pinned SHA.

## Documentation

- `ARCHITECTURE.md` explains the design.
- `CONTRIBUTING.md` explains how to change it.
- System documentation (overview, environments, runbooks) lives in the private repo Tealbrick/opt2-tealbrick-docs.
- `ci/README.md`, `registry/README.md`, `ops/RUNBOOK.md`: long-form sources in this repo.
