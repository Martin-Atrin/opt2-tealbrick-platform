// Portal Root Keys (C63 / BSD-08). Run on the machine that holds the keys (offline for production).
//   node ops/root-key.ts generate --out <dir> --channel dev|stable [--no-passphrase]   (dev only: --no-passphrase)
// Writes <dir>/portal-root-a.key and <dir>/portal-root-b.key (0600; PKCS#8 PEM, encrypted with a per-key passphrase
// read from the terminal unless --no-passphrase) and <dir>/portal-root-keys.<channel>.json (the two PUBLIC JWKs).
// Private key material is never printed. kid = RFC 7638 thumbprint via @opt2-tealbrick/manifest (the one owner of
// key primitives; TB_MANIFEST_MODULE = path to its built entry, e.g. ops/signer/node_modules/... after `npm ci --prefix ops/signer --ignore-scripts`).
import { generateKeyPairSync } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
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

async function main(): Promise<void> {
  if (process.argv[2] !== "generate") throw new Error("usage: node ops/root-key.ts generate --out <dir> --channel dev|stable [--no-passphrase]");
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

main().catch((e: unknown) => {
  console.error(`root-key: FAIL: ${(e as Error).message}`);
  process.exit(1);
});
