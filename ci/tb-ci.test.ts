import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { test } from "node:test";
import {
  addToIndex,
  channelForVersion,
  checkDependencies,
  checkPackageJson,
  keyId,
  parsePackageTag,
  type ReleaseRecord,
  releaseUrl,
  renderImagesScript,
  serializeIndex,
  signBytes,
  tarballName,
  validateConfig,
  verifyBytes,
  versionFromTag,
  workspaceGlobs,
} from "./tb-ci.ts";

const repo = "opt2-tealbrick-knowledge";

test("channel from version", () => {
  assert.equal(channelForVersion("1.2.3"), "stable");
  assert.equal(channelForVersion("1.2.3-rc.1"), "beta");
  assert.equal(channelForVersion("1.2.3-beta.4"), "beta");
  assert.equal(channelForVersion("1.2.3-dev.7"), "dev");
  assert.equal(channelForVersion("1.2.3-alpha.1"), "dev");
});

test("version from tag rejects non-semver and build metadata", () => {
  assert.equal(versionFromTag("v0.1.0-dev.3"), "0.1.0-dev.3");
  assert.throws(() => versionFromTag("0.1.0"));
  assert.throws(() => versionFromTag("v1.0"));
  assert.throws(() => versionFromTag("v1.0.0+build.1"));
});

test("config defaults and validation", () => {
  const c = validateConfig(
    { kind: "miniapp", images: [{ name: repo, product: "knowledge", productKind: "miniapp", manifest: "tealbrick.manifest.json" }] },
    repo,
  );
  assert.equal(c.conformance, true);
  assert.deepEqual(c.paths, ["."]);
  assert.equal(c.images[0].dockerfile, "Dockerfile");
  assert.equal(validateConfig({ kind: "library" }, repo).conformance, false);
  assert.throws(() => validateConfig({ kind: "nope" }, repo), /kind/);
  assert.throws(() => validateConfig({ kind: "library", extra: 1 }, repo), /unknown field/);
  assert.throws(() => validateConfig({ kind: "library", paths: ["../x"] }, repo), /paths/);
  assert.throws(() => validateConfig({ kind: "miniapp", images: [{ name: "other-image", product: "x", productKind: "service" }] }, repo), /name/);
  assert.throws(() => validateConfig({ kind: "miniapp", images: [{ name: repo, product: "knowledge", productKind: "miniapp" }] }, repo), /manifest/);
});

test("package.json rules: private, no publishConfig, required scripts", () => {
  const cfg = validateConfig({ kind: "miniapp" }, repo);
  const errs = checkPackageJson({ scripts: { typecheck: "tsc", lint: "biome check", test: "node --test" }, publishConfig: {} }, cfg, "pkg");
  assert.ok(errs.some((e) => e.includes("private")));
  assert.ok(errs.some((e) => e.includes("publishConfig")));
  assert.ok(errs.some((e) => e.includes('"conformance"')));
  assert.deepEqual(checkPackageJson({ private: true, scripts: { typecheck: "a", lint: "b", test: "c", conformance: "d" } }, cfg, "pkg"), []);
});

test("sign/verify roundtrip and tamper detection", () => {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const pub = publicKey.export({ type: "spki", format: "pem" }).toString();
  const priv = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const data = new TextEncoder().encode("index");
  const sig = signBytes(priv, data);
  assert.ok(verifyBytes(pub, data, sig));
  assert.ok(!verifyBytes(pub, new TextEncoder().encode("index2"), sig));
  assert.match(keyId(pub), /^[0-9a-f]{16}$/);
});

const rec = (over: Partial<ReleaseRecord>): ReleaseRecord => ({
  schema: "opt2.release-record/v1",
  releaseId: "knowledge@0.1.0",
  product: "knowledge",
  productKind: "miniapp",
  version: "0.1.0",
  channel: "stable",
  repo: `Martin-Atrin/${repo}`,
  commit: "abc",
  tag: "v0.1.0",
  image: `ghcr.io/martin-atrin/${repo}@sha256:${"a".repeat(64)}`,
  imageDigest: `sha256:${"a".repeat(64)}`,
  manifestDigest: null,
  manifestUrl: null,
  publishedAt: "2026-10-11T00:00:00.000Z",
  ...over,
});

