// opt2 CI runner (one file, no dependencies, Node 24+ runs it directly).
// Fetched by every repo's .woodpecker/ci.yaml at a pinned tag + sha256.
// Commands:
//   setup                       template drift + config + package rules
//   install                     install dependencies per project path (frozen lockfile)
//   run <script>                run a standard script per project path (typecheck|lint|test|conformance|build)
//   plan-images                 write .tb-ci/images.sh for the kaniko steps
//   release-record              (tag v*) signed release record -> GitHub release assets + registry
//   adopt <repoDir> --kind <k>  (local) install the standard into a repo
//   stamp                       (platform maintainers) write the runner sha256 into the template
//   keygen <outDir>             (platform maintainers) create an Ed25519 release key pair (private key never printed)

import { execFileSync } from "node:child_process";
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const OWNER = "Martin-Atrin";
export const REGISTRY_HOST = "ghcr.io";
export const IMAGE_NAMESPACE = "ghcr.io/martin-atrin";
export const PLATFORM_REPO = "opt2-tealbrick-platform";
export const INDEX_PATH = "registry/index.json";
export const INDEX_SIG_PATH = "registry/index.json.sig";
export const INDEX_SCHEMA = "opt2.release-index/v1";
export const RECORD_SCHEMA = "opt2.release-record/v1";

export const KINDS = ["library", "service", "miniapp", "bridge", "portal", "web", "desktop", "specs", "tests"] as const;
export type Kind = (typeof KINDS)[number];

export interface ImageSpec {
  name: string; // ghcr image name, must start with the repo name
  context: string; // build context, relative to repo root
  dockerfile: string; // relative to repo root
  product: string; // registry product id (manifest id for miniapps)
  productKind: "miniapp" | "bridge" | "portal" | "service";
  manifest?: string; // path to the app manifest (miniapps), relative to repo root
}

export interface CiConfig {
  kind: Kind;
  paths: string[];
  conformance: boolean;
  images: ImageSpec[];
}

export type Channel = "stable" | "beta" | "dev";

export interface ReleaseRecord {
  schema: typeof RECORD_SCHEMA;
  releaseId: string; // <product>@<version>
  product: string;
  productKind: ImageSpec["productKind"];
  version: string;
  channel: Channel;
  repo: string; // owner/name
  commit: string;
  tag: string;
  image: string; // ghcr.io/martin-atrin/<name>@sha256:...
  imageDigest: string;
  manifestDigest: string | null; // sha256:<hex> of the manifest file bytes (SDK canonical digest replaces this when frozen)
  manifestUrl: string | null;
  publishedAt: string;
}

export interface ReleaseIndex {
  schema: typeof INDEX_SCHEMA;
  kid: string;
  generatedAt: string;
  releases: ReleaseRecord[];
}

const REQUIRED_SCRIPTS = ["typecheck", "lint", "test"] as const;

function fail(msg: string): never {
  console.error(`tb-ci: FAIL: ${msg}`);
  process.exit(1);
}

function log(msg: string): void {
  console.log(`tb-ci: ${msg}`);
}

// ---------- pure helpers (unit tested) ----------

export function channelForVersion(version: string): Channel {
  const pre = version.split("-").slice(1).join("-");
  if (!pre) return "stable";
  if (/^(rc|beta)(\.|$)/.test(pre)) return "beta";
  return "dev";
}

