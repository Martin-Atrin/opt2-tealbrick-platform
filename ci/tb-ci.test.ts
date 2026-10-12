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
  assetChecksums,
  belowMinimum,
  channelForVersion,
  checkDependencies,
  checkPackageJson,
  checkPackedTarball,
  checkServiceImages,
  DEV_ONLY_PRODUCTS,
  dockerfileInstallProblems,
  dockerfileVolumeLines,
  expectedGenFiles,
  type IndexRelease,
  loadManifestPkg,
  lockfileTarballs,
  lockPinProblems,
  mergeIndex,
  missingPackTargets,
  newId,
  normalizeDevOnly,
  PG_DONE_MARKER,
  PG_MARKER,
  PG_TEST_URL,
  packageBuildArgs,
  packageManagerPinned,
  packageReleaseCommands,
  packEntryTargets,
  parsePackageTag,
  releaseChannel,
  releaseUrl,
  renderImagesScript,
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
    ["secret-scan", "setup", "install", "typecheck", "lint", "postgres", "unit", "conformance", "build", "gen", "image-check", "release-record"],
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
  const chain = ["secret-scan", "setup", "install", "typecheck", "lint", "unit", "conformance", "build", "gen"];
  for (let i = 1; i < chain.length; i++) assert.deepEqual(g.get(chain[i] as string)?.deps, [chain[i - 1]], `${chain[i]} follows ${chain[i - 1]}`);
  assert.deepEqual(g.get("secret-scan")?.deps, []);
  // postgres runs BESIDE unit (Woodpecker runs a graph in stages: a stage ends when all its steps end, so postgres, which
  // ends after unit, must be in unit's stage), never in front of it; nothing may depend on it except through that stage.
  for (const [n, s2] of g) assert.ok(!s2.deps.includes("postgres"), `${n} must not wait for the postgres step by name`);
  assert.deepEqual(g.get("postgres")?.deps, g.get("unit")?.deps, "same stage as unit");
  assert.deepEqual(g.get("postgres")?.deps, ["lint"]);
  // the last two steps end the chain on tags / other events
  assert.deepEqual(g.get("image-check")?.deps, ["gen"]);
  assert.deepEqual(g.get("release-record")?.deps, ["gen"]);
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
