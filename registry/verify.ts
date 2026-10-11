// Release registry verifier (reference for Portal Core; Core may import this file as a git dependency
// or re-implement the same 10 lines). The index is trusted ONLY if the detached Ed25519 signature over
// the exact bytes of index.json verifies with the pinned public key.
//   node registry/verify.ts            verify the live index on main
//   node registry/verify.ts <file>     verify a local index.json (+ <file>.sig)
import { createPublicKey, verify } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const INDEX_URL = "https://raw.githubusercontent.com/Martin-Atrin/opt2-tealbrick-platform/main/registry/index.json";

export interface VerifiedIndex {
  schema: "opt2.release-index/v1";
  kid: string;
  generatedAt: string;
  releases: Array<{
    releaseId: string;
    product: string;
    productKind: "miniapp" | "bridge" | "portal" | "service";
    version: string;
    channel: "stable" | "beta" | "dev";
    image: string;
    imageDigest: string;
    manifestDigest: string | null;
    manifestUrl: string | null;
    commit: string;
    repo: string;
    tag: string;
    publishedAt: string;
  }>;
}

export function verifyIndex(indexText: string, sigB64: string, publicKeyPem: string): VerifiedIndex {
  const ok = verify(null, new TextEncoder().encode(indexText), createPublicKey(publicKeyPem), Buffer.from(sigB64.trim(), "base64"));
  if (!ok) throw new Error("release index signature does not verify");
  const index = JSON.parse(indexText) as VerifiedIndex;
  if (index.schema !== "opt2.release-index/v1") throw new Error(`unexpected index schema ${String(index.schema)}`);
  return index;
}

export async function fetchVerifiedIndex(publicKeyPem: string, url = INDEX_URL): Promise<VerifiedIndex> {
  const [i, s] = await Promise.all([fetch(url), fetch(`${url}.sig`)]);
  if (!i.ok || !s.ok) throw new Error(`release index fetch failed: ${i.status}/${s.status}`);
  return verifyIndex(await i.text(), await s.text(), publicKeyPem);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const here = dirname(fileURLToPath(import.meta.url));
  const pub = readFileSync(join(here, "release-key.pub.pem"), "utf8");
  const file = process.argv[2];
  const run = file ? Promise.resolve(verifyIndex(readFileSync(file, "utf8"), readFileSync(`${file}.sig`, "utf8"), pub)) : fetchVerifiedIndex(pub);
  run.then(
    (idx) => console.log(`OK: ${idx.releases.length} release(s), kid ${idx.kid}, generated ${idx.generatedAt}`),
    (e: unknown) => {
      console.error(`FAIL: ${(e as Error).message}`);
      process.exit(1);
    },
  );
}