export function versionFromTag(tag: string): string {
  const m = /^v(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/.exec(tag);
  if (!m) throw new Error(`tag ${JSON.stringify(tag)} is not v<semver> without build metadata`);
  return m[1];
}

export function validateConfig(raw: unknown, repoName: string): CiConfig {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new Error("tealbrick-ci.json must be an object");
  const o = raw as Record<string, unknown>;
  const allowed = new Set(["$schema", "kind", "paths", "conformance", "images"]);
  for (const k of Object.keys(o)) if (!allowed.has(k)) throw new Error(`unknown field ${k}`);
  if (!KINDS.includes(o.kind as Kind)) throw new Error(`kind must be one of ${KINDS.join(", ")}`);
  const kind = o.kind as Kind;
  const paths = o.paths === undefined ? ["."] : o.paths;
  if (!Array.isArray(paths) || paths.length === 0 || !paths.every((p) => typeof p === "string" && safeRel(p)))
    throw new Error("paths must be a non-empty list of relative paths");
  const conformance = o.conformance === undefined ? kind === "miniapp" || kind === "bridge" : o.conformance;
  if (typeof conformance !== "boolean") throw new Error("conformance must be boolean");
  const imagesRaw = o.images === undefined ? [] : o.images;
  if (!Array.isArray(imagesRaw)) throw new Error("images must be a list");
  const names = new Set<string>();
  const images = imagesRaw.map((im, i): ImageSpec => {
    if (typeof im !== "object" || im === null) throw new Error(`images[${i}] must be an object`);
    const r = im as Record<string, unknown>;
    const name = r.name;
    if (typeof name !== "string" || !(name === repoName || name.startsWith(`${repoName}-`)) || !/^[a-z0-9][a-z0-9-]*$/.test(name))
      throw new Error(`images[${i}].name must be ${repoName} or ${repoName}-<component> (lowercase)`);
    if (names.has(name)) throw new Error(`duplicate image ${name}`);
    names.add(name);
    const context = r.context ?? ".";
    const dockerfile = r.dockerfile ?? "Dockerfile";
    if (typeof context !== "string" || !safeRel(context)) throw new Error(`images[${i}].context must be a relative path`);
    if (typeof dockerfile !== "string" || !safeRel(dockerfile)) throw new Error(`images[${i}].dockerfile must be a relative path`);
    const product = r.product;
    if (typeof product !== "string" || !/^[a-z0-9][a-z0-9-]*$/.test(product)) throw new Error(`images[${i}].product required (lowercase id)`);
    const productKind = r.productKind;
    if (!["miniapp", "bridge", "portal", "service"].includes(productKind as string))
      throw new Error(`images[${i}].productKind must be miniapp|bridge|portal|service`);
    const manifest = r.manifest;
    if (manifest !== undefined && (typeof manifest !== "string" || !safeRel(manifest))) throw new Error(`images[${i}].manifest must be a relative path`);
    if (productKind === "miniapp" && manifest === undefined) throw new Error(`images[${i}]: a miniapp image needs manifest`);
    return { name, context, dockerfile, product, productKind: productKind as ImageSpec["productKind"], ...(manifest ? { manifest } : {}) };
  });
  return { kind, paths, conformance, images };
}

function safeRel(p: string): boolean {
  return p.length > 0 && !p.startsWith("/") && !p.split("/").includes("..");
}

export function requiredScripts(cfg: CiConfig): string[] {
  return [...REQUIRED_SCRIPTS, ...(cfg.conformance ? ["conformance"] : [])];
}

export function checkPackageJson(pkg: Record<string, unknown>, cfg: CiConfig, where: string): string[] {
  const errors: string[] = [];
  if (pkg.private !== true) errors.push(`${where}: "private": true is required (no npm publishing in opt2; use git dependencies)`);
  if (pkg.publishConfig !== undefined) errors.push(`${where}: publishConfig is not allowed`);
  const scripts = (pkg.scripts ?? {}) as Record<string, unknown>;
  for (const s of requiredScripts(cfg)) if (typeof scripts[s] !== "string") errors.push(`${where}: script "${s}" is required`);
  return errors;
}

export function keyId(publicKeyPem: string): string {
  const der = createPublicKey(publicKeyPem).export({ type: "spki", format: "der" });
  return createHash("sha256").update(der).digest("hex").slice(0, 16);
}

export function signBytes(privateKeyPem: string, data: Uint8Array): string {
  return sign(null, data, createPrivateKey(privateKeyPem)).toString("base64");
}

export function verifyBytes(publicKeyPem: string, data: Uint8Array, sigB64: string): boolean {
  return verify(null, data, createPublicKey(publicKeyPem), Buffer.from(sigB64, "base64"));
}

export function serializeIndex(index: ReleaseIndex): string {
  return `${JSON.stringify(index, null, 2)}\n`;
}

export function addToIndex(prev: ReleaseIndex | null, records: ReleaseRecord[], kid: string, now: string): ReleaseIndex {
  const byId = new Map<string, ReleaseRecord>();
  for (const r of prev?.releases ?? []) byId.set(r.releaseId, r);
  for (const r of records) {
    const old = byId.get(r.releaseId);
    if (old && old.imageDigest !== r.imageDigest) throw new Error(`${r.releaseId} already released with another image digest (releases are immutable)`);
    byId.set(r.releaseId, r);
  }
  const releases = [...byId.values()].sort((a, b) =>
    a.product === b.product ? a.publishedAt.localeCompare(b.publishedAt) : a.product.localeCompare(b.product),
  );
  return { schema: INDEX_SCHEMA, kid, generatedAt: now, releases };
}

export function renderImagesScript(cfg: CiConfig, repoName: string): string {
  const lines = [
    "#!/bin/sh",
    "# generated by tb-ci plan-images; runs in the kaniko debug image (busybox sh)",
    "set -eu",
    'mode="${1:?usage: images.sh check|publish}"',
    'mkdir -p "$CI_WORKSPACE/.tb-ci/digests"',
  ];
  if (cfg.images.length === 0) {
    lines.push('echo "tb-ci: no images declared in tealbrick-ci.json; nothing to build"', "exit 0");
    return `${lines.join("\n")}\n`;
  }
  lines.push(
    'if [ "$mode" = publish ]; then',
    '  [ -n "${GHCR_TOKEN:-}" ] || { echo "tb-ci: FAIL: Woodpecker secret ghcr_token is missing"; exit 1; }',
    '  [ -n "${CI_COMMIT_TAG:-}" ] || { echo "tb-ci: FAIL: publish runs on tag events only"; exit 1; }',
    "  mkdir -p /kaniko/.docker",
    `  auth="$(printf '%s:%s' '${OWNER}' "$GHCR_TOKEN" | base64 | tr -d '\\n')"`,
    `  printf '{"auths":{"${REGISTRY_HOST}":{"auth":"%s"}}}\\n' "$auth" > /kaniko/.docker/config.json`,
    "  unset auth GHCR_TOKEN",
    '  version="${CI_COMMIT_TAG#v}"',
    "fi",
  );
  for (const im of cfg.images) {
    const ctx = `"$CI_WORKSPACE/${im.context}"`;
    const df = `"$CI_WORKSPACE/${im.dockerfile}"`;
    const ref = `${IMAGE_NAMESPACE}/${im.name}`;
    lines.push(
      `echo "tb-ci: image ${im.name} ($mode)"`,
      'if [ "$mode" = publish ]; then',
      `  /kaniko/executor --context ${ctx} --dockerfile ${df} \\`,
      `    --destination "${ref}:$version" --destination "${ref}:sha-$CI_COMMIT_SHA" \\`,
      `    --label "org.opencontainers.image.source=https://github.com/${OWNER}/${repoName}" \\`,
      `    --label "org.opencontainers.image.revision=$CI_COMMIT_SHA" --label "org.opencontainers.image.version=$version" \\`,
      `    --digest-file "$CI_WORKSPACE/.tb-ci/digests/${im.name}.digest" --cleanup --verbosity info`,
      `  echo "tb-ci: pushed ${ref}@$(cat "$CI_WORKSPACE/.tb-ci/digests/${im.name}.digest")"`,
      "else",
      `  /kaniko/executor --no-push --context ${ctx} --dockerfile ${df} --cleanup --verbosity info`,
      "fi",
    );
  }
  return `${lines.join("\n")}\n`;
}

// ---------- environment helpers ----------

function repoRoot(): string {
  return process.env.CI_WORKSPACE ?? process.cwd();
}

function repoName(root: string): string {
  const fromCi = process.env.CI_REPO_NAME;
  if (fromCi) return fromCi;
  try {
    const url = execFileSync("git", ["-C", root, "remote", "get-url", "origin"], { encoding: "utf8" }).trim();
    const m = /\/([^/]+?)(\.git)?$/.exec(url);
    if (m) return m[1];
  } catch {
    /* fall through */
  }
  return root.split("/").pop() ?? "repo";
}

function loadConfig(root: string): CiConfig {
  const p = join(root, "tealbrick-ci.json");
  if (!existsSync(p)) fail("tealbrick-ci.json is missing (run: node ci/tb-ci.ts adopt <repo> --kind <kind> from the platform repo)");
  try {
    return validateConfig(JSON.parse(readFileSync(p, "utf8")), repoName(root));
  } catch (e) {
    fail(`tealbrick-ci.json: ${(e as Error).message}`);
  }
}

function readJson(p: string): Record<string, unknown> {
  return JSON.parse(readFileSync(p, "utf8")) as Record<string, unknown>;
}

function packageManager(dir: string): "pnpm" | "npm" | null {
  if (existsSync(join(dir, "pnpm-lock.yaml"))) return "pnpm";
  if (existsSync(join(dir, "package-lock.json"))) return "npm";
  return null;
}

function sh(cmd: string, args: string[], cwd: string, env: NodeJS.ProcessEnv = process.env): void {
  log(`$ (${cwd}) ${cmd} ${args.join(" ")}`);
  execFileSync(cmd, args, { cwd, stdio: "inherit", env: { ...env, COREPACK_ENABLE_DOWNLOAD_PROMPT: "0" } });
}

async function fetchText(url: string): Promise<string> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`GET ${url}: HTTP ${res.status}`);
  return res.text();
}

