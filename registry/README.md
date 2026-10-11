# opt2 release registry

A signed index of app releases that Portal Core reads to know what it can deploy.

- Index: `registry/index.json` on `main`. Raw URL: `https://raw.githubusercontent.com/Martin-Atrin/opt2-tealbrick-platform/main/registry/index.json`
- Signature: `registry/index.json.sig` = base64 Ed25519 signature over the exact bytes of `index.json`.
- Public key: `registry/release-key.pub.pem` (kid = first 16 hex chars of sha256 over the SPKI DER: `ccd73c250bdf847b`). Portal Core pins this key in its config; it never trusts the index without verifying the signature (`registry/verify.ts` is the reference).
- Writer: only the `release-record` CI step (tag `v*`), which signs with the Woodpecker secret `release_signing_key`. Each record is also attached to the GitHub release of the tag as `release-record-<product>.json` + `.sig`.

## Format (`opt2.release-index/v1`)
```json
{
  "schema": "opt2.release-index/v1",
  "kid": "ccd73c250bdf847b",
  "generatedAt": "2026-10-11T12:00:00.000Z",
  "releases": [{
    "schema": "opt2.release-record/v1",
    "releaseId": "knowledge@0.1.0",
    "product": "knowledge",
    "productKind": "miniapp",
    "version": "0.1.0",
    "channel": "stable",
    "repo": "Martin-Atrin/opt2-tealbrick-knowledge",
    "commit": "<git sha>",
    "tag": "v0.1.0",
    "image": "ghcr.io/martin-atrin/opt2-tealbrick-knowledge@sha256:<hex>",
    "imageDigest": "sha256:<hex>",
    "manifestDigest": "sha256:<hex>",
    "manifestUrl": "https://raw.githubusercontent.com/Martin-Atrin/opt2-tealbrick-knowledge/v0.1.0/tealbrick.manifest.json",
    "publishedAt": "2026-10-11T12:00:00.000Z"
  }]
}
```
- `productKind`: `miniapp` (deployable app), `bridge` (the workspace bridge, same index), `portal`, `service`.
- `channel`: `stable` | `beta` | `dev` (from the version, see `ci/README.md`).
- `manifestDigest`: today sha256 of the manifest file bytes. When Lead · Specs freezes the canonical manifest digest (`manifestDigest()` in the SDK), the CI runner switches to it in a new template version; Core must compare with the SDK function.
- Releases are immutable: a `releaseId` never changes its image digest. Withdrawal is a new release, not an edit.
- Deploys use `image` (pinned by digest), never a tag.

## Key handling
The private key lives only in Woodpecker (secret `release_signing_key`) and in the owner's local key store; it is never committed or printed.
Rotation: generate a new pair (`node ci/tb-ci.ts keygen <dir>`), re-sign the current index with the new key, update `release-key.pub.pem` and Core's pinned key in the same change window.
