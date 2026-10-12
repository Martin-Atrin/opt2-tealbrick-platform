// opt2 CI runner (one file, no dependencies of its own, Node 24+ runs it directly).
// Fetched by every repo's .woodpecker/ci.yaml at a pinned tag + sha256.
// Commands:
//   setup                       template drift + config + package rules
//   install                     install dependencies per project path (frozen lockfile)
//   run <script>                run a standard script per project path (typecheck|lint|test|conformance|build)
//   gen                         BSA-03: committed gen/ not stale, `gen` script produces every tb-gen kind, tb-gen check passes
//   audit-templates             (platform cron) every opt2 repo's template ref >= ci/MIN_TEMPLATE
//   plan-images                 write .tb-ci/images.sh for the kaniko steps
//   release-record              (tag v*) validate + print the release; no token, no key (C62); the platform signer indexes it
//   registry-sync               (platform signer pipeline only) verify candidates independently, index + sign
//   pin-tarballs [<repoDir>]    (local) pin sha512 of GitHub-release tarballs the lockfile has no integrity for (S3)
//   package-pack                (tag <pkg>-v*) npm pack --ignore-scripts without tokens, then the pack guard (used by gh-build after the build)
//   gh-build / gh-publish       (C72, GitHub Actions) build without a write token / push images + attach assets, no repo code
//   registry-add-desktop ...    (TBD release, on the Mac) add a desktop entry to the signed release index
//   registry-sign               re-sign the index (offers changed, or before the envelope expires)
//   registry-add-source ...     (C29 interim) dev entry built from source at a pushed commit
//   adopt <repoDir> --kind <k>  (local) install the standard into a repo
//   stamp                       (platform maintainers) write the runner sha256 into the template
// Crypto and canonical JSON come ONLY from @opt2-tealbrick/manifest (CORE §3: one owner of primitives),
// loaded at run time from its GitHub release tarball (TB_MANIFEST_PKG) for the registry commands.

import { execFileSync } from "node:child_process";
import { createHash, createPrivateKey, createPublicKey, randomBytes } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createConnection } from "node:net";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { gunzipSync } from "node:zlib";

export const OWNER = "Martin-Atrin";
export const REGISTRY_HOST = "ghcr.io";
export const IMAGE_NAMESPACE = "ghcr.io/martin-atrin";
export const PLATFORM_REPO = "opt2-tealbrick-platform";
export const INDEX_PATH = "registry/index.json";
export const ENVELOPE_PATH = "registry/index.jws";
export const OFFERS_PATH = "registry/offers.json";
export const HARNESSES_PATH = "registry/harnesses.json";
export const REGISTRY_RELEASE_TAG = "registry";
export const INDEX_SCHEMA = "opt2.release-index/v2";
export const INDEX_TYP = "tb-release-index+jws";
export const INDEX_ISS = "tb:releases";
export const INDEX_AUD = "tb:portal";
export const MANIFEST_FILE = "tealbrick.manifest.json";

export const KINDS = ["library", "service", "miniapp", "bridge", "portal", "web", "static", "desktop", "specs", "tests"] as const;
export const OPT2_REPOS = [
  "specs",
  "sdk",
  "bridge",
  "packages",
  "portal-core",
  "portal-gui",
  "website",
  "knowledge",
  "connect",
  "tbd",
  "platform",
  "qa",
  "samples",
  "kanban",
  "rules",
  "inbox",
  "fleet",
  "evolution",
].map((n) => `opt2-tealbrick-${n}`);
export const MIN_TEMPLATE_PATH = "ci/MIN_TEMPLATE";
export type Kind = (typeof KINDS)[number];

/** Image kinds: `app` and `bridge` become release-index entries; `portal` images are published only (ours, not deployed into workspaces);
 *  `service` images (BSA-01) are companion containers of an app: built and published, digest recorded in the parent app's entry. */
export type ImageKind = "app" | "bridge" | "portal" | "service";

export interface ImageSpec {
  name: string; // ghcr image name, must start with the repo name
  context: string; // build context, relative to repo root
  dockerfile: string; // relative to repo root
  product: string; // release-index product id (manifest id for apps)
  kind: ImageKind;
  manifest?: string; // app manifest path (required for kind app), relative to repo root
  upgradeFrom: string; // semver range of versions that may update to this release
  service?: string; // kind service: the manifest runtime.services[].id this image is (product = the parent app's product)
}

export interface CiConfig {
  kind: Kind;
  paths: string[];
  conformance: boolean;
  images: ImageSpec[];
  postgres: boolean; // ci-v9.1: opt-in ephemeral Postgres for the unit step (TB_TEST_DATABASE_URL)
}

/** PORTAL-API Release (types/routes.ts `Release`) plus provenance fields. */
export type Channel = "stable" | "dev";
export interface IndexRelease {
  id: string; // rel_<ULID>
  product: string;
  kind: "app" | "bridge" | "desktop";
  version: string;
  channel: Channel;
  manifestDigest: string | null;
  manifestUrl: string | null;
  skillsDigest: string | null;
  image: string | null; // ghcr.io/martin-atrin/<name>@sha256:<hex>
  artifact: { url: string; sha256: string } | null; // desktop
  source: { repo: string; ref: string; dockerfile: string; context?: string } | null; // C29 interim: dev-channel source build; dockerfile repo-relative, context repo-relative build root (absent = ".")
  runtime: BridgeRuntime | null; // kind bridge only (the bridge has no app manifest); apps take runtime from their manifest
  services?: { id: string; image: string }[] | null; // app image releases: one published image per manifest service with `build` (BSA-01)
  minOs: string | null; // desktop
  notarized: boolean | null; // desktop
  upgradeFrom: string;
  repo: string;
  commit: string | null;
  tag: string | null;
  publishedAt: string;
  devOnly?: true; // C113: DEV_ONLY_PRODUCTS (always channel dev); Core never offers or deploys it in a stable workspace
}

/** Deploy recipe facts for the bridge service (apps carry these in their manifest `runtime`). */
export interface BridgeRuntime {
  port: number; // public (MCP, launch, key page)
  internalPort: number; // private network only (apps, companions)
  healthPath: string; // liveness
  readyPath: string; // ready after enrolment
  volumes: { mountPath: string; backup: boolean }[]; // backup = Railway volume backups on (C28, S7)
  env: { name: string; source: "portal" | "provider-secret" | "public-url" | "public-url-keys" | "fixed"; value?: string }[];
}

export function validateBridgeRuntime(raw: unknown): BridgeRuntime {
  const r = raw as Record<string, unknown>;
  const port = (v: unknown) => Number.isInteger(v) && (v as number) > 0 && (v as number) < 65536;
  const path = (v: unknown) => typeof v === "string" && v.startsWith("/");
  if (!r || !port(r.port) || !port(r.internalPort) || r.port === r.internalPort) throw new Error("runtime: port and internalPort must be distinct ports");
  if (!path(r.healthPath) || !path(r.readyPath)) throw new Error("runtime: healthPath and readyPath must be absolute paths");
  if (
    !Array.isArray(r.volumes) ||
    !r.volumes.every((v) => path((v as Record<string, unknown>).mountPath) && typeof (v as Record<string, unknown>).backup === "boolean")
  )
    throw new Error("runtime: volumes [{mountPath, backup}]");
  if (!Array.isArray(r.env)) throw new Error("runtime: env list required");
  for (const e of r.env as Record<string, unknown>[]) {
    if (typeof e.name !== "string" || !/^[A-Z][A-Z0-9_]{1,63}$/.test(e.name)) throw new Error(`runtime: bad env name ${String(e.name)}`);
    if (!["portal", "provider-secret", "public-url", "public-url-keys", "fixed"].includes(e.source as string)) throw new Error(`runtime: env ${e.name} source`);
    if (e.source === "fixed" ? typeof e.value !== "string" : e.value !== undefined) throw new Error(`runtime: env ${e.name}: value only for source fixed`);
  }
  return r as unknown as BridgeRuntime;
}

export interface Offer {
  id: string; // off_<ULID>
  kind: "single" | "bundle";
  name: string;
  products: string[];
  major: number;
  amount: number; // minor units
  currency: string;
  taxNote: string;
  stripePrice: { test: string | null; live: string | null };
}

/** C40/C40a: harness options as data, exactly the frozen PORTAL-API `HarnessOption` (types/routes.ts). Core syncs them. */
export interface Harness {
  id: string;
  kind: "desktop" | "agentic_system" | "other";
  label: string;
  /** Asset URL served from the release of the harness, or null. */
  icon: string | null;
  authorise: "device_approval" | "instruction_set" | "url";
  /** true = the "I do not have an agent" path (download the desktop app). */
  noAgentPath: boolean;
  /** C43: InstructionSet-shaped step template. Placeholders: {{mcpUrl}}, {{agentId}} (Core), {{pairingCode}} (GUI). */
  instructions: HarnessStep[];
}
export interface HarnessStep {
  title: string;
  detail: string;
  copy?: { kind: "command" | "json" | "url" | "text"; value: string };
}

export interface ReleaseIndex {
  schema: typeof INDEX_SCHEMA;
  generatedAt: string;
  releases: IndexRelease[];
  offers: Offer[];
  harnesses: Harness[];
}

/** Claims of the signed envelope (the JWS stays far below MAX_JWS_BYTES; the body is index.json). */
export interface IndexEnvelopeClaims {
  iss: typeof INDEX_ISS;
  aud: typeof INDEX_AUD;
  iat: number;
  exp: number;
  schema: typeof INDEX_SCHEMA;
  indexDigest: string; // manifest-package digest(index body)
  releases: number;
  offers: number;
}

/** The subset of @opt2-tealbrick/manifest the registry uses (SDK-API §2). */
export interface ManifestPkg {
  digest(value: unknown): string;
  manifestDigest(manifest: unknown): string;
  validateManifest(json: unknown): { ok: true; manifest: unknown } | { ok: false; errors: unknown[] };
  thumbprint(jwk: JsonWebKey): string;
  signReleaseIndex(
    body: ReleaseIndex,
    input: { iat: number; exp?: number },
    key: { publicJwk: JsonWebKey; privateKey: CryptoKey; kid: string },
  ): Promise<string>;
  verifyReleaseIndex(
    token: string,
    body: ReleaseIndex,
    ctx: { now: number; keys: unknown },
  ): { ok: true; claims: IndexEnvelopeClaims } | { ok: false; reason?: string };
  keySetFrom(jwks: { keys: JsonWebKey[] }, issuer: string): unknown;
}

const REQUIRED_SCRIPTS = ["typecheck", "lint", "test"] as const;

/** `ci-vN` -> N, `ci-vN.M` -> N (the major); anything else -> NaN. */
export function templateNumber(ref: string): number {
  return templateVersion(ref)?.[0] ?? Number.NaN;
}

/** `ci-vN` -> [N, 0], `ci-vN.M` -> [N, M] (ci-v9.1: point releases of a template); anything else -> null. */
export function templateVersion(ref: string): [number, number] | null {
  const m = /^ci-v(\d+)(?:\.(\d+))?$/.exec(ref.trim());
  return m ? [Number(m[1]), Number(m[2] ?? 0)] : null;
}

/** D1/C56: a template ref below the minimum (or unparseable) is refused. */
export function belowMinimum(ref: string, min: string): boolean {
  const a = templateVersion(ref);
  const b = templateVersion(min);
  if (!b) throw new Error(`bad minimum template ref ${min}`);
  return !a || a[0] < b[0] || (a[0] === b[0] && a[1] < b[1]);
}

function fail(msg: string): never {
  console.error(`tb-ci: FAIL: ${msg}`);
  process.exit(1);
}

function log(msg: string): void {
  console.log(`tb-ci: ${msg}`);
}

// ---------- pure helpers (unit tested) ----------

export function channelForVersion(version: string): Channel {
  return version.includes("-") ? "dev" : "stable";
}

/** ci-v9.4: products the signer indexes ONLY on channel "dev" (test fixtures; never offered to stable workspaces).
 *  The one list: releaseChannel() and mergeIndex() both read it. */
export const DEV_ONLY_PRODUCTS: readonly string[] = ["sample-gate", "sample-caller", "sample-pay", "sample-mismatch"];

export function isDevOnlyProduct(product: string): boolean {
  return DEV_ONLY_PRODUCTS.includes(product);
}

/** C113: every release of a DEV_ONLY product carries devOnly: true and channel dev. A stable record a pre-ci-v9.4
 *  signer published is RE-CLASSIFIED to dev (same id, digests, image; nothing deleted). If that leaves two records with
 *  the same (product, version, dev) and identical content, the earlier one (the original) is kept and the later copy is
 *  folded into it; different content for the same key is refused. Other products are returned unchanged. Idempotent. */
export function normalizeDevOnly(releases: IndexRelease[]): { releases: IndexRelease[]; notes: string[] } {
  const notes: string[] = [];
  const marked = releases.map((r) => {
    if (!isDevOnlyProduct(r.product)) return r;
    if (r.channel === "stable") notes.push(`${r.product}@${r.version} ${r.id} re-classified stable -> dev`);
    else if (r.devOnly !== true) notes.push(`${r.product}@${r.version} ${r.id} marked devOnly`);
    return { ...r, channel: "dev" as Channel, devOnly: true as const };
  });
  const same = (a: IndexRelease, b: IndexRelease) =>
    a.image === b.image &&
    a.manifestDigest === b.manifestDigest &&
    a.skillsDigest === b.skillsDigest &&
    a.commit === b.commit &&
    a.source?.ref === b.source?.ref &&
    JSON.stringify(a.services ?? null) === JSON.stringify(b.services ?? null);
  const kept = new Map<string, IndexRelease>();
  const out: IndexRelease[] = [];
  for (const r of [...marked].sort((a, b) => a.publishedAt.localeCompare(b.publishedAt))) {
    if (r.devOnly !== true) {
      out.push(r);
      continue;
    }
    const key = `${r.product}@${r.version}@${r.channel}`;
    const first = kept.get(key);
    if (!first) {
      kept.set(key, r);
      out.push(r);
    } else if (same(first, r)) notes.push(`${r.product}@${r.version} ${r.id} folded into ${first.id} (identical record)`);
    else throw new Error(`${r.product}@${r.version}: two dev records with different content (releases are immutable)`);
  }
  const keep = new Set(out);
  return { releases: marked.filter((r) => keep.has(r)), notes }; // original order
}