// ---------- commands ----------

async function cmdSetup(): Promise<void> {
  const root = repoRoot();
  const ref = process.env.TB_CI_REF;
  if (!ref) fail("TB_CI_REF is not set (the pipeline must come from the template)");
  const local = readFileSync(join(root, ".woodpecker/ci.yaml"), "utf8");
  const upstream = await fetchText(`https://raw.githubusercontent.com/${OWNER}/${PLATFORM_REPO}/${ref}/ci/woodpecker/ci.yaml`);
  if (local !== upstream) fail(`.woodpecker/ci.yaml differs from the platform template ${ref}; re-run adopt, do not edit it by hand`);
  log(`template ${ref}: identical`);
  if (existsSync(join(root, ".woodpecker/secret-scan.yaml"))) fail(".woodpecker/secret-scan.yaml duplicates the template's secret-scan step; delete it");
  const cfg = loadConfig(root);
  log(`kind=${cfg.kind} paths=${cfg.paths.join(",")} conformance=${cfg.conformance} images=${cfg.images.map((i) => i.name).join(",") || "-"}`);
  const errors: string[] = [];
  for (const p of cfg.paths) {
    const pj = join(root, p, "package.json");
    if (!existsSync(pj)) {
      log(`WARNING: ${p}/package.json does not exist yet; node stages skip this path`);
      continue;
    }
    const pkg = readJson(pj);
    errors.push(...checkPackageJson(pkg, cfg, `${p}/package.json`));
    const pm = packageManager(join(root, p));
    if (!pm) errors.push(`${p}: a committed lockfile (pnpm-lock.yaml or package-lock.json) is required`);
    if (pm === "pnpm" && typeof pkg.packageManager !== "string")
      errors.push(`${p}/package.json: "packageManager": "pnpm@<version>" is required with pnpm-lock.yaml`);
  }
  for (const im of cfg.images) {
    if (!existsSync(join(root, im.dockerfile))) errors.push(`image ${im.name}: ${im.dockerfile} not found`);
    if (im.manifest && !existsSync(join(root, im.manifest))) errors.push(`image ${im.name}: manifest ${im.manifest} not found`);
  }
  if (errors.length) fail(`\n  - ${errors.join("\n  - ")}`);
  log("setup OK");
}

