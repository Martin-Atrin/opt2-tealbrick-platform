import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { gzipSync } from "node:zlib";
import {
  addPnpmIntegrity,
  belowMinimum,
  channelForVersion,
  checkDependencies,
  checkPackageJson,
  checkPackedTarball,
  checkServiceImages,
  dockerfileInstallProblems,
  dockerfileVolumeLines,
  expectedGenFiles,
  type IndexRelease,
  lockfileTarballs,
  mergeIndex,
  missingPackTargets,
  newId,
  PG_MARKER,
  PG_TEST_URL,
  packageBuildArgs,
  packageManagerPinned,
  packageReleaseCommands,
  packEntryTargets,
  parsePackageTag,
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
  assert.match(step, /detach: true/);
  assert.ok(step.includes(`if [ ! -f ${PG_MARKER} ]; then`) && step.includes("exit 0"), "skips (green) unless setup wrote the marker");
  assert.ok(tpl.indexOf("- name: setup") < tpl.indexOf("- name: postgres"), "postgres starts after setup decided");
});
