import assert from "node:assert/strict";
import { test } from "node:test";
import {
  belowMinimum,
  channelForVersion,
  checkDependencies,
  checkPackageJson,
  checkServiceImages,
  dockerfileVolumeLines,
  expectedGenFiles,
  type IndexRelease,
  mergeIndex,
  newId,
  parsePackageTag,
  releaseUrl,
  renderImagesScript,
  serializeIndex,
  skillsArchive,
  tarballName,
  validateBridgeRuntime,
  validateConfig,
  validateHarnesses,
  validateOffers,
  versionFromTag,
  workspaceGlobs,
} from "./tb-ci.ts";

const repo = "opt2-tealbrick-knowledge";

test("channel from version", () => {
  assert.equal(channelForVersion("1.2.3"), "stable");
  assert.equal(channelForVersion("1.2.3-rc.1"), "dev");
  assert.equal(channelForVersion("1.2.3-beta.4"), "dev");
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
  const c = validateConfig({ kind: "miniapp", images: [{ name: repo, product: "knowledge", kind: "app", manifest: "tealbrick.manifest.json" }] }, repo);
  assert.equal(c.conformance, true);
  assert.deepEqual(c.paths, ["."]);
  assert.equal(c.images[0].dockerfile, "Dockerfile");
  assert.equal(validateConfig({ kind: "library" }, repo).conformance, false);
  assert.throws(() => validateConfig({ kind: "nope" }, repo), /kind/);
  assert.throws(() => validateConfig({ kind: "library", extra: 1 }, repo), /unknown field/);
  assert.throws(() => validateConfig({ kind: "library", paths: ["../x"] }, repo), /paths/);
  assert.throws(() => validateConfig({ kind: "miniapp", images: [{ name: "other-image", product: "x", kind: "app" }] }, repo), /name/);
  assert.throws(() => validateConfig({ kind: "miniapp", images: [{ name: repo, product: "knowledge", kind: "app" }] }, repo), /manifest/);
  assert.throws(() => validateConfig({ kind: "miniapp", images: [{ name: repo, product: "k", kind: "worker" }] }, repo), /app\|bridge\|portal\|service/);
});

test("package.json rules: private, no publishConfig, required scripts", () => {
  const cfg = validateConfig({ kind: "miniapp" }, repo);
  const errs = checkPackageJson({ scripts: { typecheck: "tsc", lint: "biome check", test: "node --test" }, publishConfig: {} }, cfg, "pkg");
  assert.ok(errs.some((e) => e.includes("private")));
  assert.ok(errs.some((e) => e.includes("publishConfig")));
  assert.ok(errs.some((e) => e.includes('"conformance"')));
  assert.deepEqual(checkPackageJson({ private: true, scripts: { typecheck: "a", lint: "b", test: "c", conformance: "d", gen: "tb-gen all" } }, cfg, "pkg"), []);
  assert.ok(
    checkPackageJson({ private: true, scripts: { typecheck: "a", lint: "b", test: "c", conformance: "d" } }, cfg, "pkg").some((e) => e.includes('"gen"')),
    "miniapp needs a gen script (BSA-03)",
  );
});

const rel = (over: Partial<IndexRelease>): IndexRelease => ({
  id: "rel_01JA0000000000000000000000",
  product: "knowledge",
  kind: "app",
  version: "0.1.0",
  channel: "stable",
  manifestDigest: `sha256:${"c".repeat(64)}`,
  manifestUrl: null,
  skillsDigest: null,
  image: `ghcr.io/martin-atrin/${repo}@sha256:${"a".repeat(64)}`,
  artifact: null,
  source: null,
  runtime: null,
  minOs: null,
  notarized: null,
  upgradeFrom: "*",
  repo: `Martin-Atrin/${repo}`,
  commit: "abc",
  tag: "v0.1.0",
  publishedAt: "2026-10-11T00:00:00.000Z",
  ...over,
});

test("ids are <prefix>_<ULID>", () => {
  const id = newId("rel", 1760000000000, new Uint8Array(10));
  assert.match(id, /^rel_[0-9A-HJKMNP-TV-Z]{26}$/);
  assert.ok(id.endsWith("0000000000000000"));
  assert.notEqual(newId("rel"), newId("rel"));
});

const brt = {
  port: 8080,
  internalPort: 8788,
  healthPath: "/healthz",
  readyPath: "/readyz",
  volumes: [{ mountPath: "/data", backup: true }],
  env: [{ name: "TB_KEK", source: "provider-secret" as const }],
};