test("index: add, idempotent re-add, immutable digest", () => {
  const i1 = addToIndex(null, [rec({})], "k", "t1");
  assert.equal(i1.releases.length, 1);
  const i2 = addToIndex(i1, [rec({})], "k", "t2");
  assert.equal(i2.releases.length, 1);
  assert.throws(() => addToIndex(i1, [rec({ imageDigest: `sha256:${"b".repeat(64)}` })], "k", "t"), /immutable/);
  const i3 = addToIndex(i2, [rec({ releaseId: "bridge@0.1.0", product: "bridge", productKind: "bridge" })], "k", "t3");
  assert.deepEqual(
    i3.releases.map((r) => r.product),
    ["bridge", "knowledge"],
  );
  assert.ok(serializeIndex(i3).endsWith("\n"));
});

test("images script: no-push on check, guarded publish", () => {
  const none = renderImagesScript(validateConfig({ kind: "library" }, repo), repo);
  assert.match(none, /nothing to build/);
  const cfg = validateConfig({ kind: "miniapp", images: [{ name: repo, product: "knowledge", productKind: "miniapp", manifest: "m.json" }] }, repo);
  const s = renderImagesScript(cfg, repo);
  assert.match(s, /--no-push/);
  assert.match(s, /ghcr_token is missing/);
  assert.match(s, new RegExp(`ghcr.io/martin-atrin/${repo}:\\$version`));
  assert.ok(!s.includes('echo "$GHCR_TOKEN'), "token must never be echoed");
});

test("dependency rules: v1 names rejected, @opt2-tealbrick only via workspace or release URL", () => {
  const url = "https://github.com/Martin-Atrin/opt2-tealbrick-sdk/releases/download/manifest-v0.1.0/opt2-tealbrick-manifest-0.1.0.tgz";
  const [errs, urls] = checkDependencies(
    {
      dependencies: { "@opt2-tealbrick/manifest": url, "@opt2-tealbrick/spec": "0.1.0", tealbrick: "1.0.0", zod: "^4" },
      devDependencies: { "@tealbrick/contract": "1", "@opt2-tealbrick/miniapp-sdk": "workspace:*", "@opt2-tealbrick/other": "workspace:*" },
    },
    "pkg",
    new Set(["@opt2-tealbrick/miniapp-sdk"]),
  );
  assert.deepEqual(urls, [url]);
  assert.equal(errs.length, 4, errs.join("\n"));
  assert.ok(errs.some((e) => e.includes("@opt2-tealbrick/spec") && e.includes("release tarball URL")));
  assert.ok(errs.some((e) => e.includes("dependencies.tealbrick")));
  assert.ok(errs.some((e) => e.includes("@tealbrick/contract")));
  assert.ok(errs.some((e) => e.includes("@opt2-tealbrick/other") && e.includes("workspace")));
  assert.equal(checkDependencies({ dependencies: { "@opt2-tealbrick/x": "https://evil.example/x.tgz" } }, "p", new Set())[0].length, 1);
});

test("workspace globs and package tags", () => {
  assert.deepEqual(workspaceGlobs("packages:\n  - 'packages/*'\n  - tools\nother: 1\n"), ["packages/*", "tools"]);
  assert.throws(() => workspaceGlobs("packages:\n  - 'packages/**'\n"), /unsupported/);
  assert.deepEqual(parsePackageTag("manifest-v0.1.0"), { dir: "manifest", version: "0.1.0" });
  assert.deepEqual(parsePackageTag("create-tealbrick-miniapp-v1.2.3-rc.1"), { dir: "create-tealbrick-miniapp", version: "1.2.3-rc.1" });
  assert.throws(() => parsePackageTag("v0.1.0"));
  assert.equal(tarballName("@opt2-tealbrick/manifest", "0.1.0"), "opt2-tealbrick-manifest-0.1.0.tgz");
  assert.equal(tarballName("create-tealbrick-miniapp", "0.1.0"), "create-tealbrick-miniapp-0.1.0.tgz");
  assert.equal(
    releaseUrl("opt2-tealbrick-sdk", "manifest", "@opt2-tealbrick/manifest", "0.1.0"),
    "https://github.com/Martin-Atrin/opt2-tealbrick-sdk/releases/download/manifest-v0.1.0/opt2-tealbrick-manifest-0.1.0.tgz",
  );
});