/** The channel the signer indexes a release on: a dev-only product is always "dev", whatever its version says. */
export function releaseChannel(product: string, version: string): Channel {
  return isDevOnlyProduct(product) ? "dev" : channelForVersion(version);
}

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
/** `<prefix>_<ULID>` (CORE §1). */
export function newId(prefix: string, now = Date.now(), rand: Uint8Array = randomBytes(10)): string {
  let t = "";
  let ms = now;
  for (let i = 0; i < 10; i++) {
    t = CROCKFORD[ms % 32] + t;
    ms = Math.floor(ms / 32);
  }
  let bits = 0n;
  for (const b of rand) bits = (bits << 8n) | BigInt(b);
  let r = "";
  for (let i = 0; i < 16; i++) {
    r = CROCKFORD[Number(bits & 31n)] + r;
    bits >>= 5n;
  }
  return `${prefix}_${t}${r}`;
}

export function versionFromTag(tag: string): string {
  const m = /^v(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/.exec(tag);
  if (!m) throw new Error(`tag ${JSON.stringify(tag)} is not v<semver> without build metadata`);
  return m[1];
}

export function validateConfig(raw: unknown, repoName: string): CiConfig {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new Error("tealbrick-ci.json must be an object");
  const o = raw as Record<string, unknown>;
  const allowed = new Set(["$schema", "kind", "paths", "conformance", "images", "postgres"]);
  for (const k of Object.keys(o)) if (!allowed.has(k)) throw new Error(`unknown field ${k}`);
  if (!KINDS.includes(o.kind as Kind)) throw new Error(`kind must be one of ${KINDS.join(", ")}`);
  const kind = o.kind as Kind;
  const paths = o.paths === undefined ? ["."] : o.paths;
  if (!Array.isArray(paths) || paths.length === 0 || !paths.every((p) => typeof p === "string" && safeRel(p)))
    throw new Error("paths must be a non-empty list of relative paths");
  const conformance = o.conformance === undefined ? kind === "miniapp" || kind === "bridge" : o.conformance;
  if (typeof conformance !== "boolean") throw new Error("conformance must be boolean");
  const postgres = o.postgres === undefined ? false : o.postgres;
  if (typeof postgres !== "boolean") throw new Error("postgres must be boolean");
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
    const kind = r.kind;
    if (!["app", "bridge", "portal", "service"].includes(kind as string)) throw new Error(`images[${i}].kind must be app|bridge|portal|service`);
    const service = r.service;
    if (kind === "service" && (typeof service !== "string" || !/^[a-z0-9][a-z0-9-]*$/.test(service)))
      throw new Error(`images[${i}]: a service image needs service (the manifest runtime.services[].id)`);
    if (kind !== "service" && service !== undefined) throw new Error(`images[${i}].service is only allowed for kind service`);
    const manifest = r.manifest;
    if (manifest !== undefined && (typeof manifest !== "string" || !safeRel(manifest))) throw new Error(`images[${i}].manifest must be a relative path`);
    if (kind === "app" && manifest === undefined) throw new Error(`images[${i}]: an app image needs manifest (${MANIFEST_FILE})`);
    const upgradeFrom = r.upgradeFrom ?? "*";
    if (typeof upgradeFrom !== "string" || upgradeFrom.length === 0) throw new Error(`images[${i}].upgradeFrom must be a semver range`);
    return {
      name,
      context,
      dockerfile,
      product,
      kind: kind as ImageKind,
      upgradeFrom,
      ...(manifest ? { manifest } : {}),
      ...(kind === "service" ? { service: service as string } : {}),
    };
  });
  for (const im of images.filter((x) => x.kind === "service")) {
    if (!images.some((a) => a.kind === "app" && a.product === im.product))
      throw new Error(`service image ${im.name}: no app image with product ${im.product} (its parent)`);
    if (images.filter((x) => x.kind === "service" && x.product === im.product && x.service === im.service).length > 1)
      throw new Error(`service ${im.product}/${im.service} declared twice`);
  }
  return { kind, paths, conformance, images, postgres };
}

function safeRel(p: string): boolean {
  return p.length > 0 && !p.startsWith("/") && !p.split("/").includes("..");
}

export function requiredScripts(cfg: CiConfig, multiPackage = false): string[] {
  return [...REQUIRED_SCRIPTS, ...(cfg.conformance ? ["conformance"] : []), ...(multiPackage ? ["build"] : []), ...(cfg.kind === "miniapp" ? ["gen"] : [])];
}

/** BSA-03: the generated kinds `tb-gen all` must produce for a miniapp (relative to gen/). */
export function expectedGenFiles(product: string): string[] {
  return ["openapi/openapi.json", `kit/${product}-kit/package.json`, `docs/${product}.md`, "railway/railway.json"];
}

/** BSA-01: every manifest service built from source needs exactly one service image; returns problems. */
export function checkServiceImages(cfg: CiConfig, appProduct: string, manifestServices: { id: string; build?: unknown; image?: unknown }[]): string[] {
  const declared = cfg.images.filter((im) => im.kind === "service" && im.product === appProduct).map((im) => im.service as string);
  const built = manifestServices.filter((s) => s.build).map((s) => s.id);
  const errs: string[] = [];
  for (const id of built) if (!declared.includes(id)) errs.push(`manifest service ${id} has build but no images[] entry of kind service (service: "${id}")`);
  for (const id of declared) if (!built.includes(id)) errs.push(`images[] service ${id} is not a manifest service with build`);
  return errs;
}

export function checkPackageJson(pkg: Record<string, unknown>, cfg: CiConfig, where: string, multiPackage = false): string[] {
  const errors: string[] = [];
  if (pkg.private !== true) errors.push(`${where}: "private": true is required (no npm publishing in opt2; packages ship as GitHub release tarballs)`);
  if (pkg.publishConfig !== undefined) errors.push(`${where}: publishConfig is not allowed`);
  const scripts = (pkg.scripts ?? {}) as Record<string, unknown>;
  for (const s of requiredScripts(cfg, multiPackage)) if (typeof scripts[s] !== "string") errors.push(`${where}: script "${s}" is required`);
  return errors;
}

export const RELEASE_URL_RE =
  /^https:\/\/github\.com\/Martin-Atrin\/opt2-tealbrick-[a-z0-9-]+\/releases\/download\/[a-z0-9-]+-v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?\/[a-z0-9-]+-\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?\.tgz$/;
/** ci-v9.3: the exact spec tarball the manifest package is loaded with (pinned by sha512 next to it). */
const SPEC_URL_RE =
  /^https:\/\/github\.com\/Martin-Atrin\/opt2-tealbrick-specs\/releases\/download\/spec-v\d+\.\d+\.\d+\/opt2-tealbrick-spec-\d+\.\d+\.\d+\.tgz$/;
const DEP_FIELDS = ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"] as const;

/** Dependency rules: no v1 names; @opt2-tealbrick/* only as workspace (same repo) or GitHub release tarball URL. Returns [errors, urls]. */
export function checkDependencies(pkg: Record<string, unknown>, where: string, localNames: Set<string>): [string[], string[]] {
  const errors: string[] = [];
  const urls: string[] = [];
  for (const field of DEP_FIELDS) {
    const deps = (pkg[field] ?? {}) as Record<string, unknown>;
    for (const [name, spec] of Object.entries(deps)) {
      const v = String(spec);
      if (name === "tealbrick" || name.startsWith("@tealbrick/")) errors.push(`${where}: ${field}.${name}: v1 package names are not allowed in opt2`);
      if (!name.startsWith("@opt2-tealbrick/")) continue;
      if (v.startsWith("workspace:")) {
        if (!localNames.has(name)) errors.push(`${where}: ${field}.${name}: workspace: is only allowed for packages in this repo`);
      } else if (RELEASE_URL_RE.test(v)) {
        urls.push(v);
      } else {
        errors.push(
          `${where}: ${field}.${name}: must be a GitHub release tarball URL (https://github.com/Martin-Atrin/opt2-tealbrick-<repo>/releases/download/<pkg>-v<ver>/<file>.tgz), got ${JSON.stringify(v)}`,
        );
      }
    }
  }
  return [errors, urls];
}

