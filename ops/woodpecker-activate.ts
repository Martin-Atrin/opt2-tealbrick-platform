// Activate opt2 repos in Woodpecker and set the CI secrets. Run on the operator machine:
//   WOODPECKER_URL=<server url> node ops/woodpecker-activate.ts
// Reads tokens from files (never argv, never printed):
//   ~/.config/opt2-tealbrick/woodpecker-token   Woodpecker personal access token (required)
// Secrets (C72): Woodpecker holds none; the script deletes any org-level or repo secret it finds. See ci/README.md.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const OWNER = "Martin-Atrin";
const REPOS = [
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
].map((n) => `opt2-tealbrick-${n}`);
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

// ---- Secrets (C67): NO org-level or global secrets. Each secret lives only on the repos that need it, for the
// events that need it. Values come from 0600 files and are never printed.
// C72: Woodpecker holds NO secrets at all. Image/kit/package publishing runs in each repo's GitHub Actions
// workflow with the built-in GITHUB_TOKEN; the release signer runs in the platform repo's GitHub Actions
// (environment "registry", secret RELEASE_SIGNING_KEY, main only). This script removes any Woodpecker secret.
interface Want {
  repo: string;
  name: string;
  file: string;
  events: string[];
}
const WANT: Want[] = [];

const org = await wp("GET", `/orgs/lookup/${OWNER}`);
if (org.status !== 200) throw new Error(`org lookup failed (HTTP ${org.status})`);
for (const sec of ((await wp("GET", `/orgs/${org.json.id}/secrets`)).json ?? []) as { name: string }[]) {
  const d = await wp("DELETE", `/orgs/${org.json.id}/secrets/${sec.name}`);
  console.log(`org secret ${sec.name}: ${d.status < 300 ? "deleted (no org-level secrets)" : `DELETE FAILED (HTTP ${d.status})`}`);
}
const ids = new Map<string, number>();
for (const repo of REPOS) ids.set(repo, (await wp("GET", `/repos/lookup/${OWNER}/${repo}`)).json.id as number);
for (const repo of REPOS) {
  const id = ids.get(repo) as number;
  const want = WANT.filter((w) => w.repo === repo);
  for (const sec of ((await wp("GET", `/repos/${id}/secrets`)).json ?? []) as { name: string }[]) {
    if (!want.some((w) => w.name === sec.name)) {
      const d = await wp("DELETE", `/repos/${id}/secrets/${sec.name}`);
      console.log(`${repo} secret ${sec.name}: ${d.status < 300 ? "deleted (not needed here)" : `DELETE FAILED (HTTP ${d.status})`}`);
    }
  }
  for (const w of want) {
    const p = join(CFG, w.file);
    if (!existsSync(p)) {
      console.log(`${repo} secret ${w.name}: SKIP (${w.file} not present)`);
      continue;
    }
    const body = { name: w.name, value: readFileSync(p, "utf8").trim(), events: w.events, images: [] };
    const exists = (await wp("GET", `/repos/${id}/secrets/${w.name}`)).status === 200;
    const r = exists ? await wp("PATCH", `/repos/${id}/secrets/${w.name}`, body) : await wp("POST", `/repos/${id}/secrets`, body);
    console.log(`${repo} secret ${w.name} [${w.events.join(",")}]: ${r.status === 200 ? (exists ? "updated" : "created") : `FAILED (HTTP ${r.status})`}`);
  }
}
