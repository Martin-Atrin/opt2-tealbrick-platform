// opt2 CI runner (one file, no dependencies of its own, Node 24+ runs it directly).
// Fetched by every repo's .woodpecker/ci.yaml at a pinned tag + sha256.
// Commands:
//   setup                       template drift + config + package rules
//   install                     install dependencies per project path (frozen lockfile)
//   run <script>                run a standard script per project path (typecheck|lint|test|conformance|build)
//   gen                         BSA-03: committed gen/ not stale, `gen` script produces every tb-gen kind, tb-gen check passes
//   kit-release                 (tag v*, miniapp) tb-gen kit --build -> kit tarball + sha256 on the GitHub release
//   audit-templates             (platform cron) every opt2 repo's template ref >= ci/MIN_TEMPLATE
//   plan-images                 write .tb-ci/images.sh for the kaniko steps
//   release-record              (tag v*) release candidate (image digests) -> GitHub release asset; NO signing key (SEC-03)
//   registry-sync               (platform signer pipeline only) verify candidates independently, index + sign
//   pin-tarballs [<repoDir>]    (local) pin sha512 of GitHub-release tarballs the lockfile has no integrity for (S3)
//   package-release             (tag <pkg>-v*) npm pack one workspace package -> GitHub release tarball
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
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

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
  source: { repo: string; ref: string; dockerfile: string } | null; // C29 interim: dev-channel source build until ghcr images exist
  runtime: BridgeRuntime | null; // kind bridge only (the bridge has no app manifest); apps take runtime from their manifest
  services?: { id: string; image: string }[] | null; // app image releases: one published image per manifest service with `build` (BSA-01)
  minOs: string | null; // desktop
  notarized: boolean | null; // desktop
  upgradeFrom: string;
  repo: string;
  commit: string | null;
  tag: string | null;
  publishedAt: string;
}