test("bridge runtime validation", () => {
  assert.deepEqual(validateBridgeRuntime(brt), brt);
  assert.throws(() => validateBridgeRuntime({ ...brt, internalPort: 8080 }), /distinct/);
  assert.throws(() => validateBridgeRuntime({ ...brt, env: [{ name: "X1", source: "fixed" }] }), /value only/);
  assert.throws(() => mergeIndex(null, [rel({ product: "bridge", kind: "bridge", manifestDigest: null })], [], "t"), /runtime is required/);
  assert.throws(() => mergeIndex(null, [rel({ runtime: brt })], [], "t"), /only allowed/);
});

test("index merge: add, idempotent re-add, immutable content, desktop kind, offers carried", () => {
  const i1 = mergeIndex(null, [rel({})], [], "t1");
  assert.equal(i1.schema, "opt2.release-index/v2");
  assert.equal(mergeIndex(i1, [rel({ id: "rel_other" })], [], "t2").releases.length, 1);
  assert.throws(() => mergeIndex(i1, [rel({ image: `ghcr.io/martin-atrin/${repo}@sha256:${"b".repeat(64)}` })], [], "t"), /immutable/);
  const desk = rel({ product: "tbd", kind: "desktop", image: null, manifestDigest: null, artifact: { url: "https://x", sha256: `sha256:${"d".repeat(64)}` } });
  const i2 = mergeIndex(i1, [desk, rel({ product: "bridge", kind: "bridge", manifestDigest: null, runtime: brt })], [], "t3");
  assert.deepEqual(
    i2.releases.map((r) => r.product),
    ["bridge", "knowledge", "tbd"],
  );
  const src = { repo: "Martin-Atrin/opt2-tealbrick-bridge", ref: "f".repeat(40), dockerfile: "Dockerfile" };
  assert.throws(() => mergeIndex(null, [rel({ image: null, source: src })], [], "t"), /stable release needs an image/);
  assert.equal(mergeIndex(null, [rel({ version: "0.1.0-dev.1", channel: "dev", image: null, source: src })], [], "t").releases.length, 1);
  assert.throws(() => mergeIndex(null, [rel({ version: "0.1.0-dev.1", channel: "dev", image: null })], [], "t"), /image or source/);
  const devSrc = mergeIndex(null, [rel({ channel: "dev", image: null, source: src })], [], "t");
  assert.equal(mergeIndex(devSrc, [rel({})], [], "t2").releases.length, 2, "dev source 0.1.0 and stable image 0.1.0 coexist");
});

test("offers validation", () => {
  const ok = {
    id: "off_01JA0000000000000000000000",
    kind: "single",
    name: "Knowledge",
    products: ["knowledge"],
    major: 0,
    amount: 9900,
    currency: "usd",
    taxNote: "Tax added at checkout",
    stripePrice: { test: "price_123", live: null },
  };
  assert.equal(validateOffers([ok]).length, 1);
  assert.throws(() => validateOffers([{ ...ok, id: "knowledge-v1" }]), /off_/);
  assert.throws(() => validateOffers([{ ...ok, products: ["a", "b"] }]), /exactly one/);
  assert.throws(() => validateOffers([{ ...ok, stripePrice: { test: "sk_test_x", live: null } }]), /price_/);
  assert.throws(() => validateOffers([ok, ok]), /duplicate/);
});

test("skills archive is sorted and complete", () => {
  const a = skillsArchive(
    {
      skills: [
        { id: "b", file: "skills/b/SKILL.md" },
        { id: "a", file: "skills/a/SKILL.md" },
      ],
    },
    (f) => `content of ${f}`,
  );
  assert.deepEqual(
    a.files.map((f) => f.id),
    ["a", "b"],
  );
  assert.equal(a.files[0].content, "content of skills/a/SKILL.md");
  assert.equal(skillsArchive({}, () => "").files.length, 0);
});

