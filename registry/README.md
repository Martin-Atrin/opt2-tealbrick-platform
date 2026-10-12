# opt2 release registry

The release index tells Portal Core what it can deploy (apps, the bridge) and what it sells (offers), and it is TBD's update feed (desktop entries, C24).

## Files and URLs
| What | Repo path | Public URL |
|---|---|---|
| Index body | `registry/index.json` | `https://github.com/Martin-Atrin/opt2-tealbrick-platform/releases/download/registry/index.json` (also raw on `main`) |
| Signed envelope | `registry/index.jws` | `https://github.com/Martin-Atrin/opt2-tealbrick-platform/releases/download/registry/index.jws` |
| Offers (reviewed input) | `registry/offers.json` | change by PR only; the next publish carries them |
| Harness options (reviewed input, C40) | `registry/harnesses.json` | change by PR only; the next publish carries them |
| Public signing key | `registry/keys.json` (JWKS, Ed25519) | `https://github.com/Martin-Atrin/opt2-tealbrick-platform/releases/download/registry/keys.json` (re-uploaded with every publish; D12/C30) and raw on `main`; Core pins it in config (`RELEASE_INDEX_PUBLIC_JWKS`) |

Caching: raw.githubusercontent.com serves `main` with up to ~5 min CDN lag, and release-asset downloads can also lag briefly after a publish. Core should poll the release-asset URLs and accept that a new release can take up to ~5 min to appear (the signature check makes a stale copy harmless, never wrong). Supersession: releases are never edited or withdrawn in place; Core deploys the newest version on the workspace's channel (a later version supersedes an earlier one by semver).

## Trust rule
Core (and TBD) accept the index only if `index.jws` verifies with the pinned key and `claims.indexDigest == digest(index.json body)`.
All crypto and canonical JSON come from `@opt2-tealbrick/manifest` (`verifyJws`, `digest`), never a local copy (CORE §3).
- Signed by `signReleaseIndex(body, {iat}, key)`; JWS compact, `alg EdDSA`, `kid` = RFC 7638 thumbprint, `typ tb-release-index+jws` (spec 0.1.2 `TYP.releaseIndex`).
- Claims: `{iss: "tb:releases", aud: "tb:portal", iat, exp (iat + 180 d), schema: "opt2.release-index/v2", indexDigest, releases, offers}` (counts).
- The JWS signs a digest, not the body, so the envelope stays far below `MAX_JWS_BYTES` however many releases exist.
- The envelope expires after 180 days; `registry-sign` re-signs (monthly). An expired envelope = no new releases accepted; existing Core rows stay.

**Signed since 2026-10-11 ~20:20 Bangkok (C30).** Core verifies with `verifyReleaseIndex(jws, body, { now, keys: keySetFrom(jwks, "tb:releases") })` from `@opt2-tealbrick/manifest` ≥ 0.1.0 and rejects an unsigned index. Every publish self-verifies before it commits. Unsigned mode (`TB_REGISTRY_UNSIGNED=1`) is retired.