/** Deploy recipe facts for the bridge service (apps carry these in their manifest `runtime`). */
export interface BridgeRuntime {
  port: number; // public (MCP, launch, key page)
  internalPort: number; // private network only (apps, companions)
  healthPath: string; // liveness
  readyPath: string; // ready after enrolment
  volumes: { mountPath: string; backup: boolean }[]; // backup = Railway volume backups on (C28, S7)
  env: { name: string; source: "portal" | "provider-secret" | "public-url" | "fixed"; value?: string }[];
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
    if (!["portal", "provider-secret", "public-url", "fixed"].includes(e.source as string)) throw new Error(`runtime: env ${e.name} source`);
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

/** `ci-vN` -> N; anything else -> NaN. */
export function templateNumber(ref: string): number {
  const m = /^ci-v(\d+)$/.exec(ref.trim());
  return m ? Number(m[1]) : Number.NaN;
}

/** D1/C56: a template ref below the minimum (or unparseable) is refused. */
export function belowMinimum(ref: string, min: string): boolean {
  const a = templateNumber(ref);
  const b = templateNumber(min);
  if (Number.isNaN(b)) throw new Error(`bad minimum template ref ${min}`);
  return Number.isNaN(a) || a < b;
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
  return { kind, paths, conformance, images };
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

/** Merge new releases into the index. Releases are immutable: (product, version, channel) never changes content.
 *  A dev source build (C29) and the later stable image of the same version are two releases. */
export function mergeIndex(prev: ReleaseIndex | null, add: IndexRelease[], offers: Offer[], now: string, harnesses: Harness[] = []): ReleaseIndex {
  const releases: IndexRelease[] = (prev?.releases ?? []).map((r) => ({ ...r, runtime: r.runtime ?? null, services: r.services ?? null }));
  for (const r of add) {
    if (r.kind !== "desktop" && r.channel === "stable" && !r.image)
      throw new Error(`${r.product}@${r.version}: a stable release needs an image digest (source builds are dev only, C29)`);
    if (r.kind !== "desktop" && !r.image && !r.source) throw new Error(`${r.product}@${r.version}: needs image or source`);
    if ((r.kind === "bridge") !== (r.runtime !== null && r.runtime !== undefined))
      throw new Error(`${r.product}@${r.version}: runtime is required for kind bridge and only allowed there`);
    const old = releases.find((x) => x.product === r.product && x.version === r.version && x.channel === r.channel);
    if (old) {
      if (old.image !== r.image || old.artifact?.sha256 !== r.artifact?.sha256 || old.manifestDigest !== r.manifestDigest || old.source?.ref !== r.source?.ref)
        throw new Error(`${r.product}@${r.version} is already released with other content (releases are immutable; ship a new version)`);
      continue;
    }
    releases.push(r);
  }
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
    if (!Number.isInteger(r.amount) || (r.amount as number) <= 0) fail("amount (minor units)");
    if (typeof r.currency !== "string" || !/^[a-z]{3}$/.test(r.currency)) fail("currency (ISO lower case)");
    for (const k of ["name", "taxNote"]) if (typeof r[k] !== "string" || !(r[k] as string)) fail(k);
    const sp = r.stripePrice as Record<string, unknown> | undefined;
    if (!sp || !("test" in sp) || !("live" in sp)) fail("stripePrice {test, live}");
    for (const m of ["test", "live"] as const) {
      const v = (sp as Record<string, unknown>)[m];
      if (v !== null && (typeof v !== "string" || !/^price_[A-Za-z0-9]+$/.test(v))) fail(`stripePrice.${m} must be price_… or null`);
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

/** Returns problems: every release tarball needs integrity in the lockfile or a matching pin in tealbrick-integrity.json. */
async function checkTarballIntegrity(dir: string, where: string): Promise<string[]> {
  const pm = packageManager(dir);
  if (!pm) return [];
  const lockText = readFileSync(join(dir, pm === "pnpm" ? "pnpm-lock.yaml" : "package-lock.json"), "utf8");
  const entries = lockfileTarballs(lockText, pm);
  const pinsPath = join(dir, INTEGRITY_FILE);
  const pins = existsSync(pinsPath) ? (JSON.parse(readFileSync(pinsPath, "utf8")) as Record<string, string>) : {};
  const errs: string[] = [];
  for (const e of entries) {
    if (e.integrity) continue; // the package manager verifies it on install
    const pin = pins[e.url];
    if (!pin) {
      errs.push(`${where}: ${e.url} has no integrity in the lockfile and no pin in ${INTEGRITY_FILE} (run: node ci/tb-ci.ts pin-tarballs <repo>)`);
      continue;
    }
    const res = await fetch(e.url, { redirect: "follow" });
    if (!res.ok) {
      errs.push(`${where}: ${e.url} HTTP ${res.status}`);
      continue;
    }
    const got = sha512Integrity(new Uint8Array(await res.arrayBuffer()));
    if (got !== pin) errs.push(`${where}: ${e.url} does not match its pinned integrity (tarball changed after pinning)`);
  }
  for (const url of Object.keys(pins)) if (!entries.some((e) => e.url === url)) errs.push(`${where}: stale pin ${url} (not in the lockfile)`);
  return errs;
}

/** (local) write tealbrick-integrity.json for every release tarball the lockfile does not already carry integrity for. */
async function cmdPinTarballs(args: string[]): Promise<void> {
  const dir = resolve(args[0] ?? ".");
  const pm = packageManager(dir);
  if (!pm) fail(`${dir}: no lockfile`);
  const entries = lockfileTarballs(readFileSync(join(dir, pm === "pnpm" ? "pnpm-lock.yaml" : "package-lock.json"), "utf8"), pm).filter((e) => !e.integrity);
  const pins: Record<string, string> = {};
  for (const e of entries.sort((a, b) => a.url.localeCompare(b.url))) {
    const res = await fetch(e.url, { redirect: "follow" });
    if (!res.ok) fail(`${e.url}: HTTP ${res.status}`);
    pins[e.url] = sha512Integrity(new Uint8Array(await res.arrayBuffer()));
  }
  if (entries.length === 0) {
    rmSync(join(dir, INTEGRITY_FILE), { force: true });
    log("lockfile carries integrity for every release tarball; no pin file needed");
    return;
  }
  writeFileSync(join(dir, INTEGRITY_FILE), `${JSON.stringify(pins, null, 2)}\n`);
  log(`pinned ${entries.length} release tarball(s) in ${INTEGRITY_FILE}; commit it`);
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
  const min = (await fetchText(`https://raw.githubusercontent.com/${OWNER}/${PLATFORM_REPO}/main/${MIN_TEMPLATE_PATH}`)).trim();
  if (belowMinimum(ref, min)) fail(`template ${ref} is below the enforced minimum ${min} (C56 D1): run adopt from the platform repo`);
  log(`template ${ref} >= minimum ${min}`);
  if (existsSync(join(root, ".woodpecker/secret-scan.yaml"))) fail(".woodpecker/secret-scan.yaml duplicates the template's secret-scan step; delete it");
  const cfg = loadConfig(root);
  log(`kind=${cfg.kind} paths=${cfg.paths.join(",")} conformance=${cfg.conformance} images=${cfg.images.map((i) => i.name).join(",") || "-"}`);
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
    if (pm === "pnpm" && typeof pkg.packageManager !== "string")
      errors.push(`${p}/package.json: "packageManager": "pnpm@<version>" is required with pnpm-lock.yaml`);
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

/** BSA-03 on v* tags: build the per-app kit and attach tarball + sha256 to the GitHub release. */
async function cmdKitRelease(): Promise<void> {
  const root = repoRoot();
  const cfg = loadConfig(root);
  const tag = process.env.CI_COMMIT_TAG;
  if (!tag) fail("kit-release runs on tag events only");
  if (cfg.kind !== "miniapp") {
    log("SKIP kit-release: not a miniapp");
    return;
  }
  const repo = repoName(root);
  let version: string;
  try {
    version = versionFromTag(tag);
  } catch (e) {
    fail((e as Error).message);
  }
  const releaseId = await ensureRelease(repo, tag, channelForVersion(version) !== "stable");
  for (const p of nodePaths(cfg, root)) {
    const dir = join(root, p);
    const out = join(root, ".tb-ci/kit", p.replaceAll("/", "_"));
    mkdirSync(out, { recursive: true });
    pmExec(dir, "tb-gen", ["kit", "--build", "--out", out]);
    const tgz = readdirSync(out).filter((f) => f.endsWith(".tgz"));
    if (tgz.length !== 1) fail(`${p}: expected one kit tarball in ${out}, found ${tgz.length}`);
    const data = readFileSync(join(out, tgz[0]));
    const sha = createHash("sha256").update(data).digest("hex");
    await uploadFile(repo, releaseId, tgz[0], data, "application/gzip");
    await uploadFile(repo, releaseId, `${tgz[0]}.sha256`, Buffer.from(`${sha}  ${tgz[0]}\n`), "text/plain");
    log(`kit ${tgz[0]} attached to ${tag} (sha256 ${sha})`);
  }
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

async function loadManifestPkg(root: string): Promise<ManifestPkg> {
  const override = process.env.TB_MANIFEST_MODULE; // local path to a built package (development)
  let entry: string;
  if (override) {
    entry = resolve(override);
  } else {
    const url = process.env.TB_MANIFEST_PKG;
    if (!url || !RELEASE_URL_RE.test(url)) fail("TB_MANIFEST_PKG must be the @opt2-tealbrick/manifest GitHub release tarball URL");
    const dir = join(root, ".tb-ci/pkgs");
    mkdirSync(dir, { recursive: true });
    if (!existsSync(join(dir, "package.json"))) writeFileSync(join(dir, "package.json"), '{"private":true}\n');
    sh("npm", ["install", "--no-save", "--no-audit", "--no-fund", url], dir);
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
    const msg = `${add.length ? `registry: ${add.map((r) => `${r.product}@${r.version}`).join(", ")}` : "registry: re-publish"}${jws ? "" : " (UNSIGNED interim)"}`;
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
export const CANDIDATE_ASSET = "release-candidate.json";

/** Product tag pipeline: describe the release (image digests from image-publish) as a GitHub release asset. No signing key here. */
async function cmdReleaseRecord(): Promise<void> {
  const root = repoRoot();
  const cfg = loadConfig(root);
  const repo = repoName(root);
  const tag = process.env.CI_COMMIT_TAG;
  const commit = process.env.CI_COMMIT_SHA;
  if (!tag || !commit) fail("release-record runs on tag events only (CI_COMMIT_TAG, CI_COMMIT_SHA)");
  if (process.env.RELEASE_SIGNING_KEY || process.env.RELEASE_SIGNING_KEY_FILE) fail("SEC-03: product pipelines must not hold the release signing key");
  let version: string;
  try {
    version = versionFromTag(tag);
  } catch (e) {
    fail((e as Error).message);
  }
  const entries = cfg.images.filter((im) => im.kind === "app" || im.kind === "bridge");
  if (entries.length === 0) {
    log("no app/bridge images declared: no release candidate");
    return;
  }
  const m = await loadManifestPkg(root); // early validation only; the signer re-checks
  const digestOf = (name: string): string => {
    const f = join(root, ".tb-ci/digests", `${name}.digest`);
    if (!existsSync(f)) fail(`digest for ${name} missing (image-publish must run first)`);
    const d = readFileSync(f, "utf8").trim();
    if (!/^sha256:[0-9a-f]{64}$/.test(d)) fail(`bad digest for ${name}`);
    return d;
  };
  const candidates: ReleaseCandidate[] = entries.map((im) => {
    if (im.manifest) {
      const v = m.validateManifest(JSON.parse(readFileSync(join(root, im.manifest), "utf8")));
      if (!v.ok) fail(`${im.manifest} is invalid: ${JSON.stringify(v.errors).slice(0, 2000)}`);
      const man = v.manifest as { id?: string; version?: string; runtime?: { services?: { id: string; build?: unknown }[] } };
      if (man.id !== im.product || man.version !== version) fail(`manifest ${man.id}@${man.version} != ${im.product}@${version}`);
      const svcErrs = checkServiceImages(cfg, im.product, man.runtime?.services ?? []);
      if (svcErrs.length) fail(svcErrs.join("; "));
    }
    const runtimeFile = im.kind === "bridge" ? `${dirname(im.dockerfile)}/bridge-runtime.json` : null;
    if (runtimeFile) validateBridgeRuntime(JSON.parse(readFileSync(join(root, runtimeFile), "utf8")));
    return {
      product: im.product,
      kind: im.kind === "bridge" ? "bridge" : "app",
      version,
      image: `${IMAGE_NAMESPACE}/${im.name}@${digestOf(im.name)}`,
      services: cfg.images
        .filter((x) => x.kind === "service" && x.product === im.product)
        .map((x) => ({ id: x.service as string, image: `${IMAGE_NAMESPACE}/${x.name}@${digestOf(x.name)}` }))
        .sort((x, y) => x.id.localeCompare(y.id)),
      manifest: im.manifest ?? null,
      runtimeFile,
      upgradeFrom: im.upgradeFrom,
    };
  });
  const doc: ReleaseCandidateDoc = { schema: "opt2.release-candidate/v1", repo: `${OWNER}/${repo}`, tag, commit, candidates };
  const releaseId = await ensureRelease(repo, tag, channelForVersion(version) !== "stable");
  await uploadAsset(repo, releaseId, CANDIDATE_ASSET, `${JSON.stringify(doc, null, 2)}\n`);
  log(`release candidate for ${candidates.map((c) => `${c.product}@${c.version}`).join(", ")} attached; the platform signer verifies and indexes it`);
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
      channel: channelForVersion(c.version),
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

/** Platform signer pipeline (cron/manual, platform repo only, holds release_signing_key):
 *  collect release candidates from the opt2 repos, verify each independently, add them, re-sign when anything changed. */
async function cmdRegistrySync(): Promise<void> {
  const m = await loadManifestPkg(repoRoot());
  const cur = await ghFile(INDEX_PATH, "main");
  const index = cur ? (JSON.parse(cur) as ReleaseIndex) : null;
  const known = new Set((index?.releases ?? []).map((r) => `${r.product}@${r.version}@${r.channel}`));
  const add: IndexRelease[] = [];
  const rejected: string[] = [];
  for (const repo of OPT2_REPOS) {
    const rels = await gh("GET", `/repos/${OWNER}/${repo}/releases?per_page=30`);
    for (const rel of (rels.json ?? []) as { tag_name: string; assets: { name: string; browser_download_url: string }[] }[]) {
      const asset = rel.assets?.find((x) => x.name === CANDIDATE_ASSET);
      if (!asset) continue;
      const doc = (await (await fetch(asset.browser_download_url)).json()) as ReleaseCandidateDoc;
      if (doc.schema !== "opt2.release-candidate/v1" || doc.repo !== `${OWNER}/${repo}` || doc.tag !== rel.tag_name) {
        rejected.push(`${repo} ${rel.tag_name}: candidate document does not match its release`);
        continue;
      }
      for (const c of doc.candidates) {
        if (known.has(`${c.product}@${c.version}@${channelForVersion(c.version)}`)) continue;
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
  if (add.length || offersChanged || harnessesChanged || expiring) await publishIndex(m, add);
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
      source: { repo: `${OWNER}/${repo}`, ref, dockerfile },
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

async function cmdPackageRelease(): Promise<void> {
  const root = repoRoot();
  const cfg = loadConfig(root);
  const repo = repoName(root);
  const tag = process.env.CI_COMMIT_TAG;
  if (!tag) fail("package-release runs on tag events only");
  if (repo === PLATFORM_REPO && tag.startsWith("ci-v")) {
    log(`SKIP: ${tag} is a CI template tag, not a package release`);
    return;
  }
  let parsed: { dir: string; version: string };
  try {
    parsed = parsePackageTag(tag);
  } catch (e) {
    fail((e as Error).message);
  }
  const all = cfg.paths.flatMap((p) => workspacePackages(join(root, p)).map((w) => ({ ...w, abs: join(root, p, w.rel) })));
  const target = all.find((w) => w.dir === parsed.dir);
  if (!target) fail(`no workspace package directory named ${parsed.dir} (tag ${tag})`);
  if (target.version !== parsed.version) fail(`${target.rel}/package.json version ${target.version} != tag version ${parsed.version}`);
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
    sh("npm", ["pack", "--pack-destination", outDir], target.abs);
  } finally {
    writeFileSync(pjPath, original);
  }
  const file = tarballName(target.name, target.version);
  const data = readFileSync(join(outDir, file));
  const sha = createHash("sha256").update(data).digest("hex");
  const releaseId = await ensureRelease(repo, tag, channelForVersion(target.version) !== "stable");
  await uploadFile(repo, releaseId, file, data, "application/gzip");
  await uploadFile(repo, releaseId, `${file}.sha256`, Buffer.from(`${sha}  ${file}\n`), "text/plain");
  log(`released ${target.name}@${target.version}: ${releaseUrl(repo, target.dir, target.name, target.version)} (sha256 ${sha})`);
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
  const tpl = readFileSync(tplPath, "utf8").replace(/TB_CI_SHA256: "[^"]*"/, `TB_CI_SHA256: "${sha}"`);
  writeFileSync(tplPath, tpl);
  writeFileSync(join(here, "../.woodpecker/ci.yaml"), tpl);
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
    case "kit-release":
      return cmdKitRelease();
    case "audit-templates":
      return cmdAuditTemplates();
    case "plan-images":
      return cmdPlanImages();
    case "release-record":
      return cmdReleaseRecord();
    case "package-release":
      return cmdPackageRelease();
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
        "usage: tb-ci setup|install|run <script>|gen|kit-release|audit-templates|plan-images|release-record|package-release|registry-add-desktop|registry-add-source|registry-sign|registry-sync|pin-tarballs|adopt|stamp",
      );
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((e: unknown) => fail((e as Error).stack ?? String(e)));
}
