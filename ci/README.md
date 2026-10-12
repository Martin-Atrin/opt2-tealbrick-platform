# opt2 CI standard (template ci-v9.2)

One Woodpecker pipeline for every opt2 repo. It is an enforced standard, not a convention:
every repo's `.woodpecker/ci.yaml` is a byte-identical copy of `ci/woodpecker/ci.yaml`, and the
`setup` step fails when the copy drifts, when `tealbrick-ci.json` is invalid, or when package rules are broken.

## Enforcement (C56 D1)
- `ci/MIN_TEMPLATE` on platform `main` holds the minimum template ref (now `ci-v8`; it may move to `ci-v9.1` only when all 18 repos in `OPT2_REPOS` are on ci-v9.1 or later, which they were not at ci-v9.2: packages, portal-core, portal-gui, website, tbd and qa on ci-v8, samples on ci-v9). From ci-v6 on, `setup` fails when the repo's template is below it, so raising the file forces every repo to re-adopt.
- Template refs are `ci-vN` or, for a point release, `ci-vN.M` (ci-v9.1 on). They compare as major.minor: `ci-v9` < `ci-v9.1` < `ci-v10`. A runner older than ci-v9.1 cannot parse `ci-vN.M`, so `MIN_TEMPLATE` may name a point release only after every repo is on ci-v9.1 or later.
- Repos still on a template older than ci-v6 (which has no such check) are caught by the platform's daily `template-audit` pipeline (`node ci/tb-ci.ts audit-templates`): it goes red and names them.
- One template for every repo. Kinds: `library`, `service`, `miniapp`, `bridge`, `portal`, `web`, `static` (static site, e.g. the website: node stages + build, no images), `desktop` (TBD: `paths` = the TypeScript projects, e.g. `["chat"]`), `specs`, `tests`.
- Written exemption, desktop: the macOS/Swift build, signing and notarization cannot run on the Linux CI host. They run on the release Mac (`scripts/release.sh` in opt2-tealbrick-tbd); the release enters the index only through `registry-add-desktop`, which checks the artifact sha256. Secret scan, typecheck, lint, unit and build of the TypeScript parts run in this template like everywhere else. A repo-specific `.woodpecker/*.yml` that repeats these stages (e.g. the old `chat.yml`) must be deleted.

## Stages (in order)

| Step | What it does | Fails when |
|---|---|---|
| secret-scan | gitleaks over the working tree (redacted output) | any finding |
| setup | fetches `tb-ci.ts` at the pinned tag, checks its sha256, template drift, `tealbrick-ci.json`, package rules | drift, bad config, `private` missing, required script missing, no lockfile, any `VOLUME` instruction in any Dockerfile (C42) |
| install | `pnpm install --frozen-lockfile` (or `npm ci`) per path | lockfile out of date |
| typecheck / lint / unit | root scripts `typecheck`, `lint`, `test` | non-zero exit |
| conformance | root script `conformance` (required for kind miniapp, bridge) | non-zero exit |
| build | root script `build` if present; writes `.tb-ci/images.sh` | non-zero exit |
| gen | (BSA-03) if a `gen/` is committed: `tb-gen check` first (stale = fail); then the repo's `gen` script (must be `tb-gen all`) and a check that gen/openapi, gen/kit/<product>-kit, gen/docs, gen/railway exist; then `tb-gen check` | kind miniapp without a `gen` script, a stale committed gen/, a gen script that does not produce every kind, drift |
| image-check | kaniko builds every declared image, no push (PR, push, manual) | build fails |
| postgres (opt-in, ci-v9.1) | detached step after `setup`. Starts an ephemeral Postgres 17 only when `tealbrick-ci.json` has `"postgres": true`; otherwise it exits 0 at once (green). When on, the `unit` step waits for it (max 90 s) and gets `TB_TEST_DATABASE_URL`; tests that want a real database skip when it is unset. ci-v9.2: the step stops itself when the unit step ends (see below), so it is green | opted in and not reachable within 90 s |
| release-record | tag `v*`: hash-checked runner validates the manifest/services/runtime and prints the release. No token, no signing key; the manifest package is loaded only if it matches `TB_MANIFEST_INTEGRITY` (C62). ci-v9.2: pinned to `@opt2-tealbrick/manifest` 0.1.8 (spec 0.1.13: wildcard companions, M-CP-3; 0.1.5 refused `product:"*"`) | invalid manifest, version mismatch, any token in the environment |