function nodePaths(cfg: CiConfig, root: string): string[] {
  return cfg.paths.filter((p) => existsSync(join(root, p, "package.json")));
}

function cmdInstall(): void {
  const root = repoRoot();
  const cfg = loadConfig(root);
  const paths = nodePaths(cfg, root);
  if (paths.length === 0) {
    log("SKIP install: no package.json yet");
    return;
  }
  for (const p of paths) {
    const dir = join(root, p);
    const pm = packageManager(dir);
    if (pm === "pnpm") sh("corepack", ["pnpm", "install", "--frozen-lockfile"], dir);
    else if (pm === "npm") sh("npm", ["ci"], dir);
    else fail(`${p}: no lockfile`);
  }
}

function cmdRun(script: string | undefined): void {
  if (!script || !["typecheck", "lint", "test", "conformance", "build"].includes(script)) fail("usage: run typecheck|lint|test|conformance|build");
  const root = repoRoot();
  const cfg = loadConfig(root);
  if (script === "conformance" && !cfg.conformance) {
    log("SKIP conformance: not required for this repo (tealbrick-ci.json conformance=false)");
    return;
  }
  const paths = nodePaths(cfg, root);
  if (paths.length === 0) {
    log(`SKIP ${script}: no package.json yet`);
    return;
  }
  for (const p of paths) {
    const dir = join(root, p);
    const scripts = (readJson(join(dir, "package.json")).scripts ?? {}) as Record<string, string>;
    if (!scripts[script]) {
      if (script === "build") {
        log(`SKIP build in ${p}: no build script`);
        continue;
      }
      fail(`${p}: script "${script}" is missing`);
    }
    if (packageManager(dir) === "pnpm") sh("corepack", ["pnpm", "run", script], dir);
    else sh("npm", ["run", script], dir);
  }
}