/** Minimal pnpm-workspace.yaml reader: supports `- dir/*` and `- dir` entries only. */
export function workspaceGlobs(yamlText: string): string[] {
  const out: string[] = [];
  let inPackages = false;
  for (const line of yamlText.split("\n")) {
    if (/^packages:\s*$/.test(line)) {
      inPackages = true;
      continue;
    }
    if (inPackages && /^\S/.test(line)) inPackages = false;
    const m = inPackages ? /^\s+-\s+["']?([^"'#]+?)["']?\s*(#.*)?$/.exec(line) : null;
    if (m) {
      const g = m[1].trim();
      if (!/^[A-Za-z0-9._/-]+(\/\*)?$/.test(g) || g.split("/").includes("..")) throw new Error(`unsupported workspace pattern ${g} (use dir/* or dir)`);
      out.push(g);
    }
  }
  return out;
}

export function parsePackageTag(tag: string): { dir: string; version: string } {
  const m = /^([a-z0-9][a-z0-9-]*)-v(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/.exec(tag);
  if (!m) throw new Error(`tag ${JSON.stringify(tag)} is not <package>-v<semver>`);
  return { dir: m[1], version: m[2] };
}

/** npm pack file name for a package name + version. */
export function tarballName(name: string, version: string): string {
  return `${name.replace(/^@/, "").replace("/", "-")}-${version}.tgz`;
}

export function releaseUrl(repo: string, dir: string, name: string, version: string): string {
  return `https://github.com/${OWNER}/${repo}/releases/download/${dir}-v${version}/${tarballName(name, version)}`;
}

/** ci-v9.1 (C75): the build that runs before `npm pack` on a package tag. The repo's root `build` script (the same one the
 *  Woodpecker build stage runs), else the tagged package and its workspace dependencies. Args for `corepack`. */
export function packageBuildArgs(rootScripts: Record<string, unknown>, target: string): string[] {
  return typeof rootScripts.build === "string" ? ["pnpm", "run", "build"] : ["pnpm", "--filter", `${target}...`, "run", "--if-present", "build"];
}

/** ci-v9.1 (C75): the commands gh-build runs on a package tag before `package-pack`: frozen, script-free installs per pnpm path,
 *  then the build. Before ci-v9.1 there was no build, so tarballs shipped without dist/. */
export function packageReleaseCommands(
  dirs: { dir: string; pm: "pnpm" | "npm" | null }[],
  projectDir: string,
  rootScripts: Record<string, unknown>,
  target: string,
): { cwd: string; cmd: string; args: string[] }[] {
  const out = dirs
    .filter((d) => d.pm === "pnpm")
    .map((d) => ({ cwd: d.dir, cmd: "corepack", args: ["pnpm", "install", "--frozen-lockfile", "--ignore-scripts"] }));
  out.push({ cwd: projectDir, cmd: "corepack", args: packageBuildArgs(rootScripts, target) });
  return out;
}

/** ci-v9.1 pack guard: every file a package.json entry field points at (main, module, types, typings, bin, exports), relative to
 *  the package root. Export wildcard patterns (`./schemas/*`) are returned as patterns. */
export function packEntryTargets(pkg: Record<string, unknown>): string[] {
  const out = new Set<string>();
  const add = (v: unknown): void => {
    if (typeof v === "string" && v.length > 0) out.add(v.replace(/^\.\//, ""));
  };
  for (const f of ["main", "module", "types", "typings"]) add(pkg[f]);
  const bin = pkg.bin;
  if (typeof bin === "string") add(bin);
  else if (bin && typeof bin === "object") for (const v of Object.values(bin)) add(v);
  const walk = (e: unknown): void => {
    if (typeof e === "string") add(e);
    else if (Array.isArray(e)) for (const x of e) walk(x);
    else if (e && typeof e === "object") for (const v of Object.values(e)) walk(v);
  };
  walk(pkg.exports);
  return [...out].sort();
}

/** Entry targets of `pkg` that are not in `files` (paths relative to the package root). A wildcard pattern needs one match;
 *  an extension-less `main` resolves like Node (`x`, `x.js`, `x.json`, `x/index.js`). */
export function missingPackTargets(pkg: Record<string, unknown>, files: Iterable<string>): string[] {
  const have = new Set(files);
  const list = [...have];
  return packEntryTargets(pkg).filter((t) => {
    if (t.includes("*")) {
      const parts = t.split("*").map((s) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&"));
      const re = new RegExp(`^${parts.join(".+")}$`);
      return !list.some((f) => re.test(f));
    }
    return ![t, `${t}.js`, `${t}.json`, `${t}/index.js`].some((c) => have.has(c));
  });
}

/** Files of an npm-pack .tgz (ustar + pax/GNU long names), keyed by path relative to the package root (`package/` stripped). */
export function tarEntries(tgz: Uint8Array): Map<string, Buffer> {
  const buf = gunzipSync(tgz);
  const out = new Map<string, Buffer>();
  const str = (b: Buffer): string => b.toString("utf8").replace(/\0.*$/s, "");
  let off = 0;
  let longName: string | null = null;
  while (off + 512 <= buf.length) {
    const h = buf.subarray(off, off + 512);
    if (h.every((x) => x === 0)) break;
    const size = Number.parseInt(str(h.subarray(124, 136)).trim() || "0", 8);
    const type = String.fromCharCode(h[156] || 48);
    const body = buf.subarray(off + 512, off + 512 + size);
    off += 512 + Math.ceil(size / 512) * 512;
    if (type === "x") {
      const m = /(?:^|\n)\d+ path=([^\n]*)\n/.exec(body.toString("utf8"));
      if (m) longName = m[1];
      continue;
    }
    if (type === "L") {
      longName = str(body);
      continue;
    }
    if (type === "g") continue;
    const prefix = str(h.subarray(257, 263)).startsWith("ustar") ? str(h.subarray(345, 500)) : "";
    const name = longName ?? (prefix ? `${prefix}/${str(h.subarray(0, 100))}` : str(h.subarray(0, 100)));
    longName = null;
    if (type !== "0" && type !== "\0") continue; // regular files only
    out.set(name.replace(/^[^/]+\//, ""), Buffer.from(body));
  }
  return out;
}

/** Problems of a packed package: no package.json, or entry targets (main/exports/types/bin) missing from the tarball (e.g. no dist/). */
export function checkPackedTarball(tgz: Uint8Array): string[] {
  const entries = tarEntries(tgz);
  const pj = entries.get("package.json");
  if (!pj) return ["the tarball has no package.json"];
  const pkg = JSON.parse(pj.toString("utf8")) as Record<string, unknown>;
  return missingPackTargets(pkg, entries.keys()).map((t) => `${String(pkg.name)}: ${t} is referenced by package.json but missing from the tarball`);
}

/** ci-v9.1: the unit step talks to the opt-in Postgres step (Woodpecker step `postgres`) only when tealbrick-ci.json asks. */
export const PG_TEST_URL = "postgres://tb:tb-ci-only@postgres:5432/tb";
export const PG_MARKER = ".tb-ci/postgres";
/** ci-v9.2: written when the unit step ends (pass or fail); the template's postgres step then stops itself and exits 0. ci-v9.3: the step is a normal parallel step (a detached one ends red). */
export const PG_DONE_MARKER = ".tb-ci/postgres-done";
export function testEnv(cfg: CiConfig, env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out = { ...env };
  if (cfg.postgres) out.TB_TEST_DATABASE_URL = PG_TEST_URL;
  else delete out.TB_TEST_DATABASE_URL;
  return out;
}

/** Merge new releases into the index. Releases are immutable: (product, version, channel) never changes content.
 *  A dev source build (C29) and the later stable image of the same version are two releases. */
export function mergeIndex(prev: ReleaseIndex | null, add: IndexRelease[], offers: Offer[], now: string, harnesses: Harness[] = []): ReleaseIndex {
  const releases: IndexRelease[] = (prev?.releases ?? []).map((r) => ({ ...r, runtime: r.runtime ?? null, services: r.services ?? null }));
  for (const r of add) {
    if (r.channel === "stable" && isDevOnlyProduct(r.product))
      throw new Error(`${r.product}@${r.version}: ${r.product} is dev-only (DEV_ONLY_PRODUCTS); the signer refuses a stable release`);
    if (r.kind !== "desktop" && r.channel === "stable" && !r.image)
      throw new Error(`${r.product}@${r.version}: a stable release needs an image digest (source builds are dev only, C29)`);
    if (r.kind !== "desktop" && !r.image && !r.source) throw new Error(`${r.product}@${r.version}: needs image or source`);
    if ((r.kind === "bridge") !== (r.runtime !== null && r.runtime !== undefined))
      throw new Error(`${r.product}@${r.version}: runtime is required for kind bridge and only allowed there`);
    const old = releases.find((x) => x.product === r.product && x.version === r.version && x.channel === r.channel);
    if (old) {
      if (
        old.image !== r.image ||
        old.artifact?.sha256 !== r.artifact?.sha256 ||
        old.manifestDigest !== r.manifestDigest ||
        old.source?.ref !== r.source?.ref ||
        (old.source?.context ?? ".") !== (r.source?.context ?? ".")
      )
        throw new Error(`${r.product}@${r.version} is already released with other content (releases are immutable; ship a new version)`);
      continue;
    }
    releases.push(r);
  }
  const normalized = normalizeDevOnly(releases).releases; // C113
  releases.length = 0;
  releases.push(...normalized);
  releases.sort((x, y) => (x.product === y.product ? x.publishedAt.localeCompare(y.publishedAt) : x.product.localeCompare(y.product)));
  return { schema: INDEX_SCHEMA, generatedAt: now, releases, offers, harnesses };
}

export function validateHarnesses(raw: unknown): Harness[] {
  if (!Array.isArray(raw)) throw new Error("harnesses.json must be an array");
  const ids = new Set<string>();
  const keys = ["authorise", "icon", "id", "instructions", "kind", "label", "noAgentPath"];
  const PLACEHOLDERS = new Set(["mcpUrl", "agentId", "pairingCode"]);
  const checkText = (v: unknown, where: string, bad: (m: string) => never) => {
    if (typeof v !== "string" || !v) bad(`${where} must be a non-empty string`);
    for (const m of (v as string).matchAll(/\{\{\s*([^}]*?)\s*\}\}/g)) if (!PLACEHOLDERS.has(m[1])) bad(`${where}: unknown placeholder {{${m[1]}}}`);
  };
  const out = raw.map((h, i) => {
    const r = h as Record<string, unknown>;
    const bad = (m: string): never => {
      throw new Error(`harnesses[${i}]: ${m}`);
    };
    if (Object.keys(r).sort().join(",") !== keys.join(",")) bad(`fields must be exactly ${keys.join(", ")} (HarnessOption + instructions)`);
    if (!Array.isArray(r.instructions) || r.instructions.length === 0) bad("instructions: at least one step");
    (r.instructions as Record<string, unknown>[]).forEach((st, j) => {
      const extra = Object.keys(st).filter((k) => !["title", "detail", "copy"].includes(k));
      if (extra.length) bad(`instructions[${j}]: unknown field ${extra.join(",")}`);
      checkText(st.title, `instructions[${j}].title`, bad);
      checkText(st.detail, `instructions[${j}].detail`, bad);
      if (st.copy !== undefined) {
        const c = st.copy as Record<string, unknown>;
        if (!["command", "json", "url", "text"].includes(c.kind as string) || Object.keys(c).sort().join(",") !== "kind,value")
          bad(`instructions[${j}].copy must be {kind: command|json|url|text, value}`);
        checkText(c.value, `instructions[${j}].copy.value`, bad);
      }
    });
    if (typeof r.id !== "string" || !/^[a-z0-9][a-z0-9-]{1,40}$/.test(r.id)) bad("id (lowercase slug)");
    if (ids.has(r.id as string)) bad("duplicate id");
    ids.add(r.id as string);
    if (typeof r.label !== "string" || !r.label) bad("label");
    if (!["desktop", "agentic_system", "other"].includes(r.kind as string)) bad("kind desktop|agentic_system|other");
    if (!["device_approval", "instruction_set", "url"].includes(r.authorise as string)) bad("authorise device_approval|instruction_set|url");
    if (typeof r.noAgentPath !== "boolean") bad("noAgentPath boolean");
    if (r.icon !== null && !(typeof r.icon === "string" && /^https:\/\/(github\.com|raw\.githubusercontent\.com)\/Martin-Atrin\/opt2-tealbrick-/.test(r.icon)))
      bad("icon: opt2 GitHub URL or null");
    return r as unknown as Harness;
  });
  if (out.filter((h) => h.noAgentPath).length > 1) throw new Error("at most one harness may be the no-agent path");
  return out;
}

export function validateOffers(raw: unknown): Offer[] {
  if (!Array.isArray(raw)) throw new Error("offers.json must be an array");
  const ids = new Set<string>();
  return raw.map((o, i) => {
    const r = o as Record<string, unknown>;
    const fail = (m: string): never => {
      throw new Error(`offers[${i}]: ${m}`);
    };
    if (typeof r.id !== "string" || !/^off_[0-9A-HJKMNP-TV-Z]{26}$/.test(r.id)) fail("id must be off_<ULID>");
    if (ids.has(r.id as string)) fail("duplicate id");
    ids.add(r.id as string);
    if (r.kind !== "single" && r.kind !== "bundle") fail("kind single|bundle");
    if (!Array.isArray(r.products) || r.products.length === 0) fail("products required");
    if (r.kind === "single" && (r.products as unknown[]).length !== 1) fail("a single offer has exactly one product");
    if (!Number.isInteger(r.major) || (r.major as number) < 0) fail("major");
    if (!Number.isInteger(r.amount) || (r.amount as number) < 0) fail("amount (minor units)");
    // Free fixture offer: amount 0 only for DEV_ONLY_PRODUCTS, single, no Stripe price (Core grants the licence with no
    // checkout, only in dev-channel workspaces).
    const free = r.amount === 0;
    if (free && (r.kind !== "single" || !(r.products as unknown[]).every((p) => typeof p === "string" && isDevOnlyProduct(p))))
      fail("amount 0 (free) is only for a single offer of a DEV_ONLY_PRODUCTS product");
    if (typeof r.currency !== "string" || !/^[a-z]{3}$/.test(r.currency)) fail("currency (ISO lower case)");
    for (const k of ["name", "taxNote"]) if (typeof r[k] !== "string" || !(r[k] as string)) fail(k);
    const sp = r.stripePrice as Record<string, unknown> | undefined;
    if (!sp || !("test" in sp) || !("live" in sp)) fail("stripePrice {test, live}");
    for (const m of ["test", "live"] as const) {
      const v = (sp as Record<string, unknown>)[m];
      if (v !== null && (typeof v !== "string" || !/^price_[A-Za-z0-9]+$/.test(v))) fail(`stripePrice.${m} must be price_… or null`);
      if (free && v !== null) fail(`a free offer has no Stripe price (stripePrice.${m} must be null)`);
    }
    return r as unknown as Offer;
  });
}

export const INTEGRITY_FILE = "tealbrick-integrity.json";

/** S3 (C59): GitHub-release tarballs in a lockfile and whether the lockfile itself carries integrity for them. */
export function lockfileTarballs(lockText: string, kind: "pnpm" | "npm"): { url: string; integrity: string | null }[] {
  const out = new Map<string, string | null>();
  if (kind === "npm") {
    const lock = JSON.parse(lockText) as { packages?: Record<string, { resolved?: string; integrity?: string }> };
    for (const v of Object.values(lock.packages ?? {})) {
      if (v.resolved && /\/releases\/download\/.+\.tgz$/.test(v.resolved)) out.set(v.resolved, v.integrity ?? out.get(v.resolved) ?? null);
    }
  } else {
    for (const line of lockText.split("\n")) {
      const m = /resolution:\s*\{([^}]*)\}/.exec(line);
      if (!m) continue;
      const tarball = /tarball:\s*([^,\s}]+)/.exec(m[1])?.[1];
      if (!tarball || !/\/releases\/download\/.+\.tgz$/.test(tarball)) continue;
      out.set(tarball, /integrity:\s*([^,\s}]+)/.exec(m[1])?.[1] ?? null);
    }
  }
  return [...out].map(([url, integrity]) => ({ url, integrity }));
}

export function sha512Integrity(data: Uint8Array): string {
  return `sha512-${createHash("sha512").update(data).digest("base64")}`;
}

/** ci-v9.5 (F27): the checksum files published next to each release tarball: `<name>.sha256` (sha256sum format, as
 *  before) and `<name>.integrity` (the npm/pnpm lockfile `integrity` value, sha512, one line). Pure. */
export function assetChecksums(name: string, data: Uint8Array): { sha256: string; integrity: string; files: { name: string; body: string }[] } {
  const sha256 = createHash("sha256").update(data).digest("hex");
  const integrity = sha512Integrity(data);
  return {
    sha256,
    integrity,
    files: [
      { name: `${name}.sha256`, body: `${sha256}  ${name}\n` },
      { name: `${name}.integrity`, body: `${integrity}\n` },
    ],
  };
}

/** C62/BSD-10: write `integrity` into every pnpm `resolution: {tarball: …}` for a GitHub-release tarball. Pure. */
export function addPnpmIntegrity(lockText: string, integrityOf: (url: string) => string): { text: string; changed: number } {
  let changed = 0;
  const text = lockText.replace(/resolution:\s*\{tarball:\s*(https:\/\/github\.com\/[^\s,}]+\/releases\/download\/[^\s,}]+\.tgz)\s*\}/g, (_m, url: string) => {
    changed++;
    return `resolution: {integrity: ${integrityOf(url)}, tarball: ${url}}`;
  });
  return { text, changed };
}

/** Returns problems: every GitHub-release tarball needs `integrity` IN THE LOCKFILE (pnpm and npm verify it on every install,
 *  also inside Docker builds) and that integrity must equal the published tarball. */
async function checkTarballIntegrity(dir: string, where: string): Promise<string[]> {
  const pm = packageManager(dir);
  if (!pm) return [];
  const lockName = pm === "pnpm" ? "pnpm-lock.yaml" : "package-lock.json";
  const entries = lockfileTarballs(readFileSync(join(dir, lockName), "utf8"), pm);
  const errs: string[] = [];
  if (existsSync(join(dir, INTEGRITY_FILE)))
    errs.push(`${where}: ${INTEGRITY_FILE} is retired (C62): run node ci/tb-ci.ts pin-tarballs, which writes integrity into ${lockName}, then delete it`);
  for (const e of entries) {
    if (!e.integrity) {
      errs.push(`${where}: ${e.url} has no integrity in ${lockName} (run: node ci/tb-ci.ts pin-tarballs ../<repo>)`);
      continue;
    }
    const res = await fetch(e.url, { redirect: "follow" });
    if (!res.ok) {
      errs.push(`${where}: ${e.url} HTTP ${res.status}`);
      continue;
    }
    if (sha512Integrity(new Uint8Array(await res.arrayBuffer())) !== e.integrity) errs.push(`${where}: ${e.url} does not match the integrity in ${lockName}`);
  }
  return errs;
}

/** (local) C62: write sha512 integrity into pnpm-lock.yaml for every GitHub-release tarball (npm lockfiles already carry it). */
async function cmdPinTarballs(args: string[]): Promise<void> {
  const dir = resolve(args[0] ?? ".");
  const pm = packageManager(dir);
  if (!pm) fail(`${dir}: no lockfile`);
  rmSync(join(dir, INTEGRITY_FILE), { force: true });
  if (pm === "npm") {
    const missing = lockfileTarballs(readFileSync(join(dir, "package-lock.json"), "utf8"), "npm").filter((e) => !e.integrity);
    if (missing.length) fail(`package-lock.json lacks integrity for ${missing.map((e) => e.url).join(", ")}; run npm install to refresh it`);
    log("package-lock.json carries integrity for every release tarball");
    return;
  }
  const lockPath = join(dir, "pnpm-lock.yaml");
  const lock = readFileSync(lockPath, "utf8");
  const urls = [
    ...new Set(
      lockfileTarballs(lock, "pnpm")
        .filter((e) => !e.integrity)
        .map((e) => e.url),
    ),
  ];
  const sums = new Map<string, string>();
  for (const url of urls) {
    const res = await fetch(url, { redirect: "follow" });
    if (!res.ok) fail(`${url}: HTTP ${res.status}`);
    sums.set(url, sha512Integrity(new Uint8Array(await res.arrayBuffer())));
  }
  const { text, changed } = addPnpmIntegrity(lock, (u) => sums.get(u) as string);
  writeFileSync(lockPath, text);
  log(`wrote integrity for ${changed} tarball resolution(s) into pnpm-lock.yaml; run pnpm install --frozen-lockfile to confirm, then commit`);
}

/** C62: `packageManager` must pin pnpm by hash (corepack verifies it): pnpm@<semver>+sha512.<128 hex>. */
export function packageManagerPinned(value: unknown): boolean {
  return typeof value === "string" && /^pnpm@\d+\.\d+\.\d+\+sha512\.[0-9a-f]{128}$/.test(value);
}

/** C62: every install in a Dockerfile is frozen and runs no install scripts. Returns problems (line numbers are 1-based). */
export function dockerfileInstallProblems(text: string): string[] {
  const out: string[] = [];
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const start = i;
    let instr = lines[i];
    while (instr.trimEnd().endsWith("\\") && i + 1 < lines.length) instr = `${instr.trimEnd().slice(0, -1)} ${lines[++i]}`;
    const t = instr.trim();
    if (!/^RUN\s/i.test(t)) continue;
    for (const cmd of t.slice(3).split(/&&|;|\|\|/)) {
      const c = cmd.trim();
      if (/(^|\s)(corepack\s+)?pnpm\s+(install|i|add)(\s|$)/.test(c)) {
        if (!/--frozen-lockfile/.test(c)) out.push(`line ${start + 1}: pnpm install without --frozen-lockfile`);
        if (!/--ignore-scripts/.test(c)) out.push(`line ${start + 1}: pnpm install without --ignore-scripts`);
      } else if (/(^|\s)npm\s+(ci|install|i)(\s|$)/.test(c)) {
        if (/npm\s+(install|i)(\s|$)/.test(c) && !/npm\s+(install|i)\s+-g\s/.test(c))
          out.push(`line ${start + 1}: npm install in an image build (use npm ci --ignore-scripts)`);
        if (!/--ignore-scripts/.test(c)) out.push(`line ${start + 1}: npm ${/npm\s+ci/.test(c) ? "ci" : "install"} without --ignore-scripts`);
      }
    }
  }
  return out;
}