## Body (`opt2.release-index/v2`)
```json
{
  "schema": "opt2.release-index/v2",
  "generatedAt": "2026-10-11T12:00:00.000Z",
  "releases": [{
    "id": "rel_01M4...", "product": "knowledge", "kind": "app", "version": "0.1.0", "channel": "stable",
    "manifestDigest": "sha256:<hex of JCS(manifest)>", "manifestUrl": "https://github.com/.../releases/download/v0.1.0/tealbrick.manifest.json",
    "skillsDigest": "sha256:<digest of the skills archive>",
    "image": "ghcr.io/martin-atrin/opt2-tealbrick-knowledge@sha256:<hex>", "artifact": null, "source": null,
    "minOs": null, "notarized": null, "upgradeFrom": "*",
    "repo": "Martin-Atrin/opt2-tealbrick-knowledge", "commit": "<sha>", "tag": "v0.1.0", "publishedAt": "..."
  }],
  "harnesses": [{ "id": "claude-desktop", "kind": "desktop", "label": "Claude Desktop", "icon": null, "authorise": "instruction_set", "noAgentPath": false,
                  "instructions": [{ "title": "Add a custom connector", "detail": "...", "copy": { "kind": "url", "value": "{{mcpUrl}}" } }] }],
  "offers": [{
    "id": "off_01M4...", "kind": "single", "name": "Knowledge", "products": ["knowledge"], "major": 0,
    "amount": 9900, "currency": "usd", "taxNote": "...", "stripePrice": { "test": "price_...", "live": null }
  }]
}
```
- `kind`: `app` | `bridge` | `desktop` (PORTAL-API `Release`). `channel`: `stable` (plain semver) | `dev` (any prerelease).
- Apps with companion services (manifest `runtime.services[]`): one release covers the app and all its services. With `source`, Core builds the app from `source.dockerfile` and every service from its manifest `services[].build.dockerfile`, all at the SAME `source.ref` (images bake the manifest). With `image`, CI publishes one image per service and the app entry carries `services: [{id, image}]` (each `ghcr.io/martin-atrin/<repo>-<service>@sha256:…`); Core deploys those instead of building. `services` is `null` on source records, bridge and desktop entries.
- Exactly one of `image` (pinned by digest), `source` (C29 interim, dev only: `{repo, ref: <commit sha>, dockerfile}`), `artifact` (desktop: `{url, sha256}` of the notarized download, plus `minOs`, `notarized`).
- `runtime` (kind `bridge` only; `null` elsewhere, apps use their manifest `runtime`): `{port (public), internalPort (private network), healthPath (liveness), readyPath (ready after enrolment), volumes: [{mountPath, backup}], env: [{name, source: portal | provider-secret | public-url | fixed, value? (fixed only)}]}`. Core's deploy recipe: `provider-secret` = Railway `${{secret(43, "<base64url alphabet>")}}` (ops/KEYS.md), `portal` = values Core issues (Portal URL, one-time K6 code), `public-url` = the service's public domain, `backup: true` = `volumeInstanceBackupScheduleUpdate(kinds: [DAILY, WEEKLY])` (C28/S7). CI bridge releases read it from `bridge-runtime.json` next to the bridge Dockerfile; source records from `registry/inputs/`.
- A stable release always has `image`. Releases are immutable: `(product, version, channel)` never changes content (a dev source build and the later stable image of the same version are two releases).
- `harnesses` (C40, C40a, C43): harness options as DATA. Each entry = the frozen PORTAL-API `HarnessOption` (types/routes.ts) `{id, kind: desktop | agentic_system | other, label, icon (opt2 GitHub URL or null), authorise: device_approval | instruction_set | url, noAgentPath}` PLUS `instructions`: an InstructionSet-shaped step template `[{title, detail, copy?: {kind: command | json | url | text, value}}]`. Allowed placeholders (anything else fails validation): `{{mcpUrl}}`, `{{agentId}}` (Core fills them when it serves `agents.instructions`), `{{pairingCode}}` (the GUI fills it from `agents.pairing_code`). Array order = display order. Core syncs the rows into its Agent Registry; `harness.options` returns the HarnessOption fields, `agents.instructions` renders the template into `InstructionSet.steps`. Source: `registry/harnesses.json`, imported from the Bridge lead's connection assets (`opt2-tealbrick-bridge/packages/cli/assets/harnesses.json`, last import @af4fd5d; the `sort` field becomes array order); change by PR. Covered by `indexDigest`.
- Offers: $99 per app per major, no bundles (C29). `stripePrice.test` is used in opt2 (Stripe TEST); `live` stays null until cutover. Core verifies each price against Stripe at sync (active, one-time, amount, currency, tax behaviour, livemode).

## Writers (only these)
- CI `release-record` step on `v*` tags (app/bridge images; needs `ghcr_token`, `release_signing_key`).
- `node ci/tb-ci.ts registry-add-source --product <id> --kind app|bridge --repo opt2-tealbrick-<x> --ref <sha> --dockerfile <path> --version <semver> [--manifest tealbrick.manifest.json | --runtime registry/inputs/bridge-runtime-<v>.json]` (C29 interim; always channel dev).
- `node ci/tb-ci.ts registry-add-desktop --product tbd --version <semver> --url <GitHub release asset> --sha256 <hex> [--min-os 14.0]` (TBD release Mac; downloads and checks the sha256 first).
- `node ci/tb-ci.ts registry-sign` (offers changed / re-sign).
Local runs need `GITHUB_TOKEN` in the environment (e.g. `GITHUB_TOKEN="$(gh auth token)"`, never echoed), `RELEASE_SIGNING_KEY_FILE`, and the manifest package (`TB_MANIFEST_PKG` release URL, or `TB_MANIFEST_MODULE` path to a built package).

## Key handling
Private key: Woodpecker secret `release_signing_key` and the owner's local key store (`~/.config/opt2-tealbrick/release-key.pem`, 0600). Never committed or printed.
Rotation: add the new public key to `keys.json`, re-sign with the new key, then remove the old key in a later change (Core accepts any key in its pinned JWKS).