function cmdPlanImages(): void {
  const root = repoRoot();
  const cfg = loadConfig(root);
  mkdirSync(join(root, ".tb-ci"), { recursive: true });
  writeFileSync(join(root, ".tb-ci/images.sh"), renderImagesScript(cfg, repoName(root)), { mode: 0o755 });
  log(`wrote .tb-ci/images.sh for ${cfg.images.length} image(s)`);
}

async function gh(
  method: string,
  path: string,
  body?: unknown,
  extra: { host?: string; contentType?: string; raw?: string } = {},
): Promise<{ status: number; json: any }> {
  const token = process.env.GITHUB_TOKEN;
  if (!token) fail("GITHUB_TOKEN (Woodpecker secret ghcr_token) is missing");
  const res = await fetch(`https://${extra.host ?? "api.github.com"}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      accept: "application/vnd.github+json",
      "x-github-api-version": "2022-11-28",
      ...(body !== undefined || extra.raw ? { "content-type": extra.contentType ?? "application/json" } : {}),
    },
    body: extra.raw ?? (body !== undefined ? JSON.stringify(body) : undefined),
  });
  const text = await res.text();
  let json: any = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = text;
  }
  return { status: res.status, json };
}

async function ensureRelease(repo: string, tag: string, prerelease: boolean): Promise<number> {
  const got = await gh("GET", `/repos/${OWNER}/${repo}/releases/tags/${tag}`);
  if (got.status === 200) return got.json.id as number;
  const made = await gh("POST", `/repos/${OWNER}/${repo}/releases`, { tag_name: tag, name: tag, prerelease });
  if (made.status !== 201) fail(`create release ${tag}: HTTP ${made.status}`);
  return made.json.id as number;
}

async function uploadAsset(repo: string, releaseId: number, name: string, data: string): Promise<void> {
  const list = await gh("GET", `/repos/${OWNER}/${repo}/releases/${releaseId}/assets?per_page=100`);
  for (const a of (list.json ?? []) as Array<{ id: number; name: string }>) {
    if (a.name === name) await gh("DELETE", `/repos/${OWNER}/${repo}/releases/assets/${a.id}`);
  }
  const up = await gh("POST", `/repos/${OWNER}/${repo}/releases/${releaseId}/assets?name=${encodeURIComponent(name)}`, undefined, {
    host: "uploads.github.com",
    contentType: "application/json",
    raw: data,
  });
  if (up.status !== 201) fail(`upload asset ${name}: HTTP ${up.status}`);
}

async function updateRegistry(records: ReleaseRecord[], keyPem: string): Promise<void> {
  const pub = createPublicKey(keyPem).export({ type: "spki", format: "pem" }).toString();
  const kid = keyId(pub);
  for (let attempt = 1; attempt <= 5; attempt++) {
    const ref = await gh("GET", `/repos/${OWNER}/${PLATFORM_REPO}/git/ref/heads/main`);
    if (ref.status !== 200) fail(`registry: read main: HTTP ${ref.status}`);
    const headSha = ref.json.object.sha as string;
    const cur = await gh("GET", `/repos/${OWNER}/${PLATFORM_REPO}/contents/${INDEX_PATH}?ref=${headSha}`);
    let prev: ReleaseIndex | null = null;
    if (cur.status === 200) {
      const prevText = Buffer.from(cur.json.content as string, "base64").toString("utf8");
      const sigRes = await gh("GET", `/repos/${OWNER}/${PLATFORM_REPO}/contents/${INDEX_SIG_PATH}?ref=${headSha}`);
      const prevSig =
        sigRes.status === 200
          ? Buffer.from(sigRes.json.content as string, "base64")
              .toString("utf8")
              .trim()
          : "";
      if (!verifyBytes(pub, new TextEncoder().encode(prevText), prevSig))
        fail("registry: current index signature does not verify with the release key; refusing to extend it");
      prev = JSON.parse(prevText) as ReleaseIndex;
    }
    const next = serializeIndex(addToIndex(prev, records, kid, new Date().toISOString()));
    const sig = `${signBytes(keyPem, new TextEncoder().encode(next))}\n`;
    const commit = await gh("GET", `/repos/${OWNER}/${PLATFORM_REPO}/git/commits/${headSha}`);
    const tree = await gh("POST", `/repos/${OWNER}/${PLATFORM_REPO}/git/trees`, {
      base_tree: commit.json.tree.sha,
      tree: [
        { path: INDEX_PATH, mode: "100644", type: "blob", content: next },
        { path: INDEX_SIG_PATH, mode: "100644", type: "blob", content: sig },
      ],
    });
    if (tree.status !== 201) fail(`registry: create tree: HTTP ${tree.status}`);
    const msg = `registry: ${records.map((r) => r.releaseId).join(", ")}`;
    const nc = await gh("POST", `/repos/${OWNER}/${PLATFORM_REPO}/git/commits`, { message: msg, tree: tree.json.sha, parents: [headSha] });
    if (nc.status !== 201) fail(`registry: create commit: HTTP ${nc.status}`);
    const upd = await gh("PATCH", `/repos/${OWNER}/${PLATFORM_REPO}/git/refs/heads/main`, { sha: nc.json.sha, force: false });
    if (upd.status === 200) {
      log(`registry updated: ${msg}`);
      return;
    }
    log(`registry: main moved (HTTP ${upd.status}), retry ${attempt}/5`);
    await new Promise((r) => setTimeout(r, 1000 * attempt));
  }
  fail("registry: could not fast-forward main after 5 attempts");
}

async function cmdReleaseRecord(): Promise<void> {
  const root = repoRoot();
  const cfg = loadConfig(root);
  const repo = repoName(root);
  const tag = process.env.CI_COMMIT_TAG;
  const commit = process.env.CI_COMMIT_SHA;
  if (!tag || !commit) fail("release-record runs on tag events only (CI_COMMIT_TAG, CI_COMMIT_SHA)");
  const version = (() => {
    try {
      return versionFromTag(tag);
    } catch (e) {
      fail((e as Error).message);
    }
  })();
  if (cfg.images.length === 0) {
    log("no images declared: no release record (libraries are consumed as git tags)");
    return;
  }
  const keyPem = process.env.RELEASE_SIGNING_KEY;
  if (!keyPem) fail("Woodpecker secret release_signing_key is missing");
  const channel = channelForVersion(version);
  const now = new Date().toISOString();
  const records: ReleaseRecord[] = cfg.images.map((im) => {
    const dfile = join(root, ".tb-ci/digests", `${im.name}.digest`);
    if (!existsSync(dfile)) fail(`digest for ${im.name} missing (image-publish must run first)`);
    const imageDigest = readFileSync(dfile, "utf8").trim();
    if (!/^sha256:[0-9a-f]{64}$/.test(imageDigest)) fail(`bad digest for ${im.name}`);
    const manifestDigest = im.manifest
      ? `sha256:${createHash("sha256")
          .update(readFileSync(join(root, im.manifest)))
          .digest("hex")}`
      : null;
    return {
      schema: RECORD_SCHEMA,
      releaseId: `${im.product}@${version}`,
      product: im.product,
      productKind: im.productKind,
      version,
      channel,
      repo: `${OWNER}/${repo}`,
      commit,
      tag,
      image: `${IMAGE_NAMESPACE}/${im.name}@${imageDigest}`,
      imageDigest,
      manifestDigest,
      manifestUrl: im.manifest ? `https://raw.githubusercontent.com/${OWNER}/${repo}/${tag}/${im.manifest}` : null,
      publishedAt: now,
    };
  });
  const releaseId = await ensureRelease(repo, tag, channel !== "stable");
  for (const r of records) {
    const body = `${JSON.stringify(r, null, 2)}\n`;
    await uploadAsset(repo, releaseId, `release-record-${r.product}.json`, body);
    await uploadAsset(repo, releaseId, `release-record-${r.product}.json.sig`, `${signBytes(keyPem, new TextEncoder().encode(body))}\n`);
    log(`release record ${r.releaseId} (${r.channel}) ${r.image}`);
  }
  await updateRegistry(records, keyPem);
}