/** C42: Railway refuses images with a `VOLUME` instruction (it mounts volumes itself). Returns offending line numbers. */
export function dockerfileVolumeLines(text: string): number[] {
  const out: number[] = [];
  let continued = false;
  text.split(/\r?\n/).forEach((line, i) => {
    const t = line.trim();
    const isInstructionStart = !continued && t !== "" && !t.startsWith("#");
    if (isInstructionStart && /^VOLUME(\s|\[|$)/i.test(t)) out.push(i + 1);
    if (t.startsWith("#") && !continued) return;
    continued = t.endsWith("\\");
  });
  return out;
}

function findDockerfiles(root: string, dir = "", acc: string[] = []): string[] {
  for (const e of readdirSync(join(root, dir), { withFileTypes: true })) {
    if (["node_modules", ".git", ".tb-ci", "dist"].includes(e.name)) continue;
    const rel = dir ? `${dir}/${e.name}` : e.name;
    if (e.isDirectory()) findDockerfiles(root, rel, acc);
    else if (/^Dockerfile(\..+)?$|\.Dockerfile$/i.test(e.name)) acc.push(rel);
  }
  return acc;
}

export function serializeIndex(index: ReleaseIndex): string {
  return `${JSON.stringify(index, null, 2)}\n`;
}

/** Skills archive (C17): one JSON document with every manifest skill file; skillsDigest = digest(archive). */
export function skillsArchive(manifest: { skills?: { id: string; file: string }[] }, readFile: (rel: string) => string) {
  const files = (manifest.skills ?? []).map((sk) => ({ id: sk.id, file: sk.file, content: readFile(sk.file) })).sort((a, b) => a.id.localeCompare(b.id));
  return { schema: "opt2.skills-archive/v1", files };
}

/** Kaniko image-check script (push/PR events): builds every declared image, never pushes, holds no credentials. */
export function renderImagesScript(cfg: CiConfig, _repoName: string): string {
  const lines = ["#!/bin/sh", "# generated by tb-ci plan-images; runs in the kaniko debug image (busybox sh); holds no credentials", "set -eu"];
  if (cfg.images.length === 0) {
    lines.push('echo "tb-ci: no images declared in tealbrick-ci.json; nothing to build"', "exit 0");
    return `${lines.join("\n")}\n`;
  }
  for (const im of cfg.images) {
    lines.push(
      `echo "tb-ci: image ${im.name} (check)"`,
      `/kaniko/executor --no-push --context "$CI_WORKSPACE/${im.context}" --dockerfile "$CI_WORKSPACE/${im.dockerfile}" --cleanup --verbosity info`,
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
  const min = (await fetchText(`https://raw.githubusercontent.com/${OWNER}/${PLATFORM_REPO}/main/${MIN_TEMPLATE_PATH}`)).trim();
  if (belowMinimum(ref, min)) fail(`template ${ref} is below the enforced minimum ${min} (C56 D1): run adopt from the platform repo`);
  log(`template ${ref} >= minimum ${min}`);
  if (existsSync(join(root, ".woodpecker/secret-scan.yaml"))) fail(".woodpecker/secret-scan.yaml duplicates the template's secret-scan step; delete it");
  {
    const cfgEarly = loadConfig(root);
    const wfPath = join(root, GH_WORKFLOW_PATH);
    if (repoReleases(cfgEarly, root) || existsSync(wfPath)) {
      if (!existsSync(wfPath)) fail(`${GH_WORKFLOW_PATH} is required for a releasing repo (C72): re-run adopt`);
      const wfUp = await fetchText(`https://raw.githubusercontent.com/${OWNER}/${PLATFORM_REPO}/${ref}/ci/github/opt2-release.yml`);
      if (readFileSync(wfPath, "utf8") !== wfUp) fail(`${GH_WORKFLOW_PATH} differs from the platform template ${ref}; re-run adopt`);
      log(`release workflow ${ref}: identical`);
    }
  }
  const cfg = loadConfig(root);
  log(
    `kind=${cfg.kind} paths=${cfg.paths.join(",")} conformance=${cfg.conformance} postgres=${cfg.postgres} images=${cfg.images.map((i) => i.name).join(",") || "-"}`,
  );
  // ci-v9.1: the template's `postgres` step starts the database only when this marker exists (opt-in)
  mkdirSync(join(root, ".tb-ci"), { recursive: true });
  if (cfg.postgres) writeFileSync(join(root, PG_MARKER), "requested by tealbrick-ci.json\n");
  else rmSync(join(root, PG_MARKER), { force: true });
  rmSync(join(root, PG_DONE_MARKER), { force: true }); // ci-v9.2: never inherit a stale "unit finished" marker
  const errors: string[] = [];
  const urls: string[] = [];
  for (const p of cfg.paths) {
    const pj = join(root, p, "package.json");
    if (!existsSync(pj)) {
      log(`WARNING: ${p}/package.json does not exist yet; node stages skip this path`);
      continue;
    }
    const pkg = readJson(pj);
    const ws = workspacePackages(join(root, p));
    const localNames = new Set(ws.map((w) => w.name));
    errors.push(...checkPackageJson(pkg, cfg, `${p}/package.json`, ws.length > 0));
    for (const pkgJson of [{ rel: `${p}/package.json`, pkg }, ...ws.map((w) => ({ rel: `${p}/${w.rel}/package.json`, pkg: w.pkg }))]) {
      const [depErrors, depUrls] = checkDependencies(pkgJson.pkg, pkgJson.rel, localNames);
      errors.push(...depErrors);
      urls.push(...depUrls);
    }
    for (const w of ws) {
      if (w.pkg.private !== true) errors.push(`${p}/${w.rel}/package.json: "private": true is required`);
      if (w.pkg.publishConfig !== undefined) errors.push(`${p}/${w.rel}/package.json: publishConfig is not allowed`);
    }
    const pm = packageManager(join(root, p));
    if (!pm) errors.push(`${p}: a committed lockfile (pnpm-lock.yaml or package-lock.json) is required`);
    if (pm === "pnpm" && !packageManagerPinned(pkg.packageManager))
      errors.push(`${p}/package.json: "packageManager" must be "pnpm@<version>+sha512.<hex>" (C62; e.g. corepack use pnpm@9.15.4)`);
  }
  for (const im of cfg.images) {
    if (!existsSync(join(root, im.dockerfile))) errors.push(`image ${im.name}: ${im.dockerfile} not found`);
    if (im.manifest && !existsSync(join(root, im.manifest))) errors.push(`image ${im.name}: manifest ${im.manifest} not found`);
    if (im.kind === "app" && im.manifest && existsSync(join(root, im.manifest))) {
      const man = JSON.parse(readFileSync(join(root, im.manifest), "utf8")) as { runtime?: { services?: { id: string; build?: unknown }[] } };
      errors.push(...checkServiceImages(cfg, im.product, man.runtime?.services ?? []).map((e) => `image ${im.name}: ${e}`));
    }
  }
  for (const df of findDockerfiles(root)) {
    const lines = dockerfileVolumeLines(readFileSync(join(root, df), "utf8"));
    if (lines.length)
      errors.push(`${df}: VOLUME instruction on line ${lines.join(", ")} (C42: Railway mounts volumes itself; declare volumes in the manifest runtime)`);
  }
  for (const u of new Set(urls)) {
    const res = await fetch(u, { method: "HEAD", redirect: "follow" });
    if (!res.ok) errors.push(`dependency tarball not found (HTTP ${res.status}): ${u}`);
  }
  for (const p of cfg.paths) if (existsSync(join(root, p, "package.json"))) errors.push(...(await checkTarballIntegrity(join(root, p), p)));
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
    if (pm === "pnpm") sh("corepack", ["pnpm", "install", "--frozen-lockfile", "--ignore-scripts"], dir);
    else if (pm === "npm") sh("npm", ["ci", "--ignore-scripts"], dir);
    else fail(`${p}: no lockfile`);
  }
}

/** Waits until host:port accepts TCP connections (the opt-in Postgres step boots while install/typecheck/lint run). */
async function waitForTcp(host: string, port: number, timeoutMs: number): Promise<void> {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const ok = await new Promise<boolean>((done) => {
      const s = createConnection({ host, port });
      s.setTimeout(2000);
      s.once("connect", () => {
        s.destroy();
        done(true);
      });
      s.once("timeout", () => {
        s.destroy();
        done(false);
      });
      s.once("error", () => done(false));
    });
    if (ok) return;
    if (Date.now() > until) fail(`postgres: ${host}:${port} not reachable after ${timeoutMs / 1000}s (tealbrick-ci.json postgres=true)`);
    await new Promise((r) => setTimeout(r, 1000));
  }
}

async function cmdRun(script: string | undefined): Promise<void> {
  if (!script || !["typecheck", "lint", "test", "conformance", "build"].includes(script)) fail("usage: run typecheck|lint|test|conformance|build");
  const root = repoRoot();
  const cfg = loadConfig(root);
  if (script === "conformance" && !cfg.conformance) {
    log("SKIP conformance: not required for this repo (tealbrick-ci.json conformance=false)");
    return;
  }
  if (script === "test" && cfg.postgres) {
    // ci-v9.2: tell the postgres step to stop itself, however this process ends (pass, fail, process.exit, throw)
    process.on("exit", () => {
      try {
        writeFileSync(join(root, PG_DONE_MARKER), "unit step finished\n");
      } catch {
        /* the step's 1 h cap still stops it */
      }
    });
  }
  const paths = nodePaths(cfg, root);
  if (paths.length === 0) {
    log(`SKIP ${script}: no package.json yet`);
    return;
  }
  const env = script === "test" ? testEnv(cfg, process.env) : process.env;
  if (script === "test" && cfg.postgres) {
    await waitForTcp("postgres", 5432, 90_000);
    log("postgres reachable; TB_TEST_DATABASE_URL is set");
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
    if (packageManager(dir) === "pnpm") sh("corepack", ["pnpm", "run", script], dir, env);
    else sh("npm", ["run", script], dir, env);
  }
}

function pmExec(dir: string, bin: string, args: string[]): void {
  if (packageManager(dir) === "pnpm") sh("corepack", ["pnpm", "exec", bin, ...args], dir);
  else sh("npm", ["exec", "--no", "--", bin, ...args], dir);
}

/** BSA-03 gen stage: (1) a committed gen/ must not be stale, (2) the repo's `gen` script must really run `tb-gen all`, (3) the result passes `tb-gen check`. */
function cmdGen(): void {
  const root = repoRoot();
  const cfg = loadConfig(root);
  for (const p of nodePaths(cfg, root)) {
    const dir = join(root, p);
    const scripts = (readJson(join(dir, "package.json")).scripts ?? {}) as Record<string, string>;
    const manifestPath = join(dir, MANIFEST_FILE);
    if (!scripts.gen) {
      if (cfg.kind === "miniapp") fail(`${p}: script "gen" is required for kind miniapp ("gen": "tb-gen all")`);
      log(`SKIP gen in ${p}: no gen script`);
      continue;
    }
    if (!existsSync(manifestPath)) fail(`${p}: ${MANIFEST_FILE} is required for the gen stage`);
    const product = String((JSON.parse(readFileSync(manifestPath, "utf8")) as { id?: string }).id);
    if (existsSync(join(dir, "gen"))) pmExec(dir, "tb-gen", ["check"]); // committed gen/ must equal the manifest
    sh(packageManager(dir) === "pnpm" ? "corepack" : "npm", packageManager(dir) === "pnpm" ? ["pnpm", "run", "gen"] : ["run", "gen"], dir);
    const missing = expectedGenFiles(product).filter((f) => !existsSync(join(dir, "gen", f)));
    if (missing.length) fail(`${p}: the gen script did not produce ${missing.map((f) => `gen/${f}`).join(", ")} (it must run tb-gen all)`);
    pmExec(dir, "tb-gen", ["check"]);
    log(`gen OK in ${p} (${product})`);
  }
}

/** Collects `<dir>/*.tgz` built by an earlier tokenless step: [file name, bytes]. Names are checked, content is the repo's own. */
function builtTarballs(dir: string, nameRe: RegExp): [string, Buffer][] {
  if (!existsSync(dir)) return [];
  const out: [string, Buffer][] = [];
  for (const sub of readdirSync(dir, { withFileTypes: true })) {
    const files = sub.isDirectory() ? readdirSync(join(dir, sub.name)).map((f) => join(sub.name, f)) : [sub.name];
    for (const rel of files) {
      const name = rel.split("/").pop() as string;
      if (!name.endsWith(".tgz")) continue;
      if (!nameRe.test(name)) fail(`unexpected tarball name ${name}`);
      out.push([name, readFileSync(join(dir, rel))]);
    }
  }
  return out;
}

/** D1/C56: report every opt2 repo's template ref on main; fails if any is missing or below the minimum. */
async function cmdAuditTemplates(): Promise<void> {
  const min = (await fetchText(`https://raw.githubusercontent.com/${OWNER}/${PLATFORM_REPO}/main/${MIN_TEMPLATE_PATH}`)).trim();
  const bad: string[] = [];
  for (const repo of OPT2_REPOS) {
    const res = await fetch(`https://raw.githubusercontent.com/${OWNER}/${repo}/main/.woodpecker/ci.yaml`);
    const ref = res.ok ? (/TB_CI_REF: (\S+)/.exec(await res.text())?.[1] ?? "none") : "none";
    const ok = !belowMinimum(ref, min);
    log(`${ok ? "OK  " : "FAIL"} ${repo}: ${ref}`);
    if (!ok) bad.push(`${repo} (${ref})`);
  }
  if (bad.length) fail(`below minimum ${min}: ${bad.join(", ")}`);
  log(`all ${OPT2_REPOS.length} repos at or above ${min}`);
}

// ---------- GitHub Actions release publishing (C72): no personal token ----------

export const GH_WORKFLOW_PATH = ".github/workflows/opt2-release.yml";
const KIT_NAME_RE = /^opt2-tealbrick-[a-z0-9-]+-kit-\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?\.tgz$/;
const PKG_NAME_RE = /^[a-z0-9-]+-\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?\.tgz$/;

/** A repo publishes releases when it declares images, is a miniapp (kit) or is a pnpm workspace (package tarballs). */
export function repoReleases(cfg: CiConfig, root: string): boolean {
  return cfg.images.length > 0 || cfg.kind === "miniapp" || cfg.paths.some((p) => existsSync(join(root, p, "pnpm-workspace.yaml")));
}

export interface GhPlan {
  schema: "opt2.gh-release-plan/v1";
  repo: string;
  tag: string;
  commit: string;
  images: { name: string; tar: string; version: string }[];
  assets: string[]; // file names in assets/
}

/** Build job (read-only token): docker build each image to a tarball with OCI labels, build the kit, pack the package. */
async function cmdGhBuild(): Promise<void> {
  const root = repoRoot();
  const cfg = loadConfig(root);
  const repo = repoName(root);
  const tag = process.env.CI_COMMIT_TAG;
  const commit = process.env.CI_COMMIT_SHA;
  if (!tag || !commit || !/^[0-9a-f]{40}$/.test(commit)) fail("gh-build needs CI_COMMIT_TAG and CI_COMMIT_SHA");
  for (const k of ["GITHUB_TOKEN", "GH_TOKEN", "GHCR_TOKEN"]) if (process.env[k]) fail(`C72: gh-build must run without ${k}`);
  const out = join(root, ".tb-ci/out");
  mkdirSync(join(out, "images"), { recursive: true });
  mkdirSync(join(out, "assets"), { recursive: true });
  const plan: GhPlan = { schema: "opt2.gh-release-plan/v1", repo, tag, commit, images: [], assets: [] };
  const appTag = /^v(\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?)$/.exec(tag);
  if (appTag) {
    const version = appTag[1];
    for (const im of cfg.images) {
      const ref = `${IMAGE_NAMESPACE}/${im.name}:${version}`;
      sh(
        "docker",
        [
          "build",
          "-f",
          im.dockerfile,
          "-t",
          ref,
          "--label",
          `org.opencontainers.image.source=https://github.com/${OWNER}/${repo}`,
          "--label",
          `org.opencontainers.image.revision=${commit}`,
          "--label",
          `org.opencontainers.image.version=${version}`,
          im.context,
        ],
        root,
      );
      sh("docker", ["save", "-o", join(out, "images", `${im.name}.tar`), ref], root);
      plan.images.push({ name: im.name, tar: `images/${im.name}.tar`, version });
    }
    if (cfg.kind === "miniapp") {
      for (const p of nodePaths(cfg, root)) {
        const dir = join(root, p);
        if (packageManager(dir) === "pnpm") sh("corepack", ["pnpm", "install", "--frozen-lockfile", "--ignore-scripts"], dir);
        else sh("npm", ["ci", "--ignore-scripts"], dir);
        pmExec(dir, "tb-gen", ["kit", "--build", "--out", join(out, "assets")]);
      }
    }
  } else {
    let parsed: { dir: string; version: string } | null = null;
    try {
      parsed = parsePackageTag(tag);
    } catch {
      parsed = null;
    }
    if (parsed && !(repo === PLATFORM_REPO && tag.startsWith("ci-v"))) {
      const target = packTarget(cfg, root, tag);
      const rootScripts = (readJson(join(target.projectDir, "package.json")).scripts ?? {}) as Record<string, unknown>;
      const dirs = nodePaths(cfg, root).map((p) => ({ dir: join(root, p), pm: packageManager(join(root, p)) }));
      // ci-v9.1 (C75): install, then BUILD, then pack (still read-only token); the pack guard checks dist/ is in the tarball
      for (const c of packageReleaseCommands(dirs, target.projectDir, rootScripts, target.name)) sh(c.cmd, c.args, c.cwd);
      await cmdPackagePack();
      for (const [name, data] of builtTarballs(join(root, ".tb-ci/pack"), PKG_NAME_RE)) writeFileSync(join(out, "assets", name), data);
    }
  }
  plan.assets = readdirSync(join(out, "assets")).filter((f) => f.endsWith(".tgz"));
  writeFileSync(join(out, "plan.json"), `${JSON.stringify(plan, null, 2)}\n`);
  log(`gh-build: ${plan.images.length} image(s), ${plan.assets.length} asset(s)`);
}

/** Publish job (packages: write, contents: write): runs no repo code. Pushes images, prints digests, attaches assets. */
async function cmdGhPublish(): Promise<void> {
  const out = resolve(process.env.TB_OUT ?? "out");
  const repo = process.env.CI_REPO_NAME;
  const tag = process.env.CI_COMMIT_TAG;
  const commit = process.env.CI_COMMIT_SHA;
  const token = process.env.GITHUB_TOKEN;
  if (!repo || !tag || !commit || !token) fail("gh-publish needs CI_REPO_NAME, CI_COMMIT_TAG, CI_COMMIT_SHA, GITHUB_TOKEN");
  const plan = JSON.parse(readFileSync(join(out, "plan.json"), "utf8")) as GhPlan;
  if (plan.schema !== "opt2.gh-release-plan/v1" || plan.repo !== repo || plan.tag !== tag || plan.commit !== commit) fail("plan does not match this run");
  if (plan.images.length) {
    execFileSync("docker", ["login", REGISTRY_HOST, "-u", process.env.GH_ACTOR ?? OWNER, "--password-stdin"], {
      input: token,
      stdio: ["pipe", "inherit", "inherit"],
    });
    for (const im of plan.images) {
      if (!/^[a-z0-9][a-z0-9-]*$/.test(im.name) || !(im.name === repo || im.name.startsWith(`${repo}-`))) fail(`image ${im.name} does not belong to ${repo}`);
      if (im.tar !== `images/${im.name}.tar`) fail(`unexpected tar path ${im.tar}`);
      const ref = `${IMAGE_NAMESPACE}/${im.name}:${im.version}`;
      execFileSync("docker", ["load", "-i", join(out, im.tar)], { stdio: "inherit" });
      execFileSync("docker", ["tag", ref, `${IMAGE_NAMESPACE}/${im.name}:sha-${commit}`], { stdio: "inherit" });
      execFileSync("docker", ["push", ref], { stdio: "inherit" });
      execFileSync("docker", ["push", `${IMAGE_NAMESPACE}/${im.name}:sha-${commit}`], { stdio: "inherit" });
      const digest = execFileSync("docker", ["inspect", "--format", "{{index .RepoDigests 0}}", ref], { encoding: "utf8" }).trim();
      log(`pushed ${digest} (the platform signer re-resolves digests in ghcr; this line is information only)`);
    }
    execFileSync("docker", ["logout", REGISTRY_HOST], { stdio: "inherit" });
  }
  if (plan.assets.length) {
    const prerelease = /-v?\d+\.\d+\.\d+-/.test(tag) || /^v\d+\.\d+\.\d+-/.test(tag);
    const releaseId = await ensureRelease(repo, tag, prerelease);
    for (const name of plan.assets) {
      if (!KIT_NAME_RE.test(name) && !PKG_NAME_RE.test(name)) fail(`unexpected asset name ${name}`);
      const data = readFileSync(join(out, "assets", name));
      const sums = assetChecksums(name, data);
      await uploadFile(repo, releaseId, name, data, "application/gzip");
      for (const f of sums.files) await uploadFile(repo, releaseId, f.name, Buffer.from(f.body), "text/plain");
      log(`attached ${name} (sha256 ${sums.sha256}, integrity ${sums.integrity})`);
    }
  }
  log(`gh-publish: done (${plan.images.length} image(s), ${plan.assets.length} asset(s))`);
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
  extra: { host?: string; contentType?: string; raw?: string | Buffer } = {},
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
    body: (extra.raw ?? (body !== undefined ? JSON.stringify(body) : undefined)) as BodyInit | undefined,
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

async function ensureRelease(repo: string, tag: string, prerelease: boolean, target?: string): Promise<number> {
  const got = await gh("GET", `/repos/${OWNER}/${repo}/releases/tags/${tag}`);
  if (got.status === 200) return got.json.id as number;
  const made = await gh("POST", `/repos/${OWNER}/${repo}/releases`, { tag_name: tag, name: tag, prerelease, ...(target ? { target_commitish: target } : {}) });
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

/** ci-v9.3: the lockfile npm wrote for the release-record packages must hold exactly the pinned integrity of both tarballs. */
export function lockPinProblems(lock: { packages?: Record<string, { integrity?: string }> }, pins: { manifest: string; spec: string }): string[] {
  const out: string[] = [];
  if (lock.packages?.["node_modules/@opt2-tealbrick/manifest"]?.integrity !== pins.manifest)
    out.push("installed @opt2-tealbrick/manifest differs from TB_MANIFEST_INTEGRITY (C62)");
  if (lock.packages?.["node_modules/@opt2-tealbrick/spec"]?.integrity !== pins.spec)
    out.push("installed @opt2-tealbrick/spec differs from TB_SPEC_INTEGRITY (ci-v9.3)");
  return out;
}

export async function loadManifestPkg(root: string): Promise<ManifestPkg> {
  const override = process.env.TB_MANIFEST_MODULE; // local path to a built package (development)
  let entry: string;
  if (override) {
    entry = resolve(override);
  } else {
    const url = process.env.TB_MANIFEST_PKG;
    const want = process.env.TB_MANIFEST_INTEGRITY;
    if (!url || !RELEASE_URL_RE.test(url)) fail("TB_MANIFEST_PKG must be the @opt2-tealbrick/manifest GitHub release tarball URL");
    if (!want || !/^sha512-[A-Za-z0-9+/]+=*$/.test(want)) fail("TB_MANIFEST_INTEGRITY (sha512-…) is required with TB_MANIFEST_PKG (C62)");
    const res = await fetch(url, { redirect: "follow" });
    if (!res.ok) fail(`TB_MANIFEST_PKG: HTTP ${res.status}`);
    const data = new Uint8Array(await res.arrayBuffer());
    if (sha512Integrity(data) !== want) fail("TB_MANIFEST_PKG does not match TB_MANIFEST_INTEGRITY (C62): refusing to load it");
    // ci-v9.3: the manifest package depends on @opt2-tealbrick/spec by a GitHub URL, which npm would fetch WITHOUT integrity.
    // The spec tarball is pinned here the same way (sha512 checked before install) and an npm override makes the manifest
    // package use exactly that file. The lockfile npm writes is read back, so a different spec or manifest can never load.
    const specUrl = process.env.TB_SPEC_PKG;
    const specWant = process.env.TB_SPEC_INTEGRITY;
    if (!specUrl || !SPEC_URL_RE.test(specUrl)) fail("TB_SPEC_PKG must be the @opt2-tealbrick/spec GitHub release tarball URL (ci-v9.3)");
    if (!specWant || !/^sha512-[A-Za-z0-9+/]+=*$/.test(specWant)) fail("TB_SPEC_INTEGRITY (sha512-…) is required with TB_SPEC_PKG (ci-v9.3)");
    const specRes = await fetch(specUrl, { redirect: "follow" });
    if (!specRes.ok) fail(`TB_SPEC_PKG: HTTP ${specRes.status}`);
    const specData = new Uint8Array(await specRes.arrayBuffer());
    if (sha512Integrity(specData) !== specWant) fail("TB_SPEC_PKG does not match TB_SPEC_INTEGRITY (ci-v9.3): refusing to load it");
    const dir = join(root, ".tb-ci/pkgs");
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "package.json"), JSON.stringify({ private: true, overrides: { "@opt2-tealbrick/spec": "file:./spec.tgz" } }) + "\n");
    writeFileSync(join(dir, "manifest.tgz"), data);
    writeFileSync(join(dir, "spec.tgz"), specData);
    sh("npm", ["install", "--no-audit", "--no-fund", "--ignore-scripts", "./manifest.tgz"], dir);
    const lock = readJson(join(dir, "package-lock.json")) as { packages?: Record<string, { integrity?: string }> };
    const problems = lockPinProblems(lock, { manifest: want, spec: specWant });
    if (problems.length > 0) fail(`${problems.join("; ")}: refusing to load it`);
    const pkgDir = join(dir, "node_modules/@opt2-tealbrick/manifest");
    const pj = readJson(join(pkgDir, "package.json")) as { exports?: unknown; main?: string };
    const ex = pj.exports as Record<string, unknown> | string | undefined;
    const dot = typeof ex === "string" ? ex : ((ex?.["."] ?? ex) as Record<string, string> | string | undefined);
    const rel = typeof dot === "string" ? dot : (dot?.import ?? dot?.default ?? pj.main);
    if (!rel) fail("cannot find the entry point of @opt2-tealbrick/manifest");
    entry = join(pkgDir, rel);
  }
  const mod = (await import(pathToFileURL(entry).href)) as Partial<ManifestPkg>;
  for (const f of ["digest", "manifestDigest", "validateManifest", "thumbprint", "signReleaseIndex", "verifyReleaseIndex", "keySetFrom"] as const)
    if (typeof mod[f] !== "function") fail(`@opt2-tealbrick/manifest does not export ${f}`);
  return mod as ManifestPkg;
}

async function loadSigningKey(m: ManifestPkg): Promise<{ publicJwk: JsonWebKey; privateKey: CryptoKey; kid: string }> {
  const pem = process.env.RELEASE_SIGNING_KEY ?? (process.env.RELEASE_SIGNING_KEY_FILE ? readFileSync(process.env.RELEASE_SIGNING_KEY_FILE, "utf8") : "");
  if (!pem) fail("RELEASE_SIGNING_KEY (Woodpecker secret release_signing_key) or RELEASE_SIGNING_KEY_FILE is missing");
  const priv = createPrivateKey(pem);
  const publicJwk = createPublicKey(priv).export({ format: "jwk" }) as JsonWebKey;
  const der = priv.export({ type: "pkcs8", format: "der" });
  const privateKey = await crypto.subtle.importKey("pkcs8", der, { name: "Ed25519" }, false, ["sign"]);
  return { publicJwk, privateKey, kid: m.thumbprint(publicJwk) };
}

async function ghFile(path: string, ref: string): Promise<string | null> {
  const r = await gh("GET", `/repos/${OWNER}/${PLATFORM_REPO}/contents/${path}?ref=${ref}`);
  if (r.status === 404) return null;
  if (r.status !== 200) fail(`read ${path}: HTTP ${r.status}`);
  return Buffer.from(r.json.content as string, "base64").toString("utf8");
}

/** Read index + offers at main, merge, re-sign with the manifest package, commit to main (fast-forward), publish release assets. */
async function publishIndex(m: ManifestPkg | null, add: IndexRelease[]): Promise<void> {
  // Unsigned mode exists only until the spec defines the release-index typ (REQUESTS "platform: release index typ").
  const signed = process.env.TB_REGISTRY_UNSIGNED !== "1";
  if (signed && !m) fail("signing needs @opt2-tealbrick/manifest");
  const key = signed && m ? await loadSigningKey(m) : null;
  if (key && m) {
    const pubKeys = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../registry/keys.json"), "utf8")) as { keys: JsonWebKey[] };
    if (!pubKeys.keys.some((k) => m.thumbprint(k) === key.kid)) fail(`signing key ${key.kid} is not in registry/keys.json`);
  }
  for (let attempt = 1; attempt <= 5; attempt++) {
    const ref = await gh("GET", `/repos/${OWNER}/${PLATFORM_REPO}/git/ref/heads/main`);
    if (ref.status !== 200) fail(`registry: read main: HTTP ${ref.status}`);
    const headSha = ref.json.object.sha as string;
    const prevText = await ghFile(INDEX_PATH, headSha);
    const prev = prevText ? (JSON.parse(prevText) as ReleaseIndex) : null;
    if (prev && prev.schema !== INDEX_SCHEMA) fail(`registry: unexpected schema ${prev.schema}`);
    const offersText = await ghFile(OFFERS_PATH, headSha);
    const offers = validateOffers(offersText ? JSON.parse(offersText) : []);
    const harnessesText = await ghFile(HARNESSES_PATH, headSha);
    const harnesses = validateHarnesses(harnessesText ? JSON.parse(harnessesText) : []);
    const devOnlyNotes = normalizeDevOnly(prev?.releases ?? []).notes; // C113: what this publish changes in existing records
    const index = mergeIndex(prev, add, offers, new Date().toISOString(), harnesses);
    const body = serializeIndex(index);
    let jws: string | null = null;
    if (key && m) {
      const nowS = Math.floor(Date.now() / 1000);
      const token = await m.signReleaseIndex(index, { iat: nowS }, key);
      const keys = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../registry/keys.json"), "utf8")) as { keys: JsonWebKey[] };
      const check = m.verifyReleaseIndex(token, JSON.parse(body) as ReleaseIndex, { now: nowS, keys: m.keySetFrom(keys, INDEX_ISS) });
      if (!check.ok) fail(`registry: self-verification of the signed index failed: ${check.reason ?? "refused"}`);
      jws = `${token}\n`;
    }
    const commit = await gh("GET", `/repos/${OWNER}/${PLATFORM_REPO}/git/commits/${headSha}`);
    const hasEnvelope = (await ghFile(ENVELOPE_PATH, headSha)) !== null;
    const tree = await gh("POST", `/repos/${OWNER}/${PLATFORM_REPO}/git/trees`, {
      base_tree: commit.json.tree.sha,
      tree: [
        { path: INDEX_PATH, mode: "100644", type: "blob", content: body },
        ...(jws
          ? [{ path: ENVELOPE_PATH, mode: "100644", type: "blob", content: jws }]
          : hasEnvelope
            ? [{ path: ENVELOPE_PATH, mode: "100644", type: "blob", sha: null }]
            : []),
      ],
    });
    if (tree.status !== 201) fail(`registry: create tree: HTTP ${tree.status}`);
    const msg = `${add.length ? `registry: ${add.map((r) => `${r.product}@${r.version}`).join(", ")}` : "registry: re-publish"}${jws ? "" : " (UNSIGNED interim)"}${
      devOnlyNotes.length ? `\n\nC113 (DEV_ONLY_PRODUCTS, digests unchanged):\n${devOnlyNotes.map((n) => `- ${n}`).join("\n")}` : ""
    }`;
    const nc = await gh("POST", `/repos/${OWNER}/${PLATFORM_REPO}/git/commits`, { message: msg, tree: tree.json.sha, parents: [headSha] });
    if (nc.status !== 201) fail(`registry: create commit: HTTP ${nc.status}`);
    const upd = await gh("PATCH", `/repos/${OWNER}/${PLATFORM_REPO}/git/refs/heads/main`, { sha: nc.json.sha, force: false });
    if (upd.status === 200) {
      const rel = await ensureRelease(PLATFORM_REPO, REGISTRY_RELEASE_TAG, false, nc.json.sha as string);
      await uploadAsset(PLATFORM_REPO, rel, "index.json", body);
      if (jws) await uploadAsset(PLATFORM_REPO, rel, "index.jws", jws);
      // D12/C30: the public verification key set travels with the index.
      const keysText = await ghFile("registry/keys.json", nc.json.sha as string);
      if (keysText) await uploadAsset(PLATFORM_REPO, rel, "keys.json", keysText);
      log(`${msg}; published https://github.com/${OWNER}/${PLATFORM_REPO}/releases/download/${REGISTRY_RELEASE_TAG}/${jws ? "index.jws" : "index.json"}`);
      return;
    }
    log(`registry: main moved (HTTP ${upd.status}), retry ${attempt}/5`);
    await new Promise((r) => setTimeout(r, 1000 * attempt));
  }
  fail("registry: could not fast-forward main after 5 attempts");
}

/** SEC-03 (C59): what a product tag pipeline may claim. It holds NO signature and no derived digests the signer trusts:
 *  the platform signer re-derives manifest/skills/runtime from the repo at `commit` and checks every image in the registry. */
export interface ReleaseCandidate {
  product: string;
  kind: "app" | "bridge";
  version: string;
  image: string; // ghcr.io/martin-atrin/<name>@sha256:<hex>
  services: { id: string; image: string }[];
  manifest: string | null; // repo-relative manifest path (apps)
  runtimeFile: string | null; // repo-relative bridge-runtime.json (bridge)
  upgradeFrom: string;
}
export interface ReleaseCandidateDoc {
  schema: "opt2.release-candidate/v1";
  repo: string; // owner/name
  tag: string;
  commit: string;
  candidates: ReleaseCandidate[];
}

/** Product tag pipeline (C62): validate the release locally and print it. No token, no signing key, no network writes.
 *  The platform signer discovers the tag itself, resolves image digests from ghcr and re-derives everything. */
async function cmdReleaseRecord(): Promise<void> {
  const root = repoRoot();
  const cfg = loadConfig(root);
  const tag = process.env.CI_COMMIT_TAG;
  if (!tag) fail("release-record runs on tag events only");
  for (const k of ["RELEASE_SIGNING_KEY", "RELEASE_SIGNING_KEY_FILE", "GITHUB_TOKEN", "GHCR_TOKEN"])
    if (process.env[k]) fail(`C62/SEC-03: release-record must run without ${k}`);
  let version: string;
  try {
    version = versionFromTag(tag);
  } catch (e) {
    fail((e as Error).message);
  }
  const entries = cfg.images.filter((im) => im.kind === "app" || im.kind === "bridge");
  if (entries.length === 0) {
    log("no app/bridge images declared: nothing for the release index");
    return;
  }
  const m = await loadManifestPkg(root);
  for (const im of entries) {
    if (im.manifest) {
      const v = m.validateManifest(JSON.parse(readFileSync(join(root, im.manifest), "utf8")));
      if (!v.ok) fail(`${im.manifest} is invalid: ${JSON.stringify(v.errors).slice(0, 2000)}`);
      const man = v.manifest as { id?: string; version?: string; runtime?: { services?: { id: string; build?: unknown }[] } };
      if (man.id !== im.product || man.version !== version) fail(`manifest ${man.id}@${man.version} != ${im.product}@${version}`);
      const svcErrs = checkServiceImages(cfg, im.product, man.runtime?.services ?? []);
      if (svcErrs.length) fail(svcErrs.join("; "));
      log(`candidate ${im.product}@${version}: manifestDigest ${m.manifestDigest(v.manifest)}`);
    }
    if (im.kind === "bridge") validateBridgeRuntime(JSON.parse(readFileSync(join(root, dirname(im.dockerfile), "bridge-runtime.json"), "utf8")));
    const digest = existsSync(join(root, ".tb-ci/digests", `${im.name}.digest`))
      ? readFileSync(join(root, ".tb-ci/digests", `${im.name}.digest`), "utf8").trim()
      : "(see image-push)";
    log(`candidate ${im.product}@${version} (${im.kind}) ${IMAGE_NAMESPACE}/${im.name}@${digest}; the platform signer verifies and indexes it`);
  }
}

/** What the signer derives for one tag (SEC-03, C62): no product-written document is trusted. */
export interface ReleaseCandidate {
  product: string;
  kind: "app" | "bridge";
  version: string;
  image: string; // ghcr.io/martin-atrin/<name>@sha256:<hex>
  services: { id: string; image: string }[];
  manifest: string | null;
  runtimeFile: string | null;
  upgradeFrom: string;
}
export interface ReleaseCandidateDoc {
  schema: "opt2.release-candidate/v1";
  repo: string;
  tag: string;
  commit: string;
  candidates: ReleaseCandidate[];
}

// ---------- platform signer (SEC-03): runs only platform code, never product repo or dependency code ----------

const GHCR_ACCEPT = [
  "application/vnd.oci.image.index.v1+json",
  "application/vnd.oci.image.manifest.v1+json",
  "application/vnd.docker.distribution.manifest.list.v2+json",
  "application/vnd.docker.distribution.manifest.v2+json",
].join(", ");

/** Checks a public ghcr image by digest: it exists and its OCI labels bind it to this repo + commit. */
export async function verifyImageProvenance(ref: string, repo: string, commit: string, fetcher: typeof fetch = fetch): Promise<string | null> {
  const m = /^ghcr\.io\/(martin-atrin\/[a-z0-9-]+)@(sha256:[0-9a-f]{64})$/.exec(ref);
  if (!m) return `bad image ref ${ref}`;
  const [, name, digest] = m;
  if (!name.endsWith(`/${repo.split("/")[1]}`) && !name.slice("martin-atrin/".length).startsWith(`${repo.split("/")[1]}-`))
    return `${ref}: image name does not belong to ${repo}`;
  const tokRes = await fetcher(`https://ghcr.io/token?scope=repository:${name}:pull`);
  if (!tokRes.ok) return `${ref}: no pull token (package private?) HTTP ${tokRes.status}`;
  const token = ((await tokRes.json()) as { token: string }).token;
  const get = (path: string, accept = GHCR_ACCEPT) => fetcher(`https://ghcr.io/v2/${name}/${path}`, { headers: { authorization: `Bearer ${token}`, accept } });
  let res = await get(`manifests/${digest}`);
  if (!res.ok) return `${ref}: manifest not found HTTP ${res.status}`;
  let man = (await res.json()) as {
    mediaType?: string;
    manifests?: { digest: string; platform?: { os: string; architecture: string } }[];
    config?: { digest: string };
  };
  if (man.manifests) {
    const amd = man.manifests.find((x) => x.platform?.os === "linux" && x.platform?.architecture === "amd64");
    if (!amd) return `${ref}: no linux/amd64 image in the index`;
    res = await get(`manifests/${amd.digest}`);
    if (!res.ok) return `${ref}: platform manifest HTTP ${res.status}`;
    man = await res.json();
  }
  if (!man.config?.digest) return `${ref}: manifest has no config`;
  const cfgRes = await get(`blobs/${man.config.digest}`, "*/*");
  if (!cfgRes.ok) return `${ref}: config blob HTTP ${cfgRes.status}`;
  const labels = ((await cfgRes.json()) as { config?: { Labels?: Record<string, string> } }).config?.Labels ?? {};
  if (labels["org.opencontainers.image.revision"] !== commit) return `${ref}: revision label ${labels["org.opencontainers.image.revision"]} != ${commit}`;
  if (labels["org.opencontainers.image.source"] !== `https://github.com/${repo}`)
    return `${ref}: source label ${labels["org.opencontainers.image.source"]} != https://github.com/${repo}`;
  return null;
}

async function rawAt(repo: string, commit: string, path: string): Promise<string> {
  const r = await fetch(`https://raw.githubusercontent.com/${repo}/${commit}/${path}`);
  if (!r.ok) throw new Error(`${path} not found at ${repo}@${commit} (HTTP ${r.status})`);
  return r.text();
}

/** Re-derives one index entry from the repo at the tag commit + the registry; returns the entry or a rejection. */
async function verifyCandidate(m: ManifestPkg, doc: ReleaseCandidateDoc, c: ReleaseCandidate): Promise<IndexRelease | string> {
  try {
    const ref = await gh("GET", `/repos/${doc.repo}/git/ref/tags/${encodeURIComponent(doc.tag)}`);
    if (ref.status !== 200) return `tag ${doc.tag} not found`;
    let sha = ref.json.object.sha as string;
    if (ref.json.object.type === "tag") sha = (await gh("GET", `/repos/${doc.repo}/git/tags/${sha}`)).json.object.sha;
    if (sha !== doc.commit) return `tag ${doc.tag} points to ${sha}, candidate says ${doc.commit}`;
    if (versionFromTag(doc.tag) !== c.version) return `version ${c.version} != tag ${doc.tag}`;
    let manifestDigest: string | null = null;
    let skillsDigest: string | null = null;
    let manifestUrl: string | null = null;
    let declaredServices: string[] = [];
    if (c.kind === "app") {
      if (!c.manifest || !safeRel(c.manifest)) return "app candidate without a safe manifest path";
      const v = m.validateManifest(JSON.parse(await rawAt(doc.repo, doc.commit, c.manifest)));
      if (!v.ok) return `manifest invalid at ${doc.commit}`;
      const man = v.manifest as {
        id?: string;
        version?: string;
        skills?: { id: string; file: string }[];
        runtime?: { services?: { id: string; build?: unknown }[] };
      };
      if (man.id !== c.product || man.version !== c.version) return `manifest ${man.id}@${man.version} != ${c.product}@${c.version}`;
      manifestDigest = m.manifestDigest(v.manifest);
      manifestUrl = `https://raw.githubusercontent.com/${doc.repo}/${doc.commit}/${c.manifest}`;
      const base = c.manifest.includes("/") ? c.manifest.slice(0, c.manifest.lastIndexOf("/") + 1) : "";
      const files = new Map<string, string>();
      for (const sk of man.skills ?? []) files.set(sk.file, await rawAt(doc.repo, doc.commit, base + sk.file));
      skillsDigest = m.digest(skillsArchive(man, (f) => files.get(f) ?? ""));
      declaredServices = (man.runtime?.services ?? [])
        .filter((x) => x.build)
        .map((x) => x.id)
        .sort();
    }
    const got = c.services.map((x) => x.id).sort();
    if (JSON.stringify(got) !== JSON.stringify(declaredServices)) return `service images [${got}] != manifest services with build [${declaredServices}]`;
    let runtime: BridgeRuntime | null = null;
    if (c.kind === "bridge") {
      if (!c.runtimeFile || !safeRel(c.runtimeFile)) return "bridge candidate without a safe runtime file path";
      runtime = validateBridgeRuntime(JSON.parse(await rawAt(doc.repo, doc.commit, c.runtimeFile)));
    }
    for (const img of [c.image, ...c.services.map((x) => x.image)]) {
      const problem = await verifyImageProvenance(img, doc.repo, doc.commit);
      if (problem) return problem;
    }
    return {
      id: newId("rel"),
      product: c.product,
      kind: c.kind,
      version: c.version,
      channel: releaseChannel(c.product, c.version),
      manifestDigest,
      manifestUrl,
      skillsDigest,
      image: c.image,
      artifact: null,
      source: null,
      runtime,
      services: c.kind === "app" ? c.services : null,
      minOs: null,
      notarized: null,
      upgradeFrom: c.upgradeFrom,
      repo: doc.repo,
      commit: doc.commit,
      tag: doc.tag,
      publishedAt: new Date().toISOString(),
    };
  } catch (e) {
    return (e as Error).message;
  }
}

/** Resolves a public ghcr tag to its manifest digest (null = not published yet). */
export async function ghcrDigest(name: string, tag: string, fetcher: typeof fetch = fetch): Promise<string | null> {
  const tok = await fetcher(`https://ghcr.io/token?scope=repository:martin-atrin/${name}:pull`);
  if (!tok.ok) return null;
  const token = ((await tok.json()) as { token: string }).token;
  const res = await fetcher(`https://ghcr.io/v2/martin-atrin/${name}/manifests/${tag}`, {
    method: "HEAD",
    headers: { authorization: `Bearer ${token}`, accept: GHCR_ACCEPT },
  });
  if (!res.ok) return null;
  const d = res.headers.get("docker-content-digest");
  return d && /^sha256:[0-9a-f]{64}$/.test(d) ? d : null;
}

/** Builds the candidate for one product tag from the repo at that commit + ghcr; null = images not published (pending). */
async function candidateFromTag(repo: string, tag: string, commit: string): Promise<ReleaseCandidateDoc | null> {
  const version = versionFromTag(tag);
  const cfgText = await rawAt(`${OWNER}/${repo}`, commit, "tealbrick-ci.json").catch(() => null);
  if (!cfgText) return null;
  let cfg: CiConfig;
  try {
    cfg = validateConfig(JSON.parse(cfgText), repo);
  } catch {
    return null; // tag predates the current tealbrick-ci.json schema: it cannot carry Actions-built images
  }
  const candidates: ReleaseCandidate[] = [];
  for (const im of cfg.images.filter((x) => x.kind === "app" || x.kind === "bridge")) {
    const d = await ghcrDigest(im.name, version);
    if (!d) return null;
    const services: { id: string; image: string }[] = [];
    for (const sv of cfg.images.filter((x) => x.kind === "service" && x.product === im.product)) {
      const sd = await ghcrDigest(sv.name, version);
      if (!sd) return null;
      services.push({ id: sv.service as string, image: `${IMAGE_NAMESPACE}/${sv.name}@${sd}` });
    }
    candidates.push({
      product: im.product,
      kind: im.kind === "bridge" ? "bridge" : "app",
      version,
      image: `${IMAGE_NAMESPACE}/${im.name}@${d}`,
      services: services.sort((a, b) => a.id.localeCompare(b.id)),
      manifest: im.manifest ?? null,
      runtimeFile: im.kind === "bridge" ? `${dirname(im.dockerfile)}/bridge-runtime.json` : null,
      upgradeFrom: im.upgradeFrom,
    });
  }
  return candidates.length ? { schema: "opt2.release-candidate/v1", repo: `${OWNER}/${repo}`, tag, commit, candidates } : null;
}

/** Platform signer pipeline (cron/manual, platform repo only, holds release_signing_key):
 *  discover v* tags in the opt2 repos, derive and verify each release independently, add them, re-sign when anything changed. */
async function cmdRegistrySync(): Promise<void> {
  const m = await loadManifestPkg(repoRoot());
  const cur = await ghFile(INDEX_PATH, "main");
  const index = cur ? (JSON.parse(cur) as ReleaseIndex) : null;
  const known = new Set((index?.releases ?? []).map((r) => `${r.product}@${r.version}@${r.channel}`));
  const add: IndexRelease[] = [];
  const rejected: string[] = [];
  for (const repo of OPT2_REPOS) {
    const tags = await gh("GET", `/repos/${OWNER}/${repo}/tags?per_page=50`);
    for (const t of (tags.json ?? []) as { name: string; commit: { sha: string } }[]) {
      if (!/^v\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(t.name)) continue;
      const version = t.name.slice(1);
      let doc: ReleaseCandidateDoc | null;
      try {
        doc = await candidateFromTag(repo, t.name, t.commit.sha);
      } catch (e) {
        rejected.push(`${repo} ${t.name}: ${(e as Error).message}`);
        continue;
      }
      if (!doc) continue; // no images for this tag (yet): pending, not an error
      for (const c of doc.candidates) {
        if (known.has(`${c.product}@${version}@${releaseChannel(c.product, version)}`)) continue;
        const r = await verifyCandidate(m, doc, c);
        if (typeof r === "string") rejected.push(`${repo} ${doc.tag} ${c.product}: ${r}`);
        else {
          add.push(r);
          known.add(`${r.product}@${r.version}@${r.channel}`);
          log(`verified ${r.product}@${r.version} from ${repo}@${doc.commit.slice(0, 8)}`);
        }
      }
    }
  }
  const offersText = await ghFile(OFFERS_PATH, "main");
  const harnessesText = await ghFile(HARNESSES_PATH, "main");
  const offersChanged = JSON.stringify(validateOffers(offersText ? JSON.parse(offersText) : [])) !== JSON.stringify(index?.offers ?? []);
  const harnessesChanged = JSON.stringify(validateHarnesses(harnessesText ? JSON.parse(harnessesText) : [])) !== JSON.stringify(index?.harnesses ?? []);
  const env = await ghFile(ENVELOPE_PATH, "main");
  const exp = env ? (JSON.parse(Buffer.from(env.trim().split(".")[1], "base64url").toString("utf8")) as { exp: number }).exp : 0;
  const expiring = exp - Date.now() / 1000 < 30 * 86400;
  const devOnlyChanged = normalizeDevOnly(index?.releases ?? []).notes.length > 0; // C113: mark/re-classify existing records
  if (add.length || offersChanged || harnessesChanged || expiring || devOnlyChanged) await publishIndex(m, add);
  else log("registry-sync: nothing new");
  if (rejected.length) fail(`rejected candidates:\n  - ${rejected.join("\n  - ")}`);
}

function argValue(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

/** TBD desktop release (C24): run on the release Mac after the notarized artifact is on the GitHub release. */
async function cmdRegistryAddDesktop(args: string[]): Promise<void> {
  const product = argValue(args, "--product") ?? "tbd";
  const version = argValue(args, "--version");
  const url = argValue(args, "--url");
  const sha256 = argValue(args, "--sha256");
  const minOs = argValue(args, "--min-os") ?? "14.0";
  const upgradeFrom = argValue(args, "--upgrade-from") ?? "*";
  const notarized = !args.includes("--not-notarized");
  if (!version || !/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version)) fail("--version <semver> required");
  if (!url || !/^https:\/\/github\.com\/Martin-Atrin\/opt2-tealbrick-[a-z0-9-]+\/releases\/download\//.test(url))
    fail("--url must be a GitHub release asset URL of an opt2 repo");
  if (!sha256 || !/^[0-9a-f]{64}$/.test(sha256)) fail("--sha256 <hex> required");
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok) fail(`artifact not reachable: HTTP ${res.status}`);
  const got = createHash("sha256")
    .update(Buffer.from(await res.arrayBuffer()))
    .digest("hex");
  if (got !== sha256) fail(`artifact sha256 mismatch (downloaded ${got})`);
  const m = await loadManifestPkg(repoRoot());
  const repo = url.split("/")[4];
  await publishIndex(m, [
    {
      id: newId("rel"),
      product,
      kind: "desktop",
      version,
      channel: channelForVersion(version),
      manifestDigest: null,
      manifestUrl: null,
      skillsDigest: null,
      image: null,
      artifact: { url, sha256: `sha256:${sha256}` },
      source: null,
      runtime: null,
      minOs,
      notarized,
      upgradeFrom,
      repo: `${OWNER}/${repo}`,
      commit: null,
      tag: url.split("/")[7] ?? null,
      publishedAt: new Date().toISOString(),
    },
  ]);
}

async function cmdRegistrySign(): Promise<void> {
  await publishIndex(process.env.TB_REGISTRY_UNSIGNED === "1" ? null : await loadManifestPkg(repoRoot()), []);
}

/** C29 interim (no ghcr token yet): a dev-channel entry built from source at a pushed commit. */
async function cmdRegistryAddSource(args: string[]): Promise<void> {
  const product = argValue(args, "--product");
  const kind = argValue(args, "--kind") ?? "app";
  const repo = argValue(args, "--repo");
  const ref = argValue(args, "--ref");
  const dockerfile = argValue(args, "--dockerfile") ?? "Dockerfile";
  const context = argValue(args, "--context") ?? ".";
  const version = argValue(args, "--version");
  const manifestPath = argValue(args, "--manifest");
  const upgradeFrom = argValue(args, "--upgrade-from") ?? "*";
  const runtimeFile = argValue(args, "--runtime");
  if (!product || !/^[a-z0-9][a-z0-9-]*$/.test(product)) fail("--product <id> required");
  if ((kind === "bridge") !== Boolean(runtimeFile)) fail("--runtime <json file> is required for kind bridge and only allowed there");
  let runtime: BridgeRuntime | null = null;
  try {
    runtime = runtimeFile ? validateBridgeRuntime(JSON.parse(readFileSync(runtimeFile, "utf8"))) : null;
  } catch (e) {
    fail((e as Error).message);
  }
  if (kind !== "app" && kind !== "bridge") fail("--kind app|bridge");
  if (!repo || !/^opt2-tealbrick-[a-z0-9-]+$/.test(repo)) fail("--repo opt2-tealbrick-<name> required");
  if (!ref || !/^[0-9a-f]{40}$/.test(ref)) fail("--ref <full commit sha> required");
  if (!safeRel(context) || !safeRel(dockerfile)) fail("--context and --dockerfile must be repo-relative paths without ..");
  if (!version || !/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version)) fail("--version <semver> required (source builds always go to channel dev)");
  if (kind === "app" && !manifestPath) fail(`--manifest <path to ${MANIFEST_FILE}> required for apps`);
  const raw = (path: string) => `https://raw.githubusercontent.com/${OWNER}/${repo}/${ref}/${path}`;
  const df = await fetch(raw(dockerfile));
  if (!df.ok) fail(`${dockerfile} not found at ${repo}@${ref} (HTTP ${df.status}); push it first`);
  const volumeLines = dockerfileVolumeLines(await df.text());
  if (volumeLines.length) fail(`${dockerfile} at ${repo}@${ref} has a VOLUME instruction on line ${volumeLines.join(", ")} (C42); remove it and push`);
  let manifestDigest: string | null = null;
  let skillsDigest: string | null = null;
  let m: ManifestPkg | null = null;
  if (manifestPath) {
    m = await loadManifestPkg(repoRoot());
    const res = await fetch(raw(manifestPath));
    if (!res.ok) fail(`${manifestPath} not found at ${repo}@${ref}`);
    const v = m.validateManifest(JSON.parse(await res.text()));
    if (!v.ok) fail(`manifest invalid: ${JSON.stringify(v.errors).slice(0, 2000)}`);
    const man = v.manifest as { id?: string; version?: string; skills?: { id: string; file: string }[] };
    if (man.id !== product || man.version !== version) fail(`manifest id/version ${man.id}@${man.version} != ${product}@${version}`);
    // SPINE-GAPS #15: manifest runtime.build paths are repo-relative and must equal the record's.
    const mb = (v.manifest as { runtime?: { build?: { context?: string; dockerfile?: string } } }).runtime?.build;
    if (mb && ((mb.context ?? ".") !== context || (mb.dockerfile ?? "Dockerfile") !== dockerfile))
      fail(`manifest runtime.build {context: ${mb.context}, dockerfile: ${mb.dockerfile}} != --context ${context} --dockerfile ${dockerfile}`);
    manifestDigest = m.manifestDigest(v.manifest);
    const base = manifestPath.includes("/") ? manifestPath.slice(0, manifestPath.lastIndexOf("/") + 1) : "";
    const files = new Map<string, string>();
    for (const sk of man.skills ?? []) {
      const r = await fetch(raw(base + sk.file));
      if (!r.ok) fail(`skill file ${sk.file} missing`);
      files.set(sk.file, await r.text());
    }
    skillsDigest = m.digest(skillsArchive(man, (f) => files.get(f) ?? ""));
  } else if (process.env.TB_REGISTRY_UNSIGNED !== "1") {
    m = await loadManifestPkg(repoRoot());
  }
  await publishIndex(m, [
    {
      id: newId("rel"),
      product,
      kind,
      version,
      channel: "dev",
      manifestDigest,
      manifestUrl: manifestPath ? raw(manifestPath) : null,
      skillsDigest,
      image: null,
      artifact: null,
      source: { repo: `${OWNER}/${repo}`, ref, dockerfile, ...(context !== "." ? { context } : {}) },
      runtime,
      services: null,
      minOs: null,
      notarized: null,
      upgradeFrom,
      repo: `${OWNER}/${repo}`,
      commit: ref,
      tag: null,
      publishedAt: new Date().toISOString(),
    },
  ]);
}