Paths without `package.json` skip the node stages with a warning (fresh scaffolds stay green).

## Release publishing (C72): GitHub Actions, no personal token
Every releasing repo (images, miniapp kit, or package tarballs) carries `.github/workflows/opt2-release.yml`, a byte-identical copy of `ci/github/opt2-release.yml` (setup fails on drift; `adopt` writes it). It runs on `v*` and `<pkg>-v*` tags only:
1. `build` job — `permissions: contents: read`. Fetches the hash-checked runner, then `tb-ci gh-build`: `docker build` each declared image from the tagged commit with OCI labels (source, revision, version) and saves it to a tarball; builds the miniapp kit (`tb-gen kit --build`), or for a package tag installs, BUILDS (root `build` script, else `pnpm --filter <pkg>... run --if-present build`) and packs the tagged workspace package (`npm pack --ignore-scripts`). Installs use `--frozen-lockfile --ignore-scripts`. No write token exists in this job.
   - Pack guard (ci-v9.1, C75): after `npm pack` the runner reads the tarball and fails if any `main`, `module`, `types`/`typings`, `bin` or `exports` target of the packed `package.json` is missing (for example no `dist/`). ci-v9 packed without a build, so `<pkg>-v*` tarballs released by the ci-v9 workflow can lack `dist/`; re-release them from ci-v9.1.
2. `publish` job — `permissions: packages: write, contents: write`, built-in `GITHUB_TOKEN`. Runs NO repo code: loads the image tarballs, pushes `ghcr.io/martin-atrin/<image>:<version>` and `:sha-<commit>`, prints the digest (information only), attaches kit/package tarballs + `.sha256` to the GitHub release.
Actions are pinned by full commit SHA and limited to the official actions/checkout, setup-node, upload-artifact and download-artifact. Woodpecker keeps every other stage and holds no secrets.

## Release signing (SEC-03, C72)
Product pipelines never see the release signing key and write nothing for the index. The platform repo's `.github/workflows/registry-sync.yml` (GitHub Actions, every 15 min + manual, main only, environment `registry` restricted to `main`, secret `RELEASE_SIGNING_KEY`) is the only job that holds the key. It runs platform code only; its one dependency, `@opt2-tealbrick/manifest`, is installed from `ops/signer/package-lock.json` (integrity-pinned, `--ignore-scripts`). Since ci-v9.2 the signer and the template's `release-record` step use the SAME manifest version and integrity (0.1.8); a unit test fails if they drift. To change it: edit `ops/signer/package.json`, `npm install --package-lock-only --ignore-scripts` in `ops/signer`, update `TB_MANIFEST_PKG`/`TB_MANIFEST_INTEGRITY` in the template, compare the integrity with `coordination/specs/RELEASES.md`, and dry-run the signer first (verify `registry/index.jws`, re-merge the index unchanged, re-sign with a throw-away key, re-validate every app manifest). It discovers new `v*` tags in the opt2 repos, reads `tealbrick-ci.json` at the tag commit and resolves each declared image's `:<version>` digest in ghcr anonymously (tags without published images stay pending; packages must be PUBLIC). For each release it:
1. checks the tag points at the commit;
2. re-reads the manifest, skill files and bridge runtime from the repo AT that commit (as data) and re-derives `manifestDigest`, `skillsDigest`, the runtime record;
3. checks the service images equal the manifest services that have `build`;
4. checks every image's OCI labels say `revision = <commit>` and `source = https://github.com/<repo>`;
5. then adds the entry and signs the index, committing with the built-in `GITHUB_TOKEN`. Any rejected candidate turns the run red with the reason.