function cmdAdopt(args: string[]): void {
  const dir = args[0];
  const kindIdx = args.indexOf("--kind");
  const kind = kindIdx >= 0 ? args[kindIdx + 1] : undefined;
  if (!dir || !kind || !KINDS.includes(kind as Kind)) fail(`usage: adopt <repoDir> --kind ${KINDS.join("|")}`);
  const here = dirname(fileURLToPath(import.meta.url));
  const target = resolve(dir);
  mkdirSync(join(target, ".woodpecker"), { recursive: true });
  writeFileSync(join(target, ".woodpecker/ci.yaml"), readFileSync(join(here, "woodpecker/ci.yaml")));
  rmSync(join(target, ".woodpecker/secret-scan.yaml"), { force: true });
  const cfgPath = join(target, "tealbrick-ci.json");
  if (!existsSync(cfgPath)) {
    const cfg = { $schema: `https://raw.githubusercontent.com/${OWNER}/${PLATFORM_REPO}/main/ci/tealbrick-ci.schema.json`, kind, paths: ["."], images: [] };
    writeFileSync(cfgPath, `${JSON.stringify(cfg, null, 2)}\n`);
  }
  const gi = join(target, ".gitignore");
  const giText = existsSync(gi) ? readFileSync(gi, "utf8") : "";
  if (!giText.split("\n").includes(".tb-ci/")) appendFileSync(gi, `${giText.endsWith("\n") || giText === "" ? "" : "\n"}\n# opt2 CI runner scratch\n.tb-ci/\n`);
  log(`adopted ${target} (kind ${kind}); review tealbrick-ci.json, then commit`);
}