interface WsPackage {
  rel: string; // relative to the project path
  dir: string; // basename = release tag prefix
  name: string;
  version: string;
  pkg: Record<string, unknown>;
}

function workspacePackages(projectDir: string): WsPackage[] {
  const wsFile = join(projectDir, "pnpm-workspace.yaml");
  if (!existsSync(wsFile)) return [];
  const out: WsPackage[] = [];
  for (const g of workspaceGlobs(readFileSync(wsFile, "utf8"))) {
    const rels = g.endsWith("/*")
      ? (existsSync(join(projectDir, g.slice(0, -2))) ? readdirSync(join(projectDir, g.slice(0, -2)), { withFileTypes: true }) : [])
          .filter((d) => d.isDirectory())
          .map((d) => `${g.slice(0, -2)}/${d.name}`)
      : [g];
    for (const rel of rels) {
      const pj = join(projectDir, rel, "package.json");
      if (!existsSync(pj)) continue;
      const pkg = readJson(pj);
      out.push({ rel, dir: rel.split("/").pop() ?? rel, name: String(pkg.name), version: String(pkg.version), pkg });
    }
  }
  return out;
}

async function uploadFile(repo: string, releaseId: number, name: string, data: Buffer, contentType: string): Promise<void> {
  const list = await gh("GET", `/repos/${OWNER}/${repo}/releases/${releaseId}/assets?per_page=100`);
  for (const a of (list.json ?? []) as Array<{ id: number; name: string }>) {
    if (a.name === name) await gh("DELETE", `/repos/${OWNER}/${repo}/releases/assets/${a.id}`);
  }
  const up = await gh("POST", `/repos/${OWNER}/${repo}/releases/${releaseId}/assets?name=${encodeURIComponent(name)}`, undefined, {
    host: "uploads.github.com",
    contentType,
    raw: data,
  });
  if (up.status !== 201) fail(`upload asset ${name}: HTTP ${up.status}`);
}