## Dependency integrity (S3/C59, C62/BSD-10)
- Every GitHub-release tarball in a lockfile carries `integrity` IN THE LOCKFILE, so pnpm/npm verify it on every install, also inside Docker builds. npm lockfiles have it; for pnpm run `node ci/tb-ci.ts pin-tarballs ../opt2-tealbrick-<name>` after each dependency change: it writes `resolution: {integrity: sha512-…, tarball: …}` into `pnpm-lock.yaml` (pnpm keeps it and fails with ERR_PNPM_TARBALL_INTEGRITY on a mismatch). Setup downloads each tarball and fails if integrity is missing or wrong. `tealbrick-integrity.json` is retired.
- `packageManager` is hash-pinned: `"pnpm@<version>+sha512.<hex>"` (corepack verifies the pnpm download). `corepack use pnpm@9.15.4` writes it.
- Installs never run install scripts: CI uses `pnpm install --frozen-lockfile --ignore-scripts` / `npm ci --ignore-scripts`; setup fails on any Dockerfile `RUN` with `pnpm install` lacking `--frozen-lockfile` or `--ignore-scripts`, or `npm ci` lacking `--ignore-scripts`, or `npm install`.

## Package rules (enforced by setup)
- Every `package.json` (root and workspace packages) has `"private": true` and no `publishConfig` (no npm publishing in opt2).
- Dependencies on `@opt2-tealbrick/*` are either `workspace:*` (package in the same repo) or a GitHub release tarball URL, which setup checks exists:
  `"@opt2-tealbrick/manifest": "https://github.com/Martin-Atrin/opt2-tealbrick-sdk/releases/download/manifest-v0.1.0/opt2-tealbrick-manifest-0.1.0.tgz"`. A registry version string fails.
- v1 package names (`tealbrick`, `@tealbrick/*`) fail the build.
- A committed lockfile. With pnpm: `"packageManager": "pnpm@<version>"` (CI uses corepack on Node 24).
- Root scripts: `typecheck`, `lint`, `test`; plus `conformance` for miniapps and the bridge; plus `gen` (`tb-gen all`, with `gen/` git-ignored) for miniapps; plus `build` in multi-package repos (`pnpm-workspace.yaml`, packages under `packages/<name>/`, shipped compiled as `dist/`). Recommended: `tsc --noEmit`, `biome check .`, `node --test`.
- TypeScript only (Node 24 type stripping: no enums, no parameter properties, `.ts` import extensions).

## Adopt in a repo
```sh
cd <workspace>/opt2-tealbrick-platform
node ci/tb-ci.ts adopt ../opt2-tealbrick-<name> --kind <library|service|miniapp|bridge|portal|web|desktop|specs|tests>
# then edit ../opt2-tealbrick-<name>/tealbrick-ci.json (images, paths) and commit
```
`adopt` copies the template, deletes the baseline `.woodpecker/secret-scan.yaml` (the template has the step), creates `tealbrick-ci.json`, and git-ignores `.tb-ci/`.
Repo-specific extra workflows (for example a macOS job) are allowed as other files in `.woodpecker/`; they must not repeat the standard stages.

