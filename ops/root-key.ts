// Portal Root Keys (C63 / BSD-08). Run on the machine that holds the keys (offline for production).
//   node ops/root-key.ts generate --out <dir> --channel dev|stable [--no-passphrase]   (dev only: --no-passphrase)
// Writes <dir>/portal-root-a.key and <dir>/portal-root-b.key (0600; PKCS#8 PEM, encrypted with a per-key passphrase
// read from the terminal unless --no-passphrase) and <dir>/portal-root-keys.<channel>.json (the two PUBLIC JWKs).
//   node ops/root-key.ts sign --request <keyset-request.json> --key <portal-root-a.key> --out <portal-keyset.jws> [--channel dev|stable]
//   node ops/root-key.ts verify --jws <portal-keyset.jws> --channel dev|stable [--request <keyset-request.json>]
// `sign` (CREDENTIALS §9.5 ceremony) signs ONE key-set statement with a root key and re-verifies it against the pinned roots
// (portalRootKeys(channel)) before writing the PUBLIC .jws. `verify` checks a statement (and, with --request, that it is exactly
// what the request says). Signing is deterministic (Ed25519, fixed iat in the request), so the same request gives the same bytes.
// Private key material is never printed. kid = RFC 7638 thumbprint via @opt2-tealbrick/manifest (the one owner of
// key primitives; TB_MANIFEST_MODULE = path to its built entry, e.g. ops/signer/node_modules/... after `npm ci --prefix ops/signer --ignore-scripts`).
import { createPrivateKey, createPublicKey, generateKeyPairSync, type KeyObject } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function askHidden(prompt: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stderr, terminal: true });
  (rl as unknown as { _writeToOutput: (s: string) => void })._writeToOutput = () => {};
  process.stderr.write(prompt);
  const answer = await new Promise<string>((r) => rl.question("", r));
  rl.close();
  process.stderr.write("\n");
  return answer;
}

async function generate(): Promise<void> {
  const out = resolve(arg("--out") ?? "");
  const channel = arg("--channel");
  const noPass = process.argv.includes("--no-passphrase");
  if (!arg("--out") || (channel !== "dev" && channel !== "stable")) throw new Error("--out <dir> and --channel dev|stable are required");
  if (noPass && channel !== "dev") throw new Error("--no-passphrase is allowed for the dev channel only");
  const mod = process.env.TB_MANIFEST_MODULE;
  if (!mod) throw new Error("TB_MANIFEST_MODULE (built @opt2-tealbrick/manifest entry) is required for the kid thumbprint");
  const { thumbprint } = (await import(pathToFileURL(resolve(mod)).href)) as { thumbprint: (jwk: JsonWebKey) => string };
  mkdirSync(out, { recursive: true, mode: 0o700 });
  const pub: Record<string, unknown>[] = [];
  const pending: { file: string; pem: string }[] = [];
  for (const role of ["root-a", "root-b"] as const) {
    const file = join(out, `portal-${role}.key`);
    if (existsSync(file)) throw new Error(`${file} exists; refusing to overwrite a root key`);
    const pass = noPass ? undefined : await askHidden(`passphrase for ${role} (min 16 chars): `);
    if (!noPass && (!pass || pass.length < 16)) throw new Error("passphrase too short");
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const jwk = publicKey.export({ format: "jwk" }) as JsonWebKey;
    const kid = thumbprint(jwk);
    const pem = privateKey.export(pass ? { type: "pkcs8", format: "pem", cipher: "aes-256-cbc", passphrase: pass } : { type: "pkcs8", format: "pem" });
    pending.push({ file, pem: String(pem) });
    pub.push({ kty: jwk.kty, crv: jwk.crv, x: jwk.x, kid, alg: "EdDSA", use: "sig", tb_role: role });
  }
  for (const p of pending) {
    writeFileSync(p.file, p.pem, { mode: 0o600, flag: "wx" });
    chmodSync(p.file, 0o600);
  }
  for (const k of pub) console.log(`${k.tb_role}: kid ${k.kid} (private key written, mode 0600)`);
  const doc = { schema: "opt2.portal-root-keys/v1", channel, generatedAt: new Date().toISOString(), keys: pub };
  writeFileSync(join(out, `portal-root-keys.${channel}.json`), `${JSON.stringify(doc, null, 2)}\n`);
  console.log(`public JWKs: ${join(out, `portal-root-keys.${channel}.json`)}`);
}

type Jwk = { kty: string; crv: string; x: string; kid?: string };
type KeyEntry = { jwk: Jwk; status: "pending" | "active" | "retired" };
interface ManifestApi {
  thumbprint: (jwk: Jwk) => string;
  importKeyPair: (pkcs8: Uint8Array) => Promise<unknown>;
  signKeySetStatement: (claims: unknown, key: unknown) => Promise<string>;
  verifyKeySetStatement: (jws: string, roots: Jwk[], pinned?: null) => { ok: true; seq: number; keys: unknown } | { ok: false; code?: string; reason?: string };
  portalRootKeys: (channel: "dev" | "prod") => Jwk[];
}

async function loadManifest(): Promise<ManifestApi> {
  const mod = process.env.TB_MANIFEST_MODULE;
  if (!mod) throw new Error("TB_MANIFEST_MODULE (built @opt2-tealbrick/manifest entry, >= 0.1.6) is required");
  return (await import(pathToFileURL(resolve(mod)).href)) as ManifestApi;
}