/** Package tags, step 1 (NO token): npm pack --ignore-scripts the tagged workspace package into .tb-ci/pack. */
async function cmdPackagePack(): Promise<void> {
  if (process.env.GITHUB_TOKEN || process.env.GHCR_TOKEN) fail("C62: package-pack must run without tokens");
  const root = repoRoot();
  const cfg = loadConfig(root);
  const repo = repoName(root);
  const tag = process.env.CI_COMMIT_TAG;
  if (!tag) fail("package-release runs on tag events only");
  if (repo === PLATFORM_REPO && tag.startsWith("ci-v")) {
    log(`SKIP: ${tag} is a CI template tag, not a package release`);
    return;
  }
  const target = packTarget(cfg, root, tag);
  const all = target.all;
  // Rewrite in-repo workspace deps to their released tarball URLs; the release must exist.
  const pjPath = join(target.abs, "package.json");
  const original = readFileSync(pjPath, "utf8");
  const pkg = JSON.parse(original) as Record<string, Record<string, string> | unknown>;
  for (const field of DEP_FIELDS) {
    const deps = pkg[field] as Record<string, string> | undefined;
    if (!deps) continue;
    for (const [name, spec] of Object.entries(deps)) {
      if (!spec.startsWith("workspace:")) continue;
      const dep = all.find((w) => w.name === name);
      if (!dep || !name.startsWith("@opt2-tealbrick/")) fail(`${field}.${name}: only @opt2-tealbrick/* workspace dependencies can be released`);
      const url = releaseUrl(repo, dep.dir, dep.name, dep.version);
      const res = await fetch(url, { method: "HEAD", redirect: "follow" });
      if (!res.ok) fail(`${name}@${dep.version} is not released yet (${url}); tag ${dep.dir}-v${dep.version} first`);
      deps[name] = url;
    }
  }
  const outDir = join(root, ".tb-ci/pack");
  mkdirSync(outDir, { recursive: true });
  try {
    writeFileSync(pjPath, `${JSON.stringify(pkg, null, 2)}\n`);
    sh("npm", ["pack", "--ignore-scripts", "--pack-destination", outDir], target.abs);
  } finally {
    writeFileSync(pjPath, original);
  }
  const file = tarballName(target.name, target.version);
  const problems = checkPackedTarball(readFileSync(join(outDir, file)));
  if (problems.length) fail(`pack guard (ci-v9.1): ${file}\n  - ${problems.join("\n  - ")}\n  (was the package built before packing?)`);
  log(`packed ${file}; pack guard OK (every main/exports/types/bin target is in the tarball); upload runs in the next step`);
}