function cmdStamp(): void {
  const here = dirname(fileURLToPath(import.meta.url));
  const sha = createHash("sha256")
    .update(readFileSync(join(here, "tb-ci.ts")))
    .digest("hex");
  const tplPath = join(here, "woodpecker/ci.yaml");
  const tpl = readFileSync(tplPath, "utf8").replace(/TB_CI_SHA256: "[^"]*"/, `TB_CI_SHA256: "${sha}"`);
  writeFileSync(tplPath, tpl);
  writeFileSync(join(here, "../.woodpecker/ci.yaml"), tpl);
  log(`stamped runner sha256 ${sha}`);
}

function cmdKeygen(out: string | undefined): void {
  if (!out) fail("usage: keygen <outDir>");
  mkdirSync(out, { recursive: true, mode: 0o700 });
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const pub = publicKey.export({ type: "spki", format: "pem" }).toString();
  writeFileSync(join(out, "release-key.pem"), privateKey.export({ type: "pkcs8", format: "pem" }).toString(), { mode: 0o600 });
  writeFileSync(join(out, "release-key.pub.pem"), pub);
  log(`wrote ${out}/release-key.pem (private, 0600, never commit) and release-key.pub.pem; kid ${keyId(pub)}`);
}

async function main(argv: string[]): Promise<void> {
  const [cmd, ...rest] = argv;
  switch (cmd) {
    case "setup":
      return cmdSetup();
    case "install":
      return cmdInstall();
    case "run":
      return cmdRun(rest[0]);
    case "plan-images":
      return cmdPlanImages();
    case "release-record":
      return cmdReleaseRecord();
    case "adopt":
      return cmdAdopt(rest);
    case "stamp":
      return cmdStamp();
    case "keygen":
      return cmdKeygen(rest[0]);
    default:
      fail("usage: tb-ci setup|install|run <script>|plan-images|release-record|adopt|stamp|keygen");
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((e: unknown) => fail((e as Error).stack ?? String(e)));
}
