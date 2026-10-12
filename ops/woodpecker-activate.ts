// Activate opt2 repos in Woodpecker and set the CI secrets. Run on the operator machine:
//   WOODPECKER_URL=<server url> node ops/woodpecker-activate.ts
// Reads tokens from files (never argv, never printed):
//   ~/.config/opt2-tealbrick/woodpecker-token   Woodpecker personal access token (required)
//   ~/.config/opt2-tealbrick/ghcr-token          GitHub PAT (write:packages, public_repo) -> secret ghcr_token
//   ~/.config/opt2-tealbrick/release-key.pem     Ed25519 private key -> secret release_signing_key
// Secrets are org-level for owner Martin-Atrin, events push/tag/manual only (never pull_request).
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const OWNER = "Martin-Atrin";
const REPOS = ["specs", "sdk", "bridge", "packages", "portal-core", "portal-gui", "website", "knowledge", "connect", "tbd", "platform", "qa", "samples"].map(
  (n) => `opt2-tealbrick-${n}`,
);
const CFG = join(homedir(), ".config/opt2-tealbrick");

const base = process.env.WOODPECKER_URL?.replace(/\/$/, "");
if (!base) throw new Error("WOODPECKER_URL is required");
const token = readFileSync(join(CFG, "woodpecker-token"), "utf8").trim();

async function wp(method: string, path: string, body?: unknown): Promise<{ status: number; json: any }> {
  const res = await fetch(`${base}/api${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, ...(body ? { "content-type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json: any = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  return { status: res.status, json };
}

function githubId(repo: string): number {
  return Number(execFileSync("gh", ["api", `repos/${OWNER}/${repo}`, "-q", ".id"], { encoding: "utf8" }).trim());
}

const me = await wp("GET", "/user");
if (me.status !== 200) throw new Error(`token rejected by Woodpecker (HTTP ${me.status})`);
console.log(`woodpecker user: ${me.json.login}`);

for (const repo of REPOS) {
  const look = await wp("GET", `/repos/lookup/${OWNER}/${repo}`);
  let id: number | null = look.status === 200 && look.json?.active ? look.json.id : null;
  if (!id) {
    const act = await wp("POST", `/repos?forge_remote_id=${githubId(repo)}`);
    if (act.status !== 200) {
      console.log(`${repo}: activation FAILED (HTTP ${act.status})`);
      continue;
    }
    id = act.json.id;
    console.log(`${repo}: activated (id ${id})`);
  } else {
    console.log(`${repo}: already active (id ${id})`);
  }
  // Fork PRs need approval; no trusted/privileged settings.
  await wp("PATCH", `/repos/${id}`, { require_approval: "forks", visibility: "public", timeout: 60 });
}

const org = await wp("GET", `/orgs/lookup/${OWNER}`);
if (org.status !== 200) throw new Error(`org lookup failed (HTTP ${org.status})`);
const orgId = org.json.id as number;
// SEC-03: only ghcr_token is an org secret; the signing key is a platform-repo secret (below).
const secrets: [string, string][] = [["ghcr_token", "ghcr-token"]];
for (const [name, file] of secrets) {
  const p = join(CFG, file);
  if (!existsSync(p)) {
    console.log(`secret ${name}: SKIP (${file} not present)`);
    continue;
  }
  const value = readFileSync(p, "utf8").trim();
  const body = { name, value, events: ["push", "tag", "manual"], images: [] };
  const exists = (await wp("GET", `/orgs/${orgId}/secrets/${name}`)).status === 200;
  const r = exists ? await wp("PATCH", `/orgs/${orgId}/secrets/${name}`, body) : await wp("POST", `/orgs/${orgId}/secrets`, body);
  console.log(`secret ${name}: ${r.status === 200 ? (exists ? "updated" : "created") : `FAILED (HTTP ${r.status})`}`);
}
// Never an org secret: remove a leftover org-level signing key.
if ((await wp("GET", `/orgs/${orgId}/secrets/release_signing_key`)).status === 200) {
  const d = await wp("DELETE", `/orgs/${orgId}/secrets/release_signing_key`);
  console.log(`org secret release_signing_key: ${d.status === 204 || d.status === 200 ? "deleted" : `DELETE FAILED (HTTP ${d.status})`}`);
}
const platform = await wp("GET", `/repos/lookup/${OWNER}/opt2-tealbrick-platform`);
const keyBody = { name: "release_signing_key", value: readFileSync(join(CFG, "release-key.pem"), "utf8").trim(), events: ["cron", "manual"], images: [] };
const hasRepoKey = (await wp("GET", `/repos/${platform.json.id}/secrets/release_signing_key`)).status === 200;
const rk = hasRepoKey
  ? await wp("PATCH", `/repos/${platform.json.id}/secrets/release_signing_key`, keyBody)
  : await wp("POST", `/repos/${platform.json.id}/secrets`, keyBody);
console.log(`platform repo secret release_signing_key: ${rk.status === 200 ? (hasRepoKey ? "updated" : "created") : `FAILED (HTTP ${rk.status})`}`);