test("images script: no-push on check, guarded publish", () => {
  const none = renderImagesScript(validateConfig({ kind: "library" }, repo), repo);
  assert.match(none, /nothing to build/);
  const cfg = validateConfig({ kind: "miniapp", images: [{ name: repo, product: "knowledge", kind: "app", manifest: "m.json" }] }, repo);
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

test("harnesses validation (frozen HarnessOption, C40a)", () => {
  const h = {
    id: "claude-desktop",
    kind: "desktop",
    label: "Claude Desktop",
    icon: null,
    authorise: "instruction_set",
    noAgentPath: false,
    instructions: [{ title: "Add connector", detail: "Paste the URL.", copy: { kind: "url", value: "{{mcpUrl}}" } }],
  };
  assert.equal(validateHarnesses([h]).length, 1);
  assert.throws(() => validateHarnesses([h, h]), /duplicate/);
  assert.throws(() => validateHarnesses([{ ...h, authorise: "pairing" }]), /authorise/);
  assert.throws(() => validateHarnesses([{ ...h, kind: "agentic" }]), /kind/);
  assert.throws(() => validateHarnesses([{ ...h, assets: {} }]), /exactly/);
  assert.throws(() => validateHarnesses([{ ...h, instructions: [] }]), /at least one/);
  assert.throws(() => validateHarnesses([{ ...h, instructions: [{ title: "t", detail: "use {{ownerToken}}" }] }]), /unknown placeholder/);
  assert.throws(() => validateHarnesses([{ ...h, instructions: [{ title: "t", detail: "d", copy: { kind: "html", value: "x" } }] }]), /copy/);
  assert.throws(() => validateHarnesses([{ ...h, icon: "https://evil.example/x.svg" }]), /icon/);
  assert.throws(
    () =>
      validateHarnesses([
        { ...h, noAgentPath: true },
        { ...h, id: "tbd-default", noAgentPath: true },
      ]),
    /no-agent/,
  );
  assert.deepEqual(
    mergeIndex(null, [], [], "t", validateHarnesses([h])).harnesses.map((x) => x.id),
    ["claude-desktop"],
  );
});

test("C42: VOLUME instruction detection", () => {
  assert.deepEqual(dockerfileVolumeLines('FROM node\nVOLUME ["/data"]\nCMD x'), [2]);
  assert.deepEqual(dockerfileVolumeLines("FROM node\n  volume /data\n"), [2]);
  assert.deepEqual(dockerfileVolumeLines("FROM node\n# VOLUME /data\nRUN mkdir -p /data && \\\n  echo VOLUME\nENV TB_DATA_DIR=/data"), []);
  assert.deepEqual(dockerfileVolumeLines("FROM node\nRUN echo a \\\n VOLUME /x\n"), [], "continuation lines are not instructions");
  assert.deepEqual(dockerfileVolumeLines("FROM node\nENV VOLUME_DIR=/data\n"), []);
});

test("BSA-01: service images belong to an app and match the manifest services", () => {
  const app = { name: repo, product: "knowledge", kind: "app", manifest: "tealbrick.manifest.json" };
  const svc = (id: string) => ({ name: `${repo}-${id}`, product: "knowledge", kind: "service", service: id, dockerfile: `services/${id}/Dockerfile` });
  const cfg = validateConfig({ kind: "miniapp", images: [app, svc("gbrain"), svc("gbrain-db")] }, repo);
  assert.equal(cfg.images.filter((i) => i.kind === "service").length, 2);
  assert.throws(() => validateConfig({ kind: "miniapp", images: [svc("gbrain")] }, repo), /parent/);
  assert.throws(() => validateConfig({ kind: "miniapp", images: [app, { ...svc("x"), service: undefined }] }, repo), /needs service/);
  assert.throws(() => validateConfig({ kind: "miniapp", images: [app, svc("x"), { ...svc("x"), name: `${repo}-x2` }] }, repo), /twice/);
  assert.throws(() => validateConfig({ kind: "miniapp", images: [{ ...app, service: "x" }] }, repo), /only allowed/);
  const services = [
    { id: "gbrain", build: {} },
    { id: "gbrain-db", build: {} },
    { id: "upstream", image: "x@sha256:1" },
  ];
  assert.deepEqual(checkServiceImages(cfg, "knowledge", services), []);
  assert.match(checkServiceImages(cfg, "knowledge", [...services, { id: "notebook", build: {} }]).join(), /notebook has build but no images/);
  assert.match(checkServiceImages(cfg, "knowledge", [{ id: "gbrain", build: {} }]).join(), /gbrain-db is not a manifest service/);
});

test("BSA-03: expected generated files", () => {
  assert.deepEqual(expectedGenFiles("connect"), ["openapi/openapi.json", "kit/connect-kit/package.json", "docs/connect.md", "railway/railway.json"]);
});

test("D1: minimum template ref", () => {
  assert.equal(belowMinimum("ci-v5", "ci-v6"), true);
  assert.equal(belowMinimum("ci-v6", "ci-v6"), false);
  assert.equal(belowMinimum("ci-v10", "ci-v6"), false);
  assert.equal(belowMinimum("none", "ci-v6"), true);
  assert.equal(belowMinimum("main", "ci-v6"), true);
  assert.throws(() => belowMinimum("ci-v6", "v6"), /bad minimum/);
});