interface PackTarget extends WsPackage {
  abs: string; // package directory
  projectDir: string; // the tealbrick-ci.json path (workspace root) that contains it
  all: (WsPackage & { abs: string })[]; // every workspace package of every path
}

/** The workspace package a `<dir>-v<semver>` tag releases; its version must equal the tag version. */
function packTarget(cfg: CiConfig, root: string, tag: string): PackTarget {
  let parsed: { dir: string; version: string };
  try {
    parsed = parsePackageTag(tag);
  } catch (e) {
    fail((e as Error).message);
  }
  const all = cfg.paths.flatMap((p) => workspacePackages(join(root, p)).map((w) => ({ ...w, abs: join(root, p, w.rel), projectDir: join(root, p) })));
  const target = all.find((w) => w.dir === parsed.dir);
  if (!target) fail(`no workspace package directory named ${parsed.dir} (tag ${tag})`);
  if (target.version !== parsed.version) fail(`${target.rel}/package.json version ${target.version} != tag version ${parsed.version}`);
  return { ...target, all };
}

function cmdAdopt(args: string[]): void {
  const dir = args[0];
  const kindIdx = args.indexOf("--kind");
  const kind = kindIdx >= 0 ? args[kindIdx + 1] : undefined;
  if (!dir || !kind || !KINDS.includes(kind as Kind)) fail(`usage: adopt <repoDir> --kind ${KINDS.join("|")}`);
  const here = dirname(fileURLToPath(import.meta.url));
  const target = resolve(dir);
  mkdirSync(join(target, ".woodpecker"), { recursive: true });
  const tpl = readFileSync(join(here, "woodpecker/ci.yaml"), "utf8");
  writeFileSync(join(target, ".woodpecker/ci.yaml"), tpl);
  if (["miniapp", "bridge", "portal", "library", "specs"].includes(kind)) {
    // C72: releasing kinds publish through the GitHub Actions template (setup decides if it is required)
    mkdirSync(join(target, ".github/workflows"), { recursive: true });
    writeFileSync(join(target, GH_WORKFLOW_PATH), readFileSync(join(here, "github/opt2-release.yml"), "utf8"));
  }
  const ref = /TB_CI_REF: (\S+)/.exec(tpl)?.[1] ?? "main";
  const schemaUrl = `https://raw.githubusercontent.com/${OWNER}/${PLATFORM_REPO}/${ref}/ci/tealbrick-ci.schema.json`;
  rmSync(join(target, ".woodpecker/secret-scan.yaml"), { force: true });
  const cfgPath = join(target, "tealbrick-ci.json");
  if (!existsSync(cfgPath)) {
    const cfg = { $schema: schemaUrl, kind, paths: ["."], images: [] };
    writeFileSync(cfgPath, `${JSON.stringify(cfg, null, 2)}\n`);
  } else {
    // keep the repo's settings AND its formatting; only pin the $schema URL to the template version
    const text = readFileSync(cfgPath, "utf8");
    const pinned = /"\$schema"\s*:\s*"[^"]*"/.test(text)
      ? text.replace(/("\$schema"\s*:\s*)"[^"]*"/, `$1"${schemaUrl}"`)
      : text.replace(/^\s*\{/, `{\n  "$schema": "${schemaUrl}",`);
    JSON.parse(pinned); // still valid JSON
    writeFileSync(cfgPath, pinned);
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
  const tpl = readFileSync(tplPath, "utf8").replaceAll(/TB_CI_SHA256: "[^"]*"/g, `TB_CI_SHA256: "${sha}"`);
  writeFileSync(tplPath, tpl);
  writeFileSync(join(here, "../.woodpecker/ci.yaml"), tpl);
  const ghPath = join(here, "github/opt2-release.yml");
  writeFileSync(ghPath, readFileSync(ghPath, "utf8").replaceAll(/TB_CI_SHA256: "[^"]*"/g, `TB_CI_SHA256: "${sha}"`));
  log(`stamped runner sha256 ${sha}`);
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
    case "gen":
      return cmdGen();
    case "gh-build":
      return cmdGhBuild();
    case "gh-publish":
      return cmdGhPublish();
    case "audit-templates":
      return cmdAuditTemplates();
    case "plan-images":
      return cmdPlanImages();
    case "release-record":
      return cmdReleaseRecord();
    case "package-pack":
      return cmdPackagePack();
    case "adopt":
      return cmdAdopt(rest);
    case "stamp":
      return cmdStamp();
    case "registry-add-desktop":
      return cmdRegistryAddDesktop(rest);
    case "registry-sign":
      return cmdRegistrySign();
    case "registry-sync":
      return cmdRegistrySync();
    case "pin-tarballs":
      return cmdPinTarballs(rest);
    case "registry-add-source":
      return cmdRegistryAddSource(rest);
    default:
      fail(
        "usage: tb-ci setup|install|run <script>|gen|audit-templates|gh-build|gh-publish|plan-images|release-record|package-pack|registry-add-desktop|registry-add-source|registry-sign|registry-sync|pin-tarballs|adopt|stamp",
      );
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((e: unknown) => fail((e as Error).stack ?? String(e)));
}