function channelOf(): "dev" | "prod" {
  const c = arg("--channel") ?? "dev";
  if (c !== "dev" && c !== "stable") throw new Error("--channel must be dev or stable");
  return c === "dev" ? "dev" : "prod";
}

function b64json(part: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(part, "base64url").toString("utf8")) as Record<string, unknown>;
}

/** Checks a request file and returns the exact claims (key order iss, aud, seq, iat, keys). */
function claimsOf(req: Record<string, unknown>, m: ManifestApi) {
  if (req.schema !== "opt2.keyset-request/v1") throw new Error("request.schema must be opt2.keyset-request/v1");
  const { seq, iat, keys } = req as { seq: unknown; iat: unknown; keys: unknown };
  if (!Number.isInteger(seq) || (seq as number) < 1) throw new Error("request.seq must be an integer >= 1");
  if (!Number.isInteger(iat) || (iat as number) < 1) throw new Error("request.iat must be epoch seconds");
  if (!Array.isArray(keys) || keys.length < 1 || keys.length > 8) throw new Error("request.keys must have 1..8 entries");
  for (const k of keys as KeyEntry[]) {
    if (!["pending", "active", "retired"].includes(k.status)) throw new Error("bad key status");
    if (m.thumbprint(k.jwk) !== (k.jwk.kid ?? m.thumbprint(k.jwk))) throw new Error(`jwk kid is not its thumbprint (${k.jwk.kid})`);
  }
  return { iss: "tb:portal-root", aud: "tb:portal-keys", seq, iat, keys };
}

/** Verifies a statement against the pinned roots; optionally against the request it must realise. Returns a summary. */
function checkStatement(jws: string, m: ManifestApi, channel: "dev" | "prod", req?: Record<string, unknown>) {
  const v = m.verifyKeySetStatement(jws, m.portalRootKeys(channel), null);
  if (!v.ok) throw new Error(`statement does not verify: ${(v as { code?: string }).code ?? "refused"}`);
  const [h, c] = jws.split(".");
  const header = b64json(h ?? "");
  const claims = b64json(c ?? "");
  if (Object.keys(claims).join(",") !== "iss,aud,seq,iat,keys") throw new Error(`claim order is ${Object.keys(claims).join(",")}`);
  if (req && JSON.stringify(claims) !== JSON.stringify(claimsOf(req, m))) throw new Error("statement claims differ from the request");
  return {
    kid: String(header.kid),
    seq: claims.seq as number,
    iat: claims.iat as number,
    keys: (claims.keys as KeyEntry[]).map((k) => `${k.jwk.kid ?? m.thumbprint(k.jwk)} ${k.status}`),
  };
}

async function sign(): Promise<void> {
  const m = await loadManifest();
  const channel = channelOf();
  const keyFile = arg("--key");
  const reqFile = arg("--request");
  const out = arg("--out");
  if (!keyFile || !reqFile || !out) throw new Error("--request, --key and --out are required");
  const req = JSON.parse(readFileSync(resolve(reqFile), "utf8")) as Record<string, unknown>;
  const claims = claimsOf(req, m);
  const pem = readFileSync(resolve(keyFile), "utf8");
  let priv: KeyObject;
  try {
    priv = createPrivateKey({ key: pem, format: "pem" });
  } catch {
    const pass = await askHidden("passphrase for the root key: ");
    priv = createPrivateKey({ key: pem, format: "pem", passphrase: pass });
  }
  const pub = createPublicKey(priv).export({ format: "jwk" }) as Jwk;
  const rootKid = m.thumbprint({ kty: pub.kty, crv: pub.crv, x: pub.x });
  const root = m.portalRootKeys(channel).find((r) => r.kid === rootKid);
  if (!root) throw new Error(`key ${rootKid} is not a pinned ${channel} root`);
  const pair = await m.importKeyPair(new Uint8Array(priv.export({ type: "pkcs8", format: "der" })));
  const jws = await m.signKeySetStatement(claims, pair);
  const s = checkStatement(jws, m, channel, req);
  if (s.kid !== rootKid) throw new Error("header kid is not the signing root");
  writeFileSync(resolve(out), `${jws}\n`);
  console.log(`signed ${resolve(out)}: root ${s.kid}, seq ${s.seq}, iat ${s.iat}`);
  for (const k of s.keys) console.log(`  key ${k}`);
  console.log("verified against the pinned roots, claim order iss,aud,seq,iat,keys");
}

async function verify(): Promise<void> {
  const m = await loadManifest();
  const jwsFile = arg("--jws");
  if (!jwsFile) throw new Error("--jws is required");
  const reqFile = arg("--request");
  const req = reqFile ? (JSON.parse(readFileSync(resolve(reqFile), "utf8")) as Record<string, unknown>) : undefined;
  const s = checkStatement(readFileSync(resolve(jwsFile), "utf8").trim(), m, channelOf(), req);
  console.log(`ok: root ${s.kid}, seq ${s.seq}, iat ${s.iat}`);
  for (const k of s.keys) console.log(`  key ${k}`);
}

async function main(): Promise<void> {
  const cmd = process.argv[2];
  if (cmd === "generate") return generate();
  if (cmd === "sign") return sign();
  if (cmd === "verify") return verify();
  throw new Error("usage: node ops/root-key.ts generate|sign|verify (see the header of this file)");
}

main().catch((e: unknown) => {
  console.error(`root-key: FAIL: ${(e as Error).message}`);
  process.exit(1);
});
