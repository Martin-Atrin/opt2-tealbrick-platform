# opt2 CI standard (template ci-v8)

One Woodpecker pipeline for every opt2 repo. It is an enforced standard, not a convention:
every repo's `.woodpecker/ci.yaml` is a byte-identical copy of `ci/woodpecker/ci.yaml`, and the
`setup` step fails when the copy drifts, when `tealbrick-ci.json` is invalid, or when package rules are broken.

## Enforcement (C56 D1)
- `ci/MIN_TEMPLATE` on platform `main` holds the minimum template ref (now `ci-v7`). From ci-v6 on, `setup` fails when the repo's template is below it, so raising the file forces every repo to re-adopt.
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
| image-build | tag `v*`: kaniko builds each image to `.tb-ci/images/<name>.tar` with OCI labels (source, revision, version). No credentials (C62) | build fails |
| push-prepare | tag `v*`: hash-checked runner (copied to /tmp) writes `.tb-ci/push.sh` | runner hash mismatch |
| image-push | tag `v*`: crane pushes the tarballs to `ghcr.io/martin-atrin/<name>:<version>` + `:sha-<commit>`; the only step with `ghcr_token` for images; token via stdin | push fails, `ghcr_token` missing, a tarball not named after this repo |
| release-record | tag `v*`: hash-checked runner validates the manifest/services/runtime and prints the release. No token, no signing key; the manifest package is loaded only if it matches `TB_MANIFEST_INTEGRITY` (C62) | invalid manifest, version mismatch, any token in the environment |
| kit-build / kit-upload | tag `v*`, miniapp: `tb-gen kit --build` WITHOUT a token, then the hash-checked runner uploads `<product>-kit-<ver>.tgz` + `.sha256` (BSA-03, C62) | kit build fails, `ghcr_token` missing |
| package-pack / package-upload | tag `<package>-v<semver>`: `npm pack --ignore-scripts` WITHOUT a token, then the hash-checked runner uploads the tarball + `.sha256` | version mismatch, an in-repo dependency not released yet |

Paths without `package.json` skip the node stages with a warning (fresh scaffolds stay green).

## Release signing (SEC-03, C59)
Product pipelines never see the release signing key and no longer write anything for the index. The platform repo's `registry-sync` pipeline (Woodpecker cron, every 15 min, plus manual) is the only CI job that holds `release_signing_key` (a platform-repo secret, events cron/manual). It runs platform code only; its one dependency, `@opt2-tealbrick/manifest`, is installed from `ops/signer/package-lock.json` (integrity-pinned, `--ignore-scripts`). It discovers new `v*` tags in the opt2 repos, reads `tealbrick-ci.json` at the tag commit and resolves each declared image's `:<version>` digest in ghcr (tags without published images stay pending). For each release it:
1. checks the tag points at the candidate's commit;
2. re-reads the manifest, skill files and bridge runtime from the repo AT that commit (as data) and re-derives `manifestDigest`, `skillsDigest`, the runtime record;
3. checks the service images equal the manifest services that have `build`;
4. checks every image digest exists in ghcr and its OCI labels say `revision = <commit>` and `source = https://github.com/<repo>`;
5. then adds the entry and signs the index. Any rejected candidate turns the pipeline red with the reason.

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
cd /Users/puma/work/active/tealbrick-opt2/opt2-tealbrick-platform
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

Apps with companion services (BSA-01): one `kind: "app"` image plus one `kind: "service"` image per manifest `runtime.services[]` entry that has `build` (same `product` as the app, `service` = the manifest service id). Setup fails if they do not match the manifest. On `v*` tags every image is published, and the app's release entry lists `services: [{id, image@sha256}]`.
```json
{ "kind": "miniapp", "images": [
  { "name": "opt2-tealbrick-knowledge", "product": "knowledge", "kind": "app", "manifest": "tealbrick.manifest.json" },
  { "name": "opt2-tealbrick-knowledge-gbrain", "product": "knowledge", "kind": "service", "service": "gbrain", "dockerfile": "services/gbrain/Dockerfile" }
] }
```

## Package releases (multi-package repos: specs, sdk, bridge, packages)
Tag `<dir>-v<semver>` where `<dir>` is the folder name under `packages/` and `<semver>` equals that package.json `version`
(e.g. `manifest-v0.1.0`). CI runs the full pipeline (incl. `build`), rewrites in-repo `workspace:` deps to their release URLs
(they must be released first), runs `npm pack`, and attaches `<name>-<version>.tgz` + `.sha256` to the GitHub release.
Asset URL: `https://github.com/Martin-Atrin/<repo>/releases/download/<dir>-v<ver>/<scope-name>-<ver>.tgz` (`@opt2-tealbrick/x` -> `opt2-tealbrick-x-<ver>.tgz`).

## App releases
Tag `v<semver>` (no build metadata). Channel from the version: `1.2.3` stable, `-rc.N`/`-beta.N` beta, anything else (`-dev.N`, `-alpha.N`) dev.
Releases are immutable: the same version with another image digest is rejected. See `registry/README.md`.

## Woodpecker secrets (C67: per repo, per event; no org-level or global secrets)
| Secret | Repos | Events | Used by |
|---|---|---|---|
| `ghcr_token` | releasing repos only: specs, sdk, bridge, packages, portal-core, portal-gui, knowledge, connect, samples | `tag` | image-push (crane), kit-upload, package-upload |
| `ghcr_token` | opt2-tealbrick-platform | `cron`, `manual` | registry-sync (commit the signed index) |
| `release_signing_key` | opt2-tealbrick-platform only | `cron`, `manual` | registry-sync (SEC-03) |
No secret is available to `push` or `pull_request` pipelines anywhere. website, tbd and qa hold no secrets (website deploys via `ops/railway-deploy.ts`; TBD releases are signed on the release Mac). `node ops/woodpecker-activate.ts` enforces this table: it deletes org-level secrets and any repo secret not in the table, and sets values from 0600 files without printing them. Webhook tokens are never printed; rotate a leaked one per RUNBOOK §4.
Known effect until Martin's ghcr token exists: tag pipelines of releasing repos and manual/cron runs of the platform signer error with `secret "ghcr_token" not found`.

## Clean-up and the shared host
kaniko builds inside the step container: no host daemon images, no host socket, no privileged step.
Woodpecker removes step containers and the workspace volume after each run. Pinned base images stay cached on the host.
Never run a global `docker/podman system prune` on the CI host (shared daemon).

## Changing the standard (platform maintainers)
1. Edit `ci/tb-ci.ts` and/or `ci/woodpecker/ci.yaml`. For a new version, bump `TB_CI_REF` in the template.
2. `pnpm stamp` (writes the runner sha256 into the template and `.woodpecker/ci.yaml`).
3. Commit, tag `ci-vN`, push the tag. Re-run `adopt` in each repo (copies the new template).
