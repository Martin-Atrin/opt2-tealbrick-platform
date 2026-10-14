import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { gzipSync } from "node:zlib";
import {
  addPnpmIntegrity,
  artifactSource,
  assetChecksums,
  belowMinimum,
  CLI_DIST_BASE,
  CLI_REPO,
  channelForVersion,
  checkDependencies,
  checkPackageJson,
  checkPackedTarball,
  checkServiceImages,
  cliEntryProblem,
  cliReleaseFromAssets,
  cliSourceReleases,
  cliTarballUrl,
  DEV_ONLY_PRODUCTS,
  DIST_BASES,
  distTag,
  dockerfileInstallProblems,
  dockerfileVolumeLines,
  expectedGenFiles,
  INDEX_KINDS,
  type IndexRelease,
  isDistTarballUrl,
  loadManifestPkg,
  loadProductBindings,
  lockfileTarballs,
  lockPinProblems,
  mergeIndex,
  missingPackTargets,
  missingPreReleaseChecks,
  newId,
  normalizeDevOnly,
  normalizeDistBase,
  OPT2_REPOS,
  PENDING_REPOS,
  PG_DONE_MARKER,
  PG_MARKER,
  PG_TEST_URL,
  packageBuildArgs,
  packageManagerPinned,
  packageReleaseCommands,
  packEntryTargets,
  parsePackageTag,
  parsePreReleaseChecks,
  preReleaseEnv,
  productBindingProblem,
  releaseChannel,
  releaseUrl,
  renderImagesScript,
  resolveDistBase,
  sha512Integrity,
  skillsArchive,
  tarballName,
  tarEntries,
  templateVersion,
  testEnv,
  validateBridgeRuntime,
  validateConfig,
  validateHarnesses,
  validateOffers,
  validateProducts,
  verifyImageProvenance,
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
  // free fixture offers: DEV_ONLY_PRODUCTS only, no Stripe price
  const free = { ...ok, products: ["sample-pay"], amount: 0, stripePrice: { test: null, live: null } };
  assert.equal(validateOffers([free]).length, 1);
  assert.throws(() => validateOffers([{ ...free, products: ["knowledge"] }]), /DEV_ONLY_PRODUCTS/);
  assert.throws(() => validateOffers([{ ...free, stripePrice: { test: "price_123", live: null } }]), /no Stripe price/);
  assert.throws(() => validateOffers([{ ...ok, amount: -1 }]), /amount/);
  // the reviewed registry input passes
  const offers = validateOffers(JSON.parse(readFileSync(new URL("../registry/offers.json", import.meta.url), "utf8")));
  assert.deepEqual(
    offers.filter((o) => o.amount === 0).map((o) => o.products[0]),
    ["sample-pay", "sample-mismatch"],
  );
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

test("images script: check builds every image, never pushes, no credentials", () => {
  assert.match(renderImagesScript(validateConfig({ kind: "library" }, repo), repo), /nothing to build/);
  const cfg = validateConfig({ kind: "miniapp", images: [{ name: repo, product: "knowledge", kind: "app", manifest: "m.json" }] }, repo);
  const s = renderImagesScript(cfg, repo);
  assert.match(s, /--no-push/);
  assert.ok(!/GHCR_TOKEN|config\.json|--destination|--tar-path/.test(s));
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

test("the committed registry/harnesses.json is valid and has a claude-code row (F75)", () => {
  const rows = validateHarnesses(JSON.parse(readFileSync(new URL("../registry/harnesses.json", import.meta.url), "utf8")));
  const cc = rows.find((r) => r.id === "claude-code");
  assert.ok(cc, "claude-code row");
  assert.equal(cc.authorise, "device_approval");
  assert.ok(cc.instructions.some((st) => st.copy?.value.includes("--harness claude-code")));
  // F77/F78 (CLI 0.1.20): connect writes the project scope .mcp.json with absolute node + tealbrick paths
  const wire = cc.instructions.find((st) => st.copy?.value.startsWith("tealbrick connect claude-code"));
  assert.ok(
    wire && /project scope/.test(wire.detail) && /\.mcp\.json/.test(wire.detail) && /full paths/.test(wire.detail),
    "row says project scope + absolute paths",
  );
});

test("GTP-01: a product is signed only from its bound repo and kind (fires on a foreign repo, quiet on its own)", () => {
  const b = validateProducts({
    bridge: { repo: "Martin-Atrin/opt2-tealbrick-bridge", kind: "bridge" },
    knowledge: { repo: `Martin-Atrin/${repo}`, kind: "app" },
  });
  // quiet on good
  assert.equal(productBindingProblem(b, { product: "bridge", kind: "bridge", repo: "Martin-Atrin/opt2-tealbrick-bridge" }), null);
  assert.equal(mergeIndex(null, [rel({})], [], "t", [], b).releases.length, 1, "knowledge from its own repo is signed");
  // fire on bad: a samples tag declaring product "bridge" (the review's attack), a kind change, an unknown product
  assert.match(
    productBindingProblem(b, { product: "bridge", kind: "bridge", repo: "Martin-Atrin/opt2-tealbrick-samples" }) ?? "",
    /bound to Martin-Atrin\/opt2-tealbrick-bridge/,
  );
  assert.match(productBindingProblem(b, { product: "knowledge", kind: "bridge", repo: `Martin-Atrin/${repo}` }) ?? "", /bound as kind app/);
  assert.match(productBindingProblem(b, { product: "newapp", kind: "app", repo: `Martin-Atrin/${repo}` }) ?? "", /not bound/);
  assert.match(productBindingProblem(b, { product: "constructor", kind: "app", repo: `Martin-Atrin/${repo}` }) ?? "", /not bound/, "no prototype keys");
  const evil = rel({ product: "bridge", kind: "bridge", version: "99.0.0", manifestDigest: null, runtime: brt, repo: "Martin-Atrin/opt2-tealbrick-samples" });
  assert.throws(() => mergeIndex(null, [evil], [], "t", [], b), /GTP-01/);
  // without the map, the index still refuses a repo change for a product that already has releases
  const i1 = mergeIndex(
    null,
    [rel({ product: "bridge", kind: "bridge", manifestDigest: null, runtime: brt, repo: "Martin-Atrin/opt2-tealbrick-bridge" })],
    [],
    "t",
  );
  assert.throws(() => mergeIndex(i1, [evil], [], "t2"), /earlier releases of bridge come from Martin-Atrin\/opt2-tealbrick-bridge/);
  assert.throws(() => validateProducts({ bridge: { repo: "evil/opt2-tealbrick-bridge", kind: "bridge" } }), /repo must be/);
  assert.throws(() => validateProducts({ bridge: { repo: "Martin-Atrin/opt2-tealbrick-bridge", kind: "lib" } }), /kind must be/);
});

test("GTP-01: the committed registry/products.json binds every product of the committed index to the repo it came from", () => {
  const b = loadProductBindings();
  const index = JSON.parse(readFileSync(new URL("../registry/index.json", import.meta.url), "utf8")) as { releases: IndexRelease[] };
  for (const r of index.releases) assert.equal(productBindingProblem(b, r), null, `${r.product}@${r.version}`);
  assert.equal(b.bridge?.repo, "Martin-Atrin/opt2-tealbrick-bridge");
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

test("ci-v9.1: point-release template refs compare as major.minor", () => {
  assert.deepEqual(templateVersion("ci-v9.1"), [9, 1]);
  assert.deepEqual(templateVersion("ci-v9"), [9, 0]);
  assert.equal(templateVersion("ci-v9.x"), null);
  assert.equal(belowMinimum("ci-v9.1", "ci-v8"), false);
  assert.equal(belowMinimum("ci-v9.1", "ci-v9"), false);
  assert.equal(belowMinimum("ci-v9", "ci-v9.1"), true);
  assert.equal(belowMinimum("ci-v9.1", "ci-v9.2"), true);
  assert.equal(belowMinimum("ci-v9.2", "ci-v9.1"), false);
  assert.equal(belowMinimum("ci-v9.2", "ci-v10"), true);
  assert.equal(belowMinimum("ci-v10", "ci-v9.1"), false);
});

test("S3: lockfile tarball integrity detection", () => {
  const url = "https://github.com/Martin-Atrin/opt2-tealbrick-sdk/releases/download/manifest-v0.1.3/opt2-tealbrick-manifest-0.1.3.tgz";
  const pnpm = `packages:\n  '@opt2-tealbrick/manifest@${url}':\n    resolution: {tarball: ${url}}\n    version: 0.1.3\n  ajv@8.17.1:\n    resolution: {integrity: sha512-abc}\n`;
  assert.deepEqual(lockfileTarballs(pnpm, "pnpm"), [{ url, integrity: null }]);
  const pnpmInt = pnpm.replace(`{tarball: ${url}}`, `{integrity: sha512-xyz, tarball: ${url}}`);
  assert.deepEqual(lockfileTarballs(pnpmInt, "pnpm"), [{ url, integrity: "sha512-xyz" }]);
  const npm = JSON.stringify({
    packages: {
      "node_modules/@opt2-tealbrick/manifest": { resolved: url, integrity: "sha512-q" },
      "node_modules/ajv": { resolved: "https://registry.npmjs.org/ajv/-/ajv-8.17.1.tgz", integrity: "sha512-r" },
    },
  });
  assert.deepEqual(lockfileTarballs(npm, "npm"), [{ url, integrity: "sha512-q" }]);
  assert.match(sha512Integrity(new TextEncoder().encode("x")), /^sha512-[A-Za-z0-9+/]+=*$/);
});

test("SEC-03: image provenance check binds image to repo + commit", async () => {
  const commit = "c".repeat(40);
  const fake = (labels: Record<string, string>): typeof fetch =>
    (async (u: string | URL | Request) => {
      const s = String(u);
      if (s.includes("/token?")) return new Response(JSON.stringify({ token: "t" }));
      if (s.includes("/manifests/")) return new Response(JSON.stringify({ config: { digest: `sha256:${"e".repeat(64)}` } }));
      if (s.includes("/blobs/")) return new Response(JSON.stringify({ config: { Labels: labels } }));
      return new Response("", { status: 404 });
    }) as typeof fetch;
  const ref = `ghcr.io/martin-atrin/${repo}-gbrain@sha256:${"a".repeat(64)}`;
  const good = { "org.opencontainers.image.revision": commit, "org.opencontainers.image.source": `https://github.com/Martin-Atrin/${repo}` };
  assert.equal(await verifyImageProvenance(ref, `Martin-Atrin/${repo}`, commit, fake(good)), null);
  assert.match(
    String(await verifyImageProvenance(ref, `Martin-Atrin/${repo}`, commit, fake({ ...good, "org.opencontainers.image.revision": "d".repeat(40) }))),
    /revision label/,
  );
  assert.match(String(await verifyImageProvenance(ref, "Martin-Atrin/opt2-tealbrick-connect", commit, fake(good))), /does not belong/);
  assert.match(String(await verifyImageProvenance("ghcr.io/evil/x@sha256:1", `Martin-Atrin/${repo}`, commit, fake(good))), /bad image ref/);
});

test("C62: pnpm lockfile integrity is written into tarball resolutions", () => {
  const url = "https://github.com/Martin-Atrin/opt2-tealbrick-sdk/releases/download/manifest-v0.1.3/opt2-tealbrick-manifest-0.1.3.tgz";
  const lock = `  '@opt2-tealbrick/manifest@${url}':\n    resolution: {tarball: ${url}}\n  ajv@8.17.1:\n    resolution: {integrity: sha512-abc}\n`;
  const { text, changed } = addPnpmIntegrity(lock, () => "sha512-XYZ=");
  assert.equal(changed, 1);
  assert.match(text, new RegExp(`resolution: \\{integrity: sha512-XYZ=, tarball: ${url.replaceAll(".", "\\.")}\\}`));
  assert.deepEqual(lockfileTarballs(text, "pnpm"), [{ url, integrity: "sha512-XYZ=" }]);
  assert.equal(addPnpmIntegrity(text, () => "x").changed, 0, "idempotent");
});

test("C62: packageManager must be hash-pinned", () => {
  assert.equal(packageManagerPinned(`pnpm@9.15.4+sha512.${"a".repeat(128)}`), true);
  assert.equal(packageManagerPinned("pnpm@9.15.4"), false);
  assert.equal(packageManagerPinned(`pnpm@9.15.4+sha256.${"a".repeat(64)}`), false);
});

test("C62: Dockerfile installs must be frozen and script-free", () => {
  assert.deepEqual(dockerfileInstallProblems("FROM node\nRUN corepack enable && pnpm install --frozen-lockfile --ignore-scripts\n"), []);
  assert.deepEqual(dockerfileInstallProblems("FROM node\nRUN npm ci --ignore-scripts --omit=dev\n"), []);
  assert.match(dockerfileInstallProblems("FROM node\nRUN pnpm install --frozen-lockfile\n").join(), /line 2: pnpm install without --ignore-scripts/);
  assert.match(dockerfileInstallProblems("FROM node\nRUN pnpm install \\\n  --ignore-scripts\n").join(), /line 2: pnpm install without --frozen-lockfile/);
  assert.match(dockerfileInstallProblems("FROM node\nRUN npm install express\n").join(), /npm install in an image build/);
  assert.match(dockerfileInstallProblems("FROM node\nRUN npm ci\n").join(), /npm ci without --ignore-scripts/);
  assert.deepEqual(dockerfileInstallProblems("FROM node\n# RUN npm install x\nRUN echo pnpm\n"), []);
});

// ---------- ci-v9.1 (C75) ----------

/** Minimal ustar writer for tests (pax `path` header for names over 100 bytes, as npm pack writes them). */
function makeTgz(files: Record<string, string>): Buffer {
  const blocks: Buffer[] = [];
  const header = (name: string, size: number, type: string): Buffer => {
    const h = Buffer.alloc(512);
    h.write(name.slice(0, 99), 0);
    h.write("0000644\0", 100);
    h.write(`${size.toString(8).padStart(11, "0")}\0`, 124);
    h.write(type, 156);
    h.write("ustar\0", 257);
    h.write("00", 263);
    h.fill(32, 148, 156);
    let sum = 0;
    for (const b of h) sum += b;
    h.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148);
    return h;
  };
  const pad = (b: Buffer): Buffer => Buffer.concat([b, Buffer.alloc((512 - (b.length % 512)) % 512)]);
  for (const [rel, text] of Object.entries(files)) {
    const name = `package/${rel}`;
    const data = Buffer.from(text);
    if (name.length > 99) {
      const rec = ` path=${name}\n`;
      let len = rec.length + 2;
      if (`${len}${rec}`.length !== len) len += 1;
      const pax = Buffer.from(`${len}${rec}`);
      blocks.push(header("PaxHeader", pax.length, "x"), pad(pax));
    }
    blocks.push(header(name, data.length, "0"), pad(data));
  }
  blocks.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(blocks));
}

const specPkg = {
  name: "@opt2-tealbrick/spec",
  version: "0.1.11",
  exports: {
    ".": { types: "./dist/index.d.ts", default: "./dist/index.js" },
    "./schemas/*": "./schemas/*",
  },
  bin: { "tb-x": "./dist/cli.js" },
};

test("C75 build step: gh-build installs (frozen, no scripts), then builds, before packing", () => {
  const cmds = packageReleaseCommands([{ dir: "/w", pm: "pnpm" }], "/w", { build: "pnpm -r run build" }, "@opt2-tealbrick/spec");
  assert.deepEqual(
    cmds.map((c) => [c.cwd, c.cmd, ...c.args].join(" ")),
    ["/w corepack pnpm install --frozen-lockfile --ignore-scripts", "/w corepack pnpm run build"],
  );
  assert.equal(cmds.at(-1)?.args.includes("build"), true, "the last command before pack is the build");
  assert.deepEqual(packageBuildArgs({ build: "tsc -b" }, "@x/y"), ["pnpm", "run", "build"]);
  assert.deepEqual(packageBuildArgs({}, "@x/y"), ["pnpm", "--filter", "@x/y...", "run", "--if-present", "build"]);
});

test("C75 pack guard: entry targets of main/exports/types/bin", () => {
  assert.deepEqual(packEntryTargets(specPkg), ["dist/cli.js", "dist/index.d.ts", "dist/index.js", "schemas/*"]);
  assert.deepEqual(packEntryTargets({ main: "./lib/a.js", types: "lib/a.d.ts", bin: "./bin/x.js", exports: ["./lib/a.js", null] }), [
    "bin/x.js",
    "lib/a.d.ts",
    "lib/a.js",
  ]);
  assert.deepEqual(missingPackTargets(specPkg, ["package.json", "dist/index.js", "dist/index.d.ts", "dist/cli.js", "schemas/a.json"]), []);
  assert.deepEqual(missingPackTargets(specPkg, ["package.json", "dist/index.js", "dist/index.d.ts", "dist/cli.js"]), ["schemas/*"]);
  assert.deepEqual(missingPackTargets({ main: "index" }, ["index.js"]), [], "extension-less main resolves like Node");
});

test("C75 pack guard: passes a built tarball, fails one without dist/", () => {
  const pj = JSON.stringify(specPkg);
  const long = `schemas/${"deep/".repeat(20)}x.json`;
  const built = makeTgz({ "package.json": pj, "dist/index.js": "", "dist/index.d.ts": "", "dist/cli.js": "", [long]: "{}" });
  assert.ok(tarEntries(built).has(long), "pax long names are read");
  assert.deepEqual(checkPackedTarball(built), []);
  const unbuilt = makeTgz({ "package.json": pj, "schemas/a.json": "{}" });
  const problems = checkPackedTarball(unbuilt);
  assert.equal(problems.length, 3);
  assert.ok(problems.every((p) => p.startsWith("@opt2-tealbrick/spec: dist/")));
  assert.deepEqual(checkPackedTarball(makeTgz({ "README.md": "" })), ["the tarball has no package.json"]);
});

test("ci-v9.1 postgres is opt-in: config, unit env and template", () => {
  assert.equal(validateConfig({ kind: "library" }, repo).postgres, false);
  assert.equal(validateConfig({ kind: "library", postgres: true }, repo).postgres, true);
  assert.throws(() => validateConfig({ kind: "library", postgres: "yes" }, repo), /postgres must be boolean/);
  const off = testEnv(validateConfig({ kind: "library" }, repo), { TB_TEST_DATABASE_URL: "x", PATH: "/bin" });
  assert.equal(off.TB_TEST_DATABASE_URL, undefined);
  assert.equal(off.PATH, "/bin");
  assert.equal(testEnv(validateConfig({ kind: "library", postgres: true }, repo), {}).TB_TEST_DATABASE_URL, PG_TEST_URL);
  const tpl = readFileSync(new URL("./woodpecker/ci.yaml", import.meta.url), "utf8");
  assert.doesNotMatch(tpl, /^services:/m, "no always-on service (it showed a red step on green pipelines)");
  assert.doesNotMatch(tpl, /TB_TEST_DATABASE_URL:/, "the runner sets the URL only when opted in");
  const step = /- name: postgres\n([\s\S]*?)\n\n/.exec(tpl)?.[1] ?? "";
  assert.doesNotMatch(step, /detach:/, "ci-v9.3: a detached step ends red on this Woodpecker");
  assert.ok(step.includes(`if [ ! -f ${PG_MARKER} ]; then`) && step.includes("exit 0"), "skips (green) unless setup wrote the marker");
  assert.ok(tpl.indexOf("- name: setup") < tpl.indexOf("- name: postgres"), "postgres starts after setup decided");
});

// ---------- ci-v9.2 ----------

/** The `commands` of one template step, as the shell script Woodpecker would run (set -e). */
function stepScript(tpl: string, name: string): string {
  const step = new RegExp(`- name: ${name}\\n([\\s\\S]*?)\\n\\n`).exec(tpl)?.[1] ?? "";
  const cmds = step.slice(step.indexOf("commands:")).split("\n").slice(1);
  return cmds.map((l) => l.replace(/^ {6}- /, "")).join("\n");
}

test("ci-v9.2: release-record and the signer pin the SAME manifest package, with integrity", () => {
  const tpl = readFileSync(new URL("./woodpecker/ci.yaml", import.meta.url), "utf8");
  const url = /TB_MANIFEST_PKG: (\S+)/.exec(tpl)?.[1] ?? "";
  const integrity = /TB_MANIFEST_INTEGRITY: (\S+)/.exec(tpl)?.[1] ?? "";
  assert.match(url, /manifest-v(\d+\.\d+\.\d+)\/opt2-tealbrick-manifest-\1\.tgz$/);
  assert.match(integrity, /^sha512-[A-Za-z0-9+/]{86}==$/);
  const version = /manifest-v(\S+?)\//.exec(url)?.[1] ?? "";
  assert.deepEqual(version.split(".").map(Number).slice(0, 2), [0, 1]);
  assert.ok(Number(version.split(".")[2]) >= 8, "wildcard companions (spec 0.1.13, M-CP-3) need manifest >= 0.1.8");
  const signerPkg = JSON.parse(readFileSync(new URL("../ops/signer/package.json", import.meta.url), "utf8")) as { dependencies: Record<string, string> };
  assert.equal(signerPkg.dependencies["@opt2-tealbrick/manifest"], url, "signer dependency == template pin");
  const lock = JSON.parse(readFileSync(new URL("../ops/signer/package-lock.json", import.meta.url), "utf8")) as {
    packages: Record<string, { version?: string; resolved?: string; integrity?: string }>;
  };
  const locked = lock.packages["node_modules/@opt2-tealbrick/manifest"];
  assert.equal(locked.version, version);
  assert.equal(locked.resolved, url);
  assert.equal(locked.integrity, integrity, "signer lockfile integrity == template integrity");
  assert.ok(lock.packages["node_modules/@opt2-tealbrick/spec"]?.integrity?.startsWith("sha512-"), "the spec dependency is integrity-pinned in the lockfile");
  const wf = readFileSync(new URL("../.github/workflows/registry-sync.yml", import.meta.url), "utf8");
  assert.match(wf, /npm ci --prefix ops\/signer --ignore-scripts/);
});

test("ci-v9.2: the template and the release workflow carry the same ref", () => {
  const tpl = readFileSync(new URL("./woodpecker/ci.yaml", import.meta.url), "utf8");
  const gh = readFileSync(new URL("./github/opt2-release.yml", import.meta.url), "utf8");
  const ref = /TB_CI_REF: (\S+)/.exec(tpl)?.[1];
  assert.equal(/TB_CI_REF: (\S+)/.exec(gh)?.[1], ref);
  assert.equal(new RegExp(`template ${ref}`).test(tpl.split("\n")[0]), true);
});

test("ci-v9.2 postgres step stops itself: marker, TERM then KILL, exit 0", async () => {
  const tpl = readFileSync(new URL("./woodpecker/ci.yaml", import.meta.url), "utf8");
  const script = stepScript(tpl, "postgres");
  assert.ok(script.includes(PG_DONE_MARKER.replace(".tb-ci/", "")), "waits for the marker the runner writes");
  assert.doesNotMatch(script, /exec docker-entrypoint/, "no exec: the shell must survive to clean up");
  assert.match(script, /kill -TERM/);
  assert.match(script, /kill -KILL/);

  const work = mkdtempSync(join(tmpdir(), "tb-pg-step-"));
  try {
    const bin = join(work, "bin");
    mkdirSync(bin);
    mkdirSync(join(work, ".tb-ci"));
    // fake postgres entrypoint (the real one is the postgres image's)
    const fake = (body: string) => {
      writeFileSync(join(bin, "docker-entrypoint.sh"), `#!/bin/sh\n${body}\n`);
      chmodSync(join(bin, "docker-entrypoint.sh"), 0o755);
    };
    const run = (markerAfterMs: number | null) =>
      new Promise<{ status: number | null; out: string }>((done) => {
        const child = spawn("sh", ["-e", "-c", script], { cwd: work, env: { PATH: `${bin}:${process.env.PATH}` } });
        let out = "";
        child.stdout.on("data", (d: Buffer) => {
          out += d.toString();
        });
        child.stderr.on("data", (d: Buffer) => {
          out += d.toString();
        });
        const guard = setTimeout(() => child.kill("SIGKILL"), 40_000);
        if (markerAfterMs !== null) setTimeout(() => writeFileSync(join(work, PG_DONE_MARKER), "done\n"), markerAfterMs);
        child.on("close", (status) => {
          clearTimeout(guard);
          done({ status, out });
        });
      });

    // 1. not requested: exits 0 at once, never starts postgres
    fake(`echo started >> "${work}/started"; sleep 30`);
    const skipped = await run(null);
    assert.equal(skipped.status, 0, skipped.out);
    assert.equal(existsSync(join(work, "started")), false);

    // 2. requested; the runner writes the marker later -> TERM -> exit 0 although the server exits 143
    writeFileSync(join(work, PG_MARKER), "x\n");
    fake(`trap 'echo term >> "${work}/signals"; exit 143' TERM\nwhile :; do sleep 0.1; done`);
    const t0 = Date.now();
    const stopped = await run(1500);
    assert.equal(stopped.status, 0, stopped.out);
    assert.ok(Date.now() - t0 >= 1400, "it kept running until the marker appeared");
    assert.match(readFileSync(join(work, "signals"), "utf8"), /term/);
    assert.match(stopped.out, /ignored, cleanup only/);

    // 3. a server that ignores TERM is killed after the grace period; still exit 0
    fake("trap '' TERM\nwhile :; do sleep 0.1; done");
    rmSync(join(work, PG_DONE_MARKER), { force: true });
    const t1 = Date.now();
    const hung = await run(500);
    assert.equal(hung.status, 0, hung.out);
    assert.ok(Date.now() - t1 >= 9000, "waited the grace period before KILL");
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

// ---------- ci-v9.3 ----------

/** Steps of the template with their depends_on, read from the YAML text (the template is flat on purpose). */
function templateGraph(tpl: string): Map<string, { deps: string[]; detach: boolean; when: string }> {
  const out = new Map<string, { deps: string[]; detach: boolean; when: string }>();
  for (const block of tpl.split(/\n {2}- name: /).slice(1)) {
    const name = /^([a-z-]+)/.exec(block)?.[1] ?? "";
    const deps = /\n {4}depends_on: \[([^\]]*)\]/.exec(block)?.[1];
    assert.notEqual(deps, undefined, `step ${name} has depends_on (DAG mode needs it on every step)`);
    out.set(name, {
      deps: (deps ?? "")
        .split(",")
        .map((d) => d.trim())
        .filter(Boolean),
      detach: /\n {4}detach:/.test(block),
      when: /\n {4}when:\n([\s\S]*)$/.exec(block)?.[1] ?? "",
    });
  }
  return out;
}

test("ci-v9.3 template: every step has depends_on, the graph is acyclic and keeps the old order", () => {
  const tpl = readFileSync(new URL("./woodpecker/ci.yaml", import.meta.url), "utf8");
  const g = templateGraph(tpl);
  assert.deepEqual(
    [...g.keys()],
    ["secret-scan", "setup", "install", "typecheck", "lint", "postgres", "unit", "conformance", "build", "gen", "pre-release", "image-check", "release-record"],
  );
  for (const [name, s] of g) {
    assert.equal(s.detach, false, `${name}: no detached steps (they end red on this Woodpecker)`);
    for (const d of s.deps) assert.ok(g.has(d), `${name} depends on unknown step ${d}`);
  }
  // acyclic: repeatedly remove steps whose dependencies are gone
  const left = new Map([...g].map(([n, s]) => [n, new Set(s.deps)]));
  for (let progressed = true; progressed && left.size > 0; ) {
    progressed = false;
    for (const [n, deps] of left) {
      if ([...deps].every((d) => !left.has(d))) {
        left.delete(n);
        progressed = true;
      }
    }
  }
  assert.equal(left.size, 0, "the step graph has a cycle");
  // Woodpecker runs stages: level = 1 + the deepest dependency; a stage ends when ALL its steps end.
  const level = (n: string): number => 1 + Math.max(0, ...(g.get(n)?.deps ?? []).map(level));
  assert.equal(level("postgres"), level("unit"), "postgres ends after unit, so it must share unit's stage (an earlier stage deadlocks)");
  // the node chain is the old sequential order
  const chain = ["secret-scan", "setup", "install", "typecheck", "lint", "unit", "conformance", "build", "gen", "pre-release"];
  for (let i = 1; i < chain.length; i++) assert.deepEqual(g.get(chain[i] as string)?.deps, [chain[i - 1]], `${chain[i]} follows ${chain[i - 1]}`);
  assert.deepEqual(g.get("secret-scan")?.deps, []);
  // postgres runs BESIDE unit (Woodpecker runs a graph in stages: a stage ends when all its steps end, so postgres, which
  // ends after unit, must be in unit's stage), never in front of it; nothing may depend on it except through that stage.
  for (const [n, s2] of g) assert.ok(!s2.deps.includes("postgres"), `${n} must not wait for the postgres step by name`);
  assert.deepEqual(g.get("postgres")?.deps, g.get("unit")?.deps, "same stage as unit");
  assert.deepEqual(g.get("postgres")?.deps, ["lint"]);
  // the last two steps end the chain on tags / other events (ci-v9.6: both wait for the pre-release gate)
  assert.deepEqual(g.get("image-check")?.deps, ["pre-release"]);
  assert.deepEqual(g.get("release-record")?.deps, ["pre-release"]);
});

test("ci-v9.3: release-record pins the spec tarball with sha512 and the lockfile check fails closed", () => {
  const tpl = readFileSync(new URL("./woodpecker/ci.yaml", import.meta.url), "utf8");
  const url = /TB_SPEC_PKG: (\S+)/.exec(tpl)?.[1] ?? "";
  const integrity = /TB_SPEC_INTEGRITY: (\S+)/.exec(tpl)?.[1] ?? "";
  assert.match(url, /opt2-tealbrick-specs\/releases\/download\/spec-v(\d+\.\d+\.\d+)\/opt2-tealbrick-spec-\1\.tgz$/);
  assert.match(integrity, /^sha512-[A-Za-z0-9+/]{86}==$/);
  // the same spec the signer's lockfile holds (and the one the pinned manifest package asks for)
  const lock = JSON.parse(readFileSync(new URL("../ops/signer/package-lock.json", import.meta.url), "utf8")) as {
    packages: Record<string, { resolved?: string; integrity?: string }>;
  };
  const spec = lock.packages["node_modules/@opt2-tealbrick/spec"];
  assert.equal(spec?.resolved, url);
  assert.equal(spec?.integrity, integrity);
  const manifest = /TB_MANIFEST_INTEGRITY: (\S+)/.exec(tpl)?.[1] ?? "";
  const ok = { packages: { "node_modules/@opt2-tealbrick/manifest": { integrity: manifest }, "node_modules/@opt2-tealbrick/spec": { integrity } } };
  assert.deepEqual(lockPinProblems(ok, { manifest, spec: integrity }), []);
  const other = `sha512-${"A".repeat(86)}==`;
  assert.equal(
    lockPinProblems({ packages: { ...ok.packages, "node_modules/@opt2-tealbrick/spec": { integrity: other } } }, { manifest, spec: integrity }).length,
    1,
  );
  assert.equal(lockPinProblems({ packages: {} }, { manifest, spec: integrity }).length, 2);
});

// ---------- ci-v9.4 ----------

test("ci-v9.4: DEV_ONLY_PRODUCTS is one list; the signer indexes them on dev only and refuses stable", () => {
  assert.deepEqual([...DEV_ONLY_PRODUCTS].sort(), ["sample-caller", "sample-gate", "sample-mismatch", "sample-pay"]);
  const src = readFileSync(new URL("./tb-ci.ts", import.meta.url), "utf8");
  for (const p of DEV_ONLY_PRODUCTS) assert.equal(src.split(`"${p}"`).length - 1, 1, `${p} is named once in tb-ci.ts (DEV_ONLY_PRODUCTS)`);
  // channel the signer derives: a plain x.y.z tag of a sample is still dev; other products keep the semver rule
  for (const p of DEV_ONLY_PRODUCTS) {
    assert.equal(releaseChannel(p, "0.1.2"), "dev");
    assert.equal(releaseChannel(p, "0.1.2-rc.1"), "dev");
  }
  assert.equal(releaseChannel("connect", "0.5.0"), "stable");
  assert.equal(releaseChannel("connect", "0.5.0-rc.1"), "dev");
  assert.equal(releaseChannel("sample-gate-pro", "1.0.0"), "stable", "exact ids only");
  // merge: a dev sample release is indexed, a stable one is refused (whatever path built it)
  const sample = (channel: "dev" | "stable") =>
    rel({ product: "sample-pay", version: "0.1.2", channel, tag: "v0.1.2", repo: "Martin-Atrin/opt2-tealbrick-samples" });
  const merged = mergeIndex(null, [sample("dev")], [], "2026-10-13T00:00:00.000Z");
  assert.deepEqual(
    merged.releases.map((r) => `${r.product}@${r.version}@${r.channel}`),
    ["sample-pay@0.1.2@dev"],
  );
  for (const p of DEV_ONLY_PRODUCTS)
    assert.throws(() => mergeIndex(merged, [rel({ product: p, channel: "stable" })], [], "2026-10-13T00:00:00.000Z"), /dev-only/);
  // other products are unaffected
  assert.equal(mergeIndex(merged, [rel({ product: "connect", version: "0.5.0" })], [], "2026-10-13T00:00:00.000Z").releases.length, 2);
});

/** The spec's own example manifest plus one outward op per new hold family (C107: outward, identity). */
function holdFamilyManifest(specDir: string): unknown {
  const ex = JSON.parse(readFileSync(join(specDir, "examples/notes.manifest.json"), "utf8")) as { operations: Record<string, unknown>[] };
  const write = ex.operations.find((o) => o.effect === "write");
  assert.ok(write, "the spec example has a write op to copy");
  const outward = (family: string) => ({
    ...write,
    id: `note_share_${family}`,
    title: `Share (${family})`,
    crud: ["update"],
    effect: "outward",
    holdFamily: family,
    idempotency: "supported",
    receipt: true,
  });
  return { ...ex, operations: [...ex.operations, outward("outward"), outward("identity")] };
}

function assertHoldFamilies(m: { validateManifest(json: unknown): { ok: boolean; errors?: unknown[] } }, specDir: string, who: string): void {
  const good = holdFamilyManifest(specDir) as { operations: Record<string, unknown>[] };
  const v = m.validateManifest(good);
  assert.equal(v.ok, true, `${who}: holdFamily outward/identity must validate: ${JSON.stringify(v.errors ?? []).slice(0, 500)}`);
  const bad = { ...good, operations: good.operations.map((o) => (o.holdFamily === "identity" ? { ...o, holdFamily: "nonsense" } : o)) };
  assert.equal(m.validateManifest(bad).ok, false, `${who}: an unknown hold family is still refused`);
}

test("ci-v9.4: release-record loads the pinned manifest 0.1.12 + spec 0.1.20 and accepts holdFamily outward/identity", { timeout: 180_000 }, async () => {
  const tpl = readFileSync(new URL("./woodpecker/ci.yaml", import.meta.url), "utf8");
  const pin = (k: string) => new RegExp(`${k}: (\\S+)`).exec(tpl)?.[1] ?? "";
  assert.match(pin("TB_MANIFEST_PKG"), /manifest-v0\.1\.12\/opt2-tealbrick-manifest-0\.1\.12\.tgz$/);
  assert.match(pin("TB_SPEC_PKG"), /spec-v0\.1\.20\/opt2-tealbrick-spec-0\.1\.20\.tgz$/);
  const keys = ["TB_MANIFEST_PKG", "TB_MANIFEST_INTEGRITY", "TB_SPEC_PKG", "TB_SPEC_INTEGRITY", "TB_MANIFEST_MODULE"] as const;
  const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  const work = mkdtempSync(join(tmpdir(), "tb-release-record-"));
  try {
    delete process.env.TB_MANIFEST_MODULE;
    for (const k of keys.slice(0, 4)) process.env[k] = pin(k);
    const m = await loadManifestPkg(work); // downloads, checks both sha512 pins, installs, reads the lockfile back
    const specDir = join(work, ".tb-ci/pkgs/node_modules/@opt2-tealbrick/spec");
    assert.equal((JSON.parse(readFileSync(join(specDir, "package.json"), "utf8")) as { version: string }).version, "0.1.20");
    assertHoldFamilies(m, specDir, "release-record");
  } finally {
    for (const k of keys) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    rmSync(work, { recursive: true, force: true });
  }
});

test("ci-v9.4: the registry-sync signer (ops/signer lockfile) validates holdFamily outward/identity", { timeout: 180_000 }, async () => {
  const work = mkdtempSync(join(tmpdir(), "tb-signer-"));
  try {
    for (const f of ["package.json", "package-lock.json"]) writeFileSync(join(work, f), readFileSync(new URL(`../ops/signer/${f}`, import.meta.url)));
    // exactly what .github/workflows/registry-sync.yml runs
    execFileSync("npm", ["ci", "--ignore-scripts", "--no-audit", "--no-fund"], { cwd: work, stdio: "pipe" });
    const nm = join(work, "node_modules/@opt2-tealbrick");
    assert.equal((JSON.parse(readFileSync(join(nm, "manifest/package.json"), "utf8")) as { version: string }).version, "0.1.12");
    assert.equal((JSON.parse(readFileSync(join(nm, "spec/package.json"), "utf8")) as { version: string }).version, "0.1.20");
    const wf = readFileSync(new URL("../.github/workflows/registry-sync.yml", import.meta.url), "utf8");
    const entry = /TB_MANIFEST_MODULE: ops\/signer\/(\S+)/.exec(wf)?.[1] ?? "";
    assert.ok(entry, "the workflow points TB_MANIFEST_MODULE into ops/signer");
    const m = (await import(pathToFileURL(join(work, entry)).href)) as { validateManifest(json: unknown): { ok: boolean; errors?: unknown[] } };
    assertHoldFamilies(m, join(nm, "spec"), "signer");
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test("C113: devOnly mark + re-classification of an old stable record; identical copies folded, nothing else changes", () => {
  const sample = (over: Partial<IndexRelease>) =>
    rel({
      product: "sample-gate",
      repo: "Martin-Atrin/opt2-tealbrick-samples",
      image: `ghcr.io/martin-atrin/opt2-tealbrick-samples-sample-gate@sha256:${"1".repeat(64)}`,
      ...over,
    });
  const oldStable = sample({ id: "rel_01M4QCJ7T3NP5WQ2WWP5V1G7KY", version: "0.1.1", channel: "stable", publishedAt: "2026-10-11T00:00:00.000Z" });
  const copyDev = sample({ id: "rel_01M4RTJ56HQH0BVWBTEBSSW7AC", version: "0.1.1", channel: "dev", publishedAt: "2026-10-12T19:48:56.000Z" });
  const devOld = sample({
    id: "rel_01M4QA48XR9QC5QRDSC4E1T6DT",
    version: "0.1.0",
    channel: "dev",
    image: null,
    source: { repo: "x/y", ref: "a".repeat(40), dockerfile: "Dockerfile" },
  });
  const other = rel({ id: "rel_01M4QA48XR9QC5QRDSC4E1T6D0", product: "connect", version: "0.5.0" });
  const { releases, notes } = normalizeDevOnly([devOld, oldStable, other, copyDev]);
  assert.deepEqual(
    releases.map((r) => [r.id, r.channel, r.devOnly ?? null]),
    [
      [devOld.id, "dev", true],
      [oldStable.id, "dev", true], // same id, re-classified
      [other.id, "stable", null], // untouched, no devOnly key
    ],
  );
  assert.equal("devOnly" in (releases[2] as object), false);
  const kept = releases[1] as IndexRelease;
  assert.equal(kept.image, oldStable.image);
  assert.equal(kept.manifestDigest, oldStable.manifestDigest);
  assert.equal(kept.publishedAt, oldStable.publishedAt);
  assert.deepEqual(notes, [
    `sample-gate@0.1.0 ${devOld.id} marked devOnly`,
    `sample-gate@0.1.1 ${oldStable.id} re-classified stable -> dev`,
    `sample-gate@0.1.1 ${copyDev.id} marked devOnly`,
    `sample-gate@0.1.1 ${copyDev.id} folded into ${oldStable.id} (identical record)`,
  ]);
  assert.deepEqual(normalizeDevOnly(releases).notes, [], "idempotent");
  // a copy with other content is never folded
  assert.throws(() => normalizeDevOnly([oldStable, { ...copyDev, image: `ghcr.io/x@sha256:${"9".repeat(64)}` }]), /different content/);
  // mergeIndex applies it: the next signed index carries the marks; a new dev sample release is marked too
  const merged = mergeIndex(
    { schema: "opt2.release-index/v2", generatedAt: "x", releases: [oldStable, copyDev, other], offers: [], harnesses: [] },
    [sample({ id: "rel_01M4RV2CZHEB2D52KCSNGSB862", version: "0.2.0-dev.1", channel: "dev" })],
    [],
    "2026-10-13T00:00:00.000Z",
  );
  assert.deepEqual(
    merged.releases.map((r) => `${r.product}@${r.version}@${r.channel}${r.devOnly ? "+devOnly" : ""}`),
    ["connect@0.5.0@stable", "sample-gate@0.1.1@dev+devOnly", "sample-gate@0.2.0-dev.1@dev+devOnly"],
  );
});

test("ci-v9.5 (F27): each release tarball gets a .sha256 and an npm-style .integrity file", () => {
  const data = new TextEncoder().encode("tarball bytes");
  const c = assetChecksums("opt2-tealbrick-spec-0.1.22.tgz", data);
  assert.match(c.sha256, /^[0-9a-f]{64}$/);
  assert.equal(c.integrity, sha512Integrity(data));
  assert.deepEqual(c.files, [
    { name: "opt2-tealbrick-spec-0.1.22.tgz.sha256", body: `${c.sha256}  opt2-tealbrick-spec-0.1.22.tgz\n` },
    { name: "opt2-tealbrick-spec-0.1.22.tgz.integrity", body: `${c.integrity}\n` },
  ]);
  // the value npm writes into package-lock.json for the same bytes
  assert.match(c.files[1]!.body.trim(), /^sha512-[A-Za-z0-9+/]{86}==$/);
});

// ---------- ci-v9.6 (C154/C157/C158): dist host + pre-release gate ----------

const distBase = DIST_BASES[0] as string;
const cliRepo = "opt2-tealbrick-cli";

test("ci-v9.6 distBaseUrl: absent = unchanged GitHub default; only platform dist hosts are accepted", () => {
  assert.equal(validateConfig({ kind: "library" }, cliRepo).distBaseUrl, null);
  assert.equal(resolveDistBase(validateConfig({ kind: "library" }, cliRepo), {}), null);
  assert.equal(validateConfig({ kind: "library", distBaseUrl: `${distBase}/` }, cliRepo).distBaseUrl, distBase, "trailing slash dropped");
  assert.equal(validateConfig({ kind: "library", distBaseUrl: "https://releases.tealbrick.com" }, cliRepo).distBaseUrl, "https://releases.tealbrick.com");
  for (const bad of [
    "https://evil.example",
    "http://releases.tealbrick.com",
    "https://releases.tealbrick.com.evil.example",
    "https://github.com/Other/opt2-tealbrick-dist/releases/download",
    "",
    5,
  ])
    assert.throws(() => validateConfig({ kind: "library", distBaseUrl: bad }, cliRepo), /distBaseUrl/, String(bad));
  // env wins over the file; an env value is held to the same list
  const cfg = validateConfig({ kind: "library", distBaseUrl: distBase }, cliRepo);
  assert.equal(resolveDistBase(cfg, { TB_DIST_BASE_URL: "https://releases.tealbrick.com" }), "https://releases.tealbrick.com");
  assert.equal(resolveDistBase(cfg, { TB_DIST_BASE_URL: "" }), distBase);
  assert.throws(() => resolveDistBase(cfg, { TB_DIST_BASE_URL: "https://evil.example" }), /TB_DIST_BASE_URL/);
  assert.throws(() => normalizeDistBase(undefined, "x"), /must be a string/);
});

test("ci-v9.6 releaseUrl: default unchanged, dist base gives <base>/<repo>-<tag>/<file>", () => {
  const github = "https://github.com/Martin-Atrin/opt2-tealbrick-cli/releases/download/relay-v0.1.0/opt2-tealbrick-relay-0.1.0.tgz";
  assert.equal(releaseUrl(cliRepo, "relay", "@opt2-tealbrick/relay", "0.1.0"), github);
  assert.equal(releaseUrl(cliRepo, "relay", "@opt2-tealbrick/relay", "0.1.0", null), github);
  const dist = releaseUrl(cliRepo, "relay", "@opt2-tealbrick/relay", "0.1.0", distBase);
  assert.equal(dist, `${distBase}/opt2-tealbrick-cli-relay-v0.1.0/opt2-tealbrick-relay-0.1.0.tgz`);
  assert.equal(distTag(cliRepo, "relay-v0.1.0"), "opt2-tealbrick-cli-relay-v0.1.0");
  assert.equal(
    releaseUrl(cliRepo, "relay", "@opt2-tealbrick/relay", "0.1.0", "https://releases.tealbrick.com/"),
    "https://releases.tealbrick.com/opt2-tealbrick-cli-relay-v0.1.0/opt2-tealbrick-relay-0.1.0.tgz",
  );
  assert.throws(() => releaseUrl(cliRepo, "relay", "@opt2-tealbrick/relay", "0.1.0", "https://evil.example"), /distBase/);
  assert.equal(isDistTarballUrl(dist), true);
  assert.equal(isDistTarballUrl(github), false);
});

test("ci-v9.6 dependency rules accept a dist URL, still refuse look-alikes (L34 both ways)", () => {
  const dist = releaseUrl(cliRepo, "relay", "@opt2-tealbrick/relay", "0.1.0", distBase);
  const rel = releaseUrl(cliRepo, "relay", "@opt2-tealbrick/relay", "0.1.0", "https://releases.tealbrick.com");
  const [errs, urls] = checkDependencies({ dependencies: { "@opt2-tealbrick/relay": dist }, devDependencies: { "@opt2-tealbrick/x": rel } }, "pkg", new Set());
  assert.deepEqual(errs, []);
  assert.deepEqual(urls, [dist, rel]);
  const bad = [
    "https://releases.tealbrick.com.evil.example/opt2-tealbrick-cli-relay-v0.1.0/opt2-tealbrick-relay-0.1.0.tgz",
    "https://releases.tealbrick.com/evil/opt2-tealbrick-cli-relay-v0.1.0/opt2-tealbrick-relay-0.1.0.tgz",
    "https://releases.tealbrick.com/opt2-tealbrick-cli-relay-v0.1.0/../x/opt2-tealbrick-relay-0.1.0.tgz",
    "https://releases.tealbrick.com/cli-relay-v0.1.0/opt2-tealbrick-relay-0.1.0.tgz",
    "https://releases.tealbrick.com/opt2-tealbrick-cli-relay-v0.1.0/opt2-tealbrick-relay-0.1.0.zip",
    "https://github.com/Other/opt2-tealbrick-dist/releases/download/opt2-tealbrick-cli-relay-v0.1.0/opt2-tealbrick-relay-0.1.0.tgz",
  ];
  for (const url of bad) assert.equal(checkDependencies({ dependencies: { "@opt2-tealbrick/relay": url } }, "p", new Set())[0].length, 1, url);
});

test("ci-v9.6 lockfile integrity covers dist tarballs (pnpm pin and npm read)", () => {
  const url = releaseUrl(cliRepo, "relay", "@opt2-tealbrick/relay", "0.1.0", distBase);
  const lock = `packages:\n  '@opt2-tealbrick/relay@${url}':\n    resolution: {tarball: ${url}}\n    version: 0.1.0\n  other@1.0.0:\n    resolution: {tarball: https://example.com/a.tgz}\n`;
  assert.deepEqual(lockfileTarballs(lock, "pnpm"), [{ url, integrity: null }]);
  const { text, changed } = addPnpmIntegrity(lock, () => "sha512-ABC=");
  assert.equal(changed, 1, "the dist tarball is pinned, the foreign host is left alone");
  assert.match(text, /resolution: \{tarball: https:\/\/example\.com\/a\.tgz\}/);
  assert.deepEqual(lockfileTarballs(text, "pnpm"), [{ url, integrity: "sha512-ABC=" }]);
  const npm = JSON.stringify({
    packages: { "node_modules/x": { resolved: url, integrity: "sha512-q" }, "node_modules/y": { resolved: "https://example.com/a.tgz" } },
  });
  assert.deepEqual(lockfileTarballs(npm, "npm"), [{ url, integrity: "sha512-q" }]);
});

test("ci-v9.6 registry-add-desktop: GitHub asset URL as before, or a dist file with --repo", () => {
  assert.deepEqual(artifactSource("https://github.com/Martin-Atrin/opt2-tealbrick-tbd/releases/download/v1.2.3/TBD-1.2.3.dmg"), {
    repo: "opt2-tealbrick-tbd",
    tag: "v1.2.3",
  });
  assert.deepEqual(artifactSource(`${distBase}/opt2-tealbrick-tbd-v1.2.3/TBD-1.2.3.dmg`, "opt2-tealbrick-tbd"), { repo: "opt2-tealbrick-tbd", tag: "v1.2.3" });
  assert.throws(() => artifactSource(`${distBase}/opt2-tealbrick-tbd-v1.2.3/TBD-1.2.3.dmg`), /--repo/);
  assert.throws(() => artifactSource(`${distBase}/opt2-tealbrick-tbd-v1.2.3/TBD-1.2.3.dmg`, "opt2-tealbrick-cli"), /must look like/);
  assert.throws(() => artifactSource(`${distBase}/opt2-tealbrick-tbd-v1.2.3/a/b.dmg`, "opt2-tealbrick-tbd"), /must look like/);
  assert.throws(() => artifactSource("https://evil.example/TBD.dmg", "opt2-tealbrick-tbd"), /GitHub release asset URL/);
  assert.throws(() => artifactSource("https://github.com/Other/opt2-tealbrick-tbd/releases/download/v1/x.dmg"), /GitHub release asset URL/);
});

test("ci-v9.6 preReleaseChecks: TypeScript, repo-relative, unique", () => {
  assert.deepEqual(validateConfig({ kind: "library" }, cliRepo).preReleaseChecks, []);
  assert.deepEqual(validateConfig({ kind: "library", preReleaseChecks: ["scripts/release-gate.ts", "scripts/b.ts"] }, cliRepo).preReleaseChecks, [
    "scripts/release-gate.ts",
    "scripts/b.ts",
  ]);
  for (const bad of [
    ["scripts/gate.js"],
    ["scripts/gate.mjs"],
    ["../gate.ts"],
    ["/etc/gate.ts"],
    ["a.ts", "a.ts"],
    [5],
    "scripts/gate.ts",
    ["a b.ts"],
    ["x; rm -rf y.ts"],
  ])
    assert.throws(() => parsePreReleaseChecks(bad), /preReleaseChecks/, JSON.stringify(bad));
  assert.throws(() => parsePreReleaseChecks(Array.from({ length: 21 }, (_v, i) => `s/${i}.ts`)), /at most 20/);
  assert.deepEqual(
    missingPreReleaseChecks(["a.ts", "b.ts"], (r) => r === "a.ts"),
    ["b.ts"],
  );
  const env = preReleaseEnv(validateConfig({ kind: "library", distBaseUrl: distBase }, cliRepo), { CI_COMMIT_TAG: "relay-v0.1.0", PATH: "/bin" });
  assert.equal(env.TB_PRE_RELEASE, "1");
  assert.equal(env.TB_RELEASE_TAG, "relay-v0.1.0");
  assert.equal(env.TB_DIST_BASE_URL, distBase);
  const plain = preReleaseEnv(validateConfig({ kind: "library" }, cliRepo), { PATH: "/bin" });
  assert.equal(plain.TB_RELEASE_TAG, "");
  assert.equal(plain.TB_DIST_BASE_URL, undefined);
});

/** Runs `tb-ci pre-release` in a throw-away repo directory (no network: the command only reads the config and runs the scripts). */
function runPreRelease(files: Record<string, string>, config: Record<string, unknown>, extraEnv: Record<string, string> = {}): { code: number; out: string } {
  const dir = mkdtempSync(join(tmpdir(), "tb-prerelease-"));
  try {
    writeFileSync(join(dir, "tealbrick-ci.json"), JSON.stringify(config));
    for (const [rel, body] of Object.entries(files)) {
      mkdirSync(join(dir, rel, ".."), { recursive: true });
      writeFileSync(join(dir, rel), body);
    }
    const env: NodeJS.ProcessEnv = { ...process.env, CI_WORKSPACE: dir, CI_REPO_NAME: cliRepo, GITHUB_TOKEN: "", GH_TOKEN: "", GHCR_TOKEN: "", ...extraEnv };
    for (const k of ["GITHUB_TOKEN", "GH_TOKEN", "GHCR_TOKEN"]) if (!extraEnv[k]) delete env[k];
    try {
      const out = execFileSync(process.execPath, [new URL("./tb-ci.ts", import.meta.url).pathname, "pre-release"], { env, encoding: "utf8", stdio: "pipe" });
      return { code: 0, out };
    } catch (e) {
      const err = e as { status?: number; stdout?: string; stderr?: string };
      return { code: err.status ?? 1, out: `${err.stdout ?? ""}${err.stderr ?? ""}` };
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("ci-v9.6 pre-release step: no-op without checks, passes a good gate, fails a bad or missing one, refuses tokens (L34)", () => {
  const none = runPreRelease({}, { kind: "library" });
  assert.equal(none.code, 0, none.out);
  assert.match(none.out, /nothing to run/);
  const good = runPreRelease(
    {
      "scripts/ok.ts": `if (process.env.TB_PRE_RELEASE !== "1" || process.env.TB_DIST_BASE_URL !== ${JSON.stringify(distBase)}) process.exit(3);\nconsole.log("gate-ok", process.env.TB_RELEASE_TAG);\n`,
    },
    { kind: "library", distBaseUrl: distBase, preReleaseChecks: ["scripts/ok.ts"] },
    { CI_COMMIT_TAG: "relay-v0.1.0" },
  );
  assert.equal(good.code, 0, good.out);
  assert.match(good.out, /gate-ok relay-v0\.1\.0/);
  assert.match(good.out, /1 check\(s\) passed/);
  const bad = runPreRelease(
    { "scripts/ok.ts": "", "scripts/bad.ts": "process.exit(7);\n", "scripts/never.ts": 'console.log("RAN-AFTER-FAILURE");\n' },
    { kind: "library", preReleaseChecks: ["scripts/ok.ts", "scripts/bad.ts", "scripts/never.ts"] },
  );
  assert.notEqual(bad.code, 0);
  assert.match(bad.out, /scripts\/bad\.ts failed/);
  assert.doesNotMatch(bad.out, /RAN-AFTER-FAILURE/, "the first failure stops the run");
  const missing = runPreRelease({}, { kind: "library", preReleaseChecks: ["scripts/nope.ts"] });
  assert.notEqual(missing.code, 0);
  assert.match(missing.out, /scripts\/nope\.ts not found/);
  const tokened = runPreRelease({ "scripts/ok.ts": "" }, { kind: "library", preReleaseChecks: ["scripts/ok.ts"] }, { GITHUB_TOKEN: "x" });
  assert.notEqual(tokened.code, 0);
  assert.match(tokened.out, /without GITHUB_TOKEN/);
});

test("ci-v9.6 template: pre-release step after gen; image-check and release-record wait for it; workflow runs the checks on the tag", () => {
  const tpl = readFileSync(new URL("./woodpecker/ci.yaml", import.meta.url), "utf8");
  assert.equal(stepScript(tpl, "pre-release"), "node .tb-ci/tb-ci.ts pre-release");
  assert.match(tpl.split("\n")[0] as string, /ci-v9\.6/);
  const wf = readFileSync(new URL("./github/opt2-release.yml", import.meta.url), "utf8");
  assert.match(wf, /TB_CI_REF: ci-v9\.6/);
  const runner = readFileSync(new URL("./tb-ci.ts", import.meta.url), "utf8");
  const build = runner.slice(runner.indexOf("async function cmdGhBuild"), runner.indexOf("async function cmdGhPublish"));
  assert.ok(build.indexOf("runPreReleaseChecks(cfg, root)") > 0, "gh-build runs the checks on the tag");
  assert.ok(
    build.indexOf("runPreReleaseChecks(cfg, root); //") < build.indexOf("await cmdPackagePack()"),
    "package tags: checks run before the tarball is packed",
  );
  assert.ok(build.indexOf("runPreReleaseChecks(cfg, root);") < build.indexOf('"docker",'), "app tags: checks run before the image build");
});

test("ci-v9.6 opt2-tealbrick-cli: in OPT2_REPOS and the activation list, pending until its GitHub repo exists; only registry product = cli (C174)", () => {
  assert.ok(OPT2_REPOS.includes(cliRepo));
  for (const r of PENDING_REPOS) assert.ok(OPT2_REPOS.includes(r), `${r} is pending but not an opt2 repo`);
  assert.deepEqual([...PENDING_REPOS], [cliRepo], "only the CLI repo is pending; any other 404 stays an alarm");
  const activate = readFileSync(new URL("../ops/woodpecker-activate.ts", import.meta.url), "utf8");
  const listed = /const REPOS = \[([\s\S]*?)\]\.map/.exec(activate)?.[1] ?? "";
  const names = [...listed.matchAll(/"([a-z-]+)"/g)].map((m) => `opt2-tealbrick-${m[1]}`);
  assert.deepEqual(names, OPT2_REPOS, "ops/woodpecker-activate.ts lists the same repos as OPT2_REPOS, in the same order");
  // the CLI ships package tarballs (kind library, no images); since C174 its ONE release-index product is `cli` (kind cli, file entry)
  const products = JSON.parse(readFileSync(new URL("../registry/products.json", import.meta.url), "utf8")) as Record<string, { repo: string; kind: string }>;
  assert.deepEqual(
    Object.entries(products).filter(([, p]) => p.repo.endsWith(`/${cliRepo}`)),
    [["cli", { repo: `Martin-Atrin/${cliRepo}`, kind: "cli" }]],
  );
  assert.ok(!Object.values(products).some((p) => p.repo.endsWith("/opt2-tealbrick-sdk")));
});

// ---------- C174: `cli` release-index kind (C173 installer + self-update) ----------

const CLI_SHA = "e".repeat(40);
const cliPkg = (over: Record<string, unknown> = {}) =>
  JSON.stringify({ name: "@opt2-tealbrick/cli", version: "0.2.0", bin: { tealbrick: "dist/main.js" }, ...over });
const cliFixture = (pkgJson = cliPkg()) => {
  const tgz = makeTgz({ "package.json": pkgJson, "dist/main.js": "#!/usr/bin/env node\n" });
  const sums = assetChecksums("opt2-tealbrick-cli-0.2.0.tgz", tgz);
  return { tgz, sha256File: sums.files[0]?.body ?? "", integrityFile: sums.files[1]?.body ?? "", sums };
};
const cliEntry = (over: Partial<IndexRelease> = {}): IndexRelease => {
  const f = cliFixture();
  const r = cliReleaseFromAssets({ version: "0.2.0", commit: CLI_SHA, ...f, publishedAt: "2026-10-14T00:00:00.000Z", id: "rel_01JA0000000000000000000009" });
  if (typeof r === "string") throw new Error(r);
  return { ...r, ...over };
};

test("C174: cli entry shape from a fixture release (dist URL, sha256 + sha512 integrity, nothing else)", () => {
  const f = cliFixture();
  const r = cliEntry();
  assert.deepEqual(INDEX_KINDS, ["app", "bridge", "desktop", "cli"]);
  assert.equal(r.kind, "cli");
  assert.equal(r.product, "cli");
  assert.equal(r.channel, "stable");
  assert.equal(r.tag, "cli-v0.2.0");
  assert.equal(r.repo, `Martin-Atrin/${CLI_REPO}`);
  assert.deepEqual(r.artifact, {
    url: "https://github.com/Martin-Atrin/opt2-tealbrick-dist/releases/download/opt2-tealbrick-cli-cli-v0.2.0/opt2-tealbrick-cli-0.2.0.tgz",
    sha256: `sha256:${f.sums.sha256}`,
    integrity: f.sums.integrity,
  });
  assert.equal(r.artifact?.url, cliTarballUrl("0.2.0", CLI_DIST_BASE));
  assert.equal(cliEntryProblem(r), null);
  assert.equal(r.image ?? r.source ?? r.runtime ?? r.manifestDigest ?? r.minOs ?? r.notarized, null);
  const dev = cliReleaseFromAssets({
    version: "0.3.0-dev.1",
    commit: CLI_SHA,
    ...cliFixture(cliPkg({ version: "0.3.0-dev.1" })),
    sha256File: "",
    integrityFile: "",
    publishedAt: "t",
  });
  assert.match(String(dev), /\.sha256 does not match/, "checksum files are required to agree");
  // the prod download host is accepted too
  assert.equal(
    cliEntryProblem({ ...r, artifact: { ...(r.artifact as { url: string; sha256: string }), url: cliTarballUrl("0.2.0", "https://releases.tealbrick.com") } }),
    null,
  );
});

test("C174: cli entries are refused for a private URL, bad digest formats, missing integrity, extra fields", () => {
  const r = cliEntry();
  const art = r.artifact as { url: string; sha256: string; integrity?: string };
  const bad = (artifact: unknown, re: RegExp, extra: Partial<IndexRelease> = {}) =>
    assert.match(cliEntryProblem({ ...r, artifact: artifact as IndexRelease["artifact"], ...extra }) ?? "OK", re);
  bad(
    { ...art, url: "https://github.com/Martin-Atrin/opt2-tealbrick-cli/releases/download/cli-v0.2.0/opt2-tealbrick-cli-0.2.0.tgz" },
    /never a private GitHub URL/,
  );
  bad({ ...art, url: "https://evil.example/opt2-tealbrick-cli-0.2.0.tgz" }, /dist host/);
  bad({ ...art, url: cliTarballUrl("0.1.9") }, /must be <dist base>\/opt2-tealbrick-cli-cli-v0\.2\.0\//);
  bad({ ...art, sha256: art.sha256.slice(7) }, /sha256:<64 hex>/);
  bad({ ...art, sha256: `sha256:${"A".repeat(64)}` }, /sha256:<64 hex>/);
  bad({ url: art.url, sha256: art.sha256 }, /integrity .* is required/);
  bad({ ...art, integrity: `sha256-${"a".repeat(43)}=` }, /sha512-/);
  bad({ ...art, integrity: "sha512-short==" }, /sha512-/);
  bad({ ...art, size: 1 }, /unknown field/);
  bad(null, /needs artifact/);
  bad(art, /only the artifact/, { image: `ghcr.io/martin-atrin/x@sha256:${"a".repeat(64)}` });
  bad(art, /desktop fields/, { notarized: true });
  // mergeIndex enforces the same rules, keeps the entry immutable, and existing kinds are unchanged
  const i1 = mergeIndex(null, [rel({}), r], [], "t1", [], loadProductBindings());
  assert.deepEqual(
    i1.releases.map((x) => `${x.product}:${x.kind}`),
    ["cli:cli", "knowledge:app"],
  );
  assert.equal(mergeIndex(i1, [{ ...r, id: "rel_other" }], [], "t2").releases.length, 2, "idempotent re-add");
  assert.throws(() => mergeIndex(i1, [{ ...r, artifact: { ...art, integrity: `sha512-${"B".repeat(86)}==` } }], [], "t"), /immutable/);
  assert.throws(() => mergeIndex(i1, [{ ...r, artifact: { ...art, url: cliTarballUrl("0.2.0", "https://releases.tealbrick.com") } }], [], "t"), /immutable/);
  assert.throws(() => mergeIndex(null, [{ ...r, artifact: { url: art.url, sha256: art.sha256 } }], [], "t"), /integrity/);
  assert.throws(() => mergeIndex(null, [{ ...r, kind: "plugin" as IndexRelease["kind"] }], [], "t"), /unknown kind/);
  assert.throws(() => mergeIndex(null, [{ ...r, repo: "Martin-Atrin/opt2-tealbrick-bridge" }], [], "t", [], loadProductBindings()), /GTP-01/);
  assert.throws(() => mergeIndex(null, [{ ...r, kind: "desktop" }], [], "t", [], loadProductBindings()), /bound as kind cli/);
});

test("C174: the signer refuses a cli tarball whose checksums or package.json do not match", () => {
  const ok = cliFixture();
  const base = { version: "0.2.0", commit: CLI_SHA, publishedAt: "t" };
  assert.equal(typeof cliReleaseFromAssets({ ...base, ...ok }), "object");
  assert.match(String(cliReleaseFromAssets({ ...base, ...ok, sha256File: `${"0".repeat(64)}  opt2-tealbrick-cli-0.2.0.tgz\n` })), /\.sha256 does not match/);
  assert.match(String(cliReleaseFromAssets({ ...base, ...ok, sha256File: `${ok.sums.sha256}  other.tgz\n` })), /\.sha256 does not match/);
  assert.match(String(cliReleaseFromAssets({ ...base, ...ok, integrityFile: `sha512-${"A".repeat(86)}==\n` })), /\.integrity does not match/);
  const wrongVer = cliFixture(cliPkg({ version: "0.1.0" }));
  assert.match(String(cliReleaseFromAssets({ ...base, ...wrongVer })), /contains @opt2-tealbrick\/cli@0\.1\.0/);
  const wrongName = cliFixture(cliPkg({ name: "@opt2-tealbrick/relay" }));
  assert.match(String(cliReleaseFromAssets({ ...base, ...wrongName })), /contains @opt2-tealbrick\/relay/);
  const noBin = cliFixture(cliPkg({ bin: { other: "x.js" } }));
  assert.match(String(cliReleaseFromAssets({ ...base, ...noBin })), /no "tealbrick" bin/);
  assert.match(String(cliReleaseFromAssets({ ...base, ...ok, tgz: Buffer.from("not gzip") })), /does not match|not a readable/);
  assert.match(String(cliReleaseFromAssets({ ...base, ...ok, commit: "abc" })), /full sha/);
});

/** A fake GitHub API for the private CLI repo: records every request (URL + whether it carried the token). */
function fakeCliGitHub(opts: { tagsStatus?: number; release?: "none" | "no-tgz" | "no-sums" | "ok"; fixture?: ReturnType<typeof cliFixture> }) {
  const f = opts.fixture ?? cliFixture();
  const calls: { url: string; auth: boolean }[] = [];
  const assets = [
    { id: 1, name: "opt2-tealbrick-cli-0.2.0.tgz", body: f.tgz },
    { id: 2, name: "opt2-tealbrick-cli-0.2.0.tgz.sha256", body: Buffer.from(f.sha256File) },
    { id: 3, name: "opt2-tealbrick-cli-0.2.0.tgz.integrity", body: Buffer.from(f.integrityFile) },
    { id: 4, name: "opt2-tealbrick-relay-0.1.0.tgz", body: Buffer.from("x") },
  ].filter((a) => (opts.release === "no-tgz" ? a.id !== 1 : opts.release === "no-sums" ? a.id !== 3 : true));
  const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const headers = (init?.headers ?? {}) as Record<string, string>;
    calls.push({ url, auth: Boolean(headers.authorization) });
    const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    const base = "https://api.github.com/repos/Martin-Atrin/opt2-tealbrick-cli";
    if (url === `${base}/tags?per_page=100`)
      return opts.tagsStatus && opts.tagsStatus !== 200
        ? json(opts.tagsStatus, { message: "Not Found" })
        : json(200, [
            { name: "cli-v0.2.0", commit: { sha: CLI_SHA } },
            { name: "relay-v0.1.0", commit: { sha: CLI_SHA } },
            { name: "harness-claude-v0.2.0", commit: { sha: CLI_SHA } },
          ]);
    if (url === `${base}/releases/tags/cli-v0.2.0`)
      return opts.release === "none" ? json(404, {}) : json(200, { assets: assets.map(({ id, name }) => ({ id, name })) });
    const m = /\/releases\/assets\/(\d+)$/.exec(url);
    const a = m ? assets.find((x) => x.id === Number(m[1])) : undefined;
    if (a && headers.accept === "application/octet-stream") return new Response(new Uint8Array(a.body), { status: 200 });
    return json(500, { unexpected: url });
  }) as typeof fetch;
  return { fetcher, calls };
}

test("C174: cli source without the read token is PENDING (green, no entry, no network)", async () => {
  const gh = fakeCliGitHub({});
  for (const token of [undefined, ""]) {
    const r = await cliSourceReleases({ token, known: new Set(), fetcher: gh.fetcher });
    assert.deepEqual(r.add, []);
    assert.deepEqual(r.rejected, []);
    assert.match(r.pending ?? "", /TB_PRIVATE_READ_TOKEN/);
  }
  assert.equal(gh.calls.length, 0);
  // token present but the repo is not visible yet (PENDING_REPOS): still pending, not an alarm
  assert.ok(PENDING_REPOS.includes(CLI_REPO));
  const hidden = await cliSourceReleases({ token: "t", known: new Set(), fetcher: fakeCliGitHub({ tagsStatus: 404 }).fetcher });
  assert.match(hidden.pending ?? "", /PENDING_REPOS/);
  assert.deepEqual(hidden.rejected, []);
  // a refused token is an alarm (registry-sync fails loudly)
  const refused = await cliSourceReleases({ token: "t", known: new Set(), fetcher: fakeCliGitHub({ tagsStatus: 401 }).fetcher });
  assert.match(refused.rejected.join(), /HTTP 401/);
});

test("C174: cli source with the token builds the entry from a fixture release; pending and broken releases", async () => {
  const gh = fakeCliGitHub({ release: "ok" });
  const known = new Set<string>();
  const r = await cliSourceReleases({ token: "tok", known, fetcher: gh.fetcher, now: () => "2026-10-14T00:00:00.000Z" });
  assert.equal(r.pending, null);
  assert.deepEqual(r.rejected, []);
  assert.equal(r.add.length, 1, "only cli-v* tags; relay/harness tags are not CLI releases");
  const e = r.add[0] as IndexRelease;
  assert.equal(cliEntryProblem(e), null);
  assert.equal(e.commit, CLI_SHA);
  assert.ok(known.has("cli@0.2.0@stable"));
  assert.ok(
    gh.calls.every((c) => c.url.startsWith("https://api.github.com/repos/Martin-Atrin/opt2-tealbrick-cli/") && c.auth),
    "token only to the CLI repo API",
  );
  assert.equal(new Set(gh.calls.filter((c) => c.url.includes("/releases/assets/")).map((c) => c.url)).size, 3, "tgz + .sha256 + .integrity downloaded");
  // known version: nothing fetched beyond the tag list
  const again = fakeCliGitHub({ release: "ok" });
  assert.equal((await cliSourceReleases({ token: "tok", known, fetcher: again.fetcher })).add.length, 0);
  assert.equal(again.calls.length, 1);
  // release not created yet, or tarball not uploaded yet: pending (no entry, no rejection)
  for (const release of ["none", "no-tgz"] as const) {
    const p = await cliSourceReleases({ token: "tok", known: new Set(), fetcher: fakeCliGitHub({ release }).fetcher });
    assert.deepEqual([p.add.length, p.rejected.length], [0, 0], release);
  }
  // tarball without its checksum assets, or a tampered tarball: rejected
  const noSums = await cliSourceReleases({ token: "tok", known: new Set(), fetcher: fakeCliGitHub({ release: "no-sums" }).fetcher });
  assert.match(noSums.rejected.join(), /\.sha256\/\.integrity/);
  const f = cliFixture();
  const tampered = { ...f, tgz: makeTgz({ "package.json": cliPkg(), "dist/main.js": "evil" }) };
  const bad = await cliSourceReleases({ token: "tok", known: new Set(), fetcher: fakeCliGitHub({ release: "ok", fixture: tampered }).fetcher });
  assert.match(bad.rejected.join(), /\.sha256 does not match/);
});

test("C174: registry-sync reads the read token from the workflow secret and never with GITHUB_TOKEN", () => {
  const wf = readFileSync(new URL("../.github/workflows/registry-sync.yml", import.meta.url), "utf8");
  assert.match(wf, /TB_PRIVATE_READ_TOKEN: \$\{\{ secrets\.TB_PRIVATE_READ_TOKEN \}\}/);
  const src = readFileSync(new URL("./tb-ci.ts", import.meta.url), "utf8");
  assert.match(src, /if \(repo === CLI_REPO\) continue;/, "the generic v* loop does not read the private repo");
  assert.equal(loadProductBindings().cli?.kind, "cli");
});