## tealbrick-ci.json
Schema: `ci/tealbrick-ci.schema.json`. Example for a miniapp:
```json
{
  "kind": "miniapp",
  "images": [{ "name": "opt2-tealbrick-knowledge", "product": "knowledge", "kind": "app", "manifest": "tealbrick.manifest.json" }]
}
```
Image names are the repo name or `<repo>-<component>` (for example `opt2-tealbrick-bridge-server`).
Optional `"postgres": true` (ci-v9.1) starts the test database step; leave it out when no test reads `TB_TEST_DATABASE_URL`.
ci-v9.2 (was a known red step in ci-v9.1): the detached `postgres` step used to be still running when the pipeline ended, and Woodpecker 3.19 marks such a step red ("no such container") on a green pipeline. Now the runner writes `.tb-ci/postgres-done` when `run test` ends (pass, fail or crash; `setup` clears a stale one), and the step, which runs Postgres in the background instead of `exec`, sees the marker, sends TERM (KILL after 10 s) and exits 0. Only the cleanup ignores an exit status (`wait ... || echo`); a database that never comes up still fails the `unit` step (`waitForTcp`). A 1 h cap stops the step if the unit step never runs. Opted-out repos still get a green "skipped" step.

Apps with companion services (BSA-01): one `kind: "app"` image plus one `kind: "service"` image per manifest `runtime.services[]` entry that has `build` (same `product` as the app, `service` = the manifest service id). Setup fails if they do not match the manifest. On `v*` tags every image is published, and the app's release entry lists `services: [{id, image@sha256}]`.
```json
{ "kind": "miniapp", "images": [
  { "name": "opt2-tealbrick-knowledge", "product": "knowledge", "kind": "app", "manifest": "tealbrick.manifest.json" },
  { "name": "opt2-tealbrick-knowledge-gbrain", "product": "knowledge", "kind": "service", "service": "gbrain", "dockerfile": "services/gbrain/Dockerfile" }
] }
```

## Package releases (multi-package repos: specs, sdk, bridge, packages)
Tag `<dir>-v<semver>` where `<dir>` is the folder name under `packages/` and `<semver>` equals that package.json `version`
(e.g. `manifest-v0.1.0`). The release workflow installs, runs the build, rewrites in-repo `workspace:` deps to their release URLs
(they must be released first), runs `npm pack`, checks the tarball with the pack guard, and attaches `<name>-<version>.tgz` + `.sha256` to the GitHub release.
Local check before tagging (same path as the Action, no token): `CI_WORKSPACE=$PWD CI_REPO_NAME=<repo> CI_COMMIT_TAG=<dir>-v<ver> CI_COMMIT_SHA=$(git rev-parse HEAD) node <platform>/ci/tb-ci.ts gh-build`, then inspect `.tb-ci/out/assets/*.tgz`.
Asset URL: `https://github.com/Martin-Atrin/<repo>/releases/download/<dir>-v<ver>/<scope-name>-<ver>.tgz` (`@opt2-tealbrick/x` -> `opt2-tealbrick-x-<ver>.tgz`).

## App releases
Tag `v<semver>` (no build metadata). Channel from the version: `1.2.3` stable, `-rc.N`/`-beta.N` beta, anything else (`-dev.N`, `-alpha.N`) dev.
Releases are immutable: the same version with another image digest is rejected. See `registry/README.md`.

## Secrets (C72)
- Woodpecker: NONE (no org, repo or global secret). `node ops/woodpecker-activate.ts` deletes any it finds.
- GitHub Actions: product repos use only the built-in `GITHUB_TOKEN` (per-job permissions). The platform repo holds `RELEASE_SIGNING_KEY` in the environment `registry` (deployments from `main` only), used by registry-sync.
- No personal token exists anywhere. Webhook tokens are never printed; rotate a leaked one per RUNBOOK §4.

## Clean-up and the shared host
kaniko builds inside the step container: no host daemon images, no host socket, no privileged step.
Woodpecker removes step containers and the workspace volume after each run. Pinned base images stay cached on the host.
Never run a global `docker/podman system prune` on the CI host (shared daemon).

## Changing the standard (platform maintainers)
1. Edit `ci/tb-ci.ts` and/or `ci/woodpecker/ci.yaml`. For a new version, bump `TB_CI_REF` in the template.
2. `pnpm stamp` (writes the runner sha256 into the template and `.woodpecker/ci.yaml`).
3. Commit, tag `ci-vN`, push the tag. Re-run `adopt` in each repo (copies the new template).
