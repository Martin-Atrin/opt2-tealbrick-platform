// C199: planning logic of ops/promote.ts (no network, no Railway).
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  CI_CONTEXT,
  checkIndex,
  ciGreen,
  INDEX_URL,
  ORDER,
  OWNER,
  parseArgs,
  parseSet,
  planSteps,
  type ReleaseSet,
  recordPath,
  rollbackCommand,
} from "./promote.ts";

const sha = (c: string) => c.repeat(40);
const base = (over: Record<string, unknown> = {}) => ({
  id: "RS-2",
  createdAt: "2026-10-15T10:00:00Z",
  notes: "test",
  portalCore: { repo: "opt2-tealbrick-portal-core", sha: sha("a") },
  portalGui: { repo: "opt2-tealbrick-portal-gui", sha: sha("b") },
  website: { repo: "opt2-tealbrick-website", sha: sha("c") },
  bridge: { version: "0.1.29" },
  apps: [
    { product: "connect", version: "0.5.8" },
    { product: "knowledge", version: "0.1.19" },
  ],
  cli: { version: "0.1.22" },
  previous: "RS-1",
  ...over,
});

test("parseSet: a valid set passes; RS-1 has previous null", () => {
  const s = parseSet(base());
  assert.equal(s.id, "RS-2");
  assert.equal(s.previous, "RS-1");
  assert.equal(parseSet(base({ id: "RS-1", previous: null })).previous, null);
});

test("parseSet: lists every problem", () => {
  const err = (() => {
    try {
      parseSet(
        base({
          id: "R-2",
          portalCore: { repo: "portal-core", sha: "abc" },
          bridge: { version: "0.1.29-dev.1" },
          apps: [
            { product: "connect", version: "0.5.8" },
            { product: "connect", version: "0.5.8" },
          ],
        }),
      );
    } catch (e) {
      return (e as Error).message;
    }
    return "";
  })();
  for (const want of ["id must be RS-<n>", "portalCore.repo", "portalCore.sha", "bridge.version", "listed twice"]) assert.ok(err.includes(want), want);
});

test("parseSet: previous must be the set before", () => {
  assert.throws(() => parseSet(base({ previous: "RS-0" })), /previous must be RS-1/);
  assert.throws(() => parseSet(base({ id: "RS-1", previous: "RS-0" })), /RS-1 has no previous/);
  assert.throws(() => parseSet(base({ apps: [] })), /non-empty/);
});

test("planSteps: fixed order core → gui → website; running SHA is skipped", () => {
  const s = parseSet(base());
  const steps = planSteps(s, { "portal-core": sha("a"), "portal-gui": sha("9"), website: null });
  assert.deepEqual(
    steps.map((x) => x.service),
    [...ORDER],
  );
  assert.deepEqual(ORDER, ["portal-core", "portal-gui", "website"]);
  assert.deepEqual(
    steps.map((x) => x.skip),
    [true, false, false],
  );
  assert.equal(steps[1]?.sha, sha("b"));
  // C206 --repoint: nothing is skipped, so every service is redeployed from its (org) source at the same SHA
  assert.deepEqual(
    planSteps(s, { "portal-core": sha("a"), "portal-gui": sha("b"), website: sha("c") }, true).map((x) => x.skip),
    [false, false, false],
  );
});

test("ciGreen: only the Woodpecker push context counts", () => {
  assert.equal(ciGreen([{ context: CI_CONTEXT, state: "success" }]), true);
  assert.equal(ciGreen([{ context: CI_CONTEXT, state: "pending" }]), false);
  assert.equal(ciGreen([{ context: "other", state: "success" }]), false);
  assert.equal(ciGreen([]), false);
});

test("checkIndex: stable + digest required for bridge and every app", () => {
  const s = parseSet(base());
  const dig = `@sha256:${"d".repeat(64)}`;
  const releases = [
    { kind: "bridge", product: "bridge", version: "0.1.29", channel: "stable", image: `ghcr.io/x/bridge${dig}` },
    { kind: "app", product: "connect", version: "0.5.8", channel: "stable", image: `ghcr.io/x/connect${dig}` },
    { kind: "app", product: "knowledge", version: "0.1.19", channel: "dev", image: `ghcr.io/x/knowledge${dig}` },
  ];
  assert.deepEqual(checkIndex(s, releases), ["knowledge@0.1.19 is not a stable app release in the index"]);
  const noDigest = releases.map((r) => (r.product === "connect" ? { ...r, image: "ghcr.io/x/connect:0.5.8" } : r));
  assert.ok(checkIndex(s, noDigest).includes("connect@0.5.8 has no image digest"));
  const ok = releases.map((r) => ({ ...r, channel: "stable" }));
  assert.deepEqual(checkIndex(s, ok), []);
});

test("rollbackCommand + recordPath", () => {
  const s: ReleaseSet = parseSet(base());
  assert.equal(rollbackCommand(s, "/x/releases/RS-2.json"), "node ops/promote.ts --set /x/releases/RS-1.json");
  assert.match(rollbackCommand(parseSet(base({ id: "RS-1", previous: null })), "/x/releases/RS-1.json"), /no previous set/);
  assert.equal(recordPath("/x/releases/RS-2.json", "RS-2"), "/x/releases/RS-2.promoted.json");
  assert.equal(recordPath("/x/releases/RS-2.json", "RS-2", true), "/x/releases/RS-2.repointed.json", "C206: the promotion record is kept");
});

test("parseArgs: --set required and named RS-<n>.json; production (dev) refused", () => {
  assert.deepEqual(parseArgs(["--set", "r/RS-3.json"]), { setFile: "r/RS-3.json", environment: "live", dryRun: false, repoint: false });
  assert.equal(parseArgs(["--set", "r/RS-3.json", "--repoint"]).repoint, true);
  assert.equal(parseArgs(["--set", "r/RS-3.json", "--dry-run"]).dryRun, true);
  assert.throws(() => parseArgs([]), /--set/);
  assert.throws(() => parseArgs(["--set", "r/set.json"]), /RS-<n>.json/);
  assert.throws(() => parseArgs(["--set", "r/RS-3.json", "--environment", "production"]), /DEV/);
  assert.throws(() => parseArgs(["--set", "r/RS-3.json", "--force"]), /unknown option/);
});

test("parseSet: cli.repo optional, must be an opt2 repo", () => {
  assert.equal(parseSet(base({ cli: { version: "0.1.22", repo: "opt2-tealbrick-bridge" } })).cli.repo, "opt2-tealbrick-bridge");
  assert.throws(() => parseSet(base({ cli: { version: "0.1.22", repo: "evil/repo" } })), /cli.repo/);
});

test("C206: promote reads and deploys from the Tealbrick org", () => {
  assert.equal(OWNER, "Tealbrick");
  assert.equal(INDEX_URL, "https://github.com/Tealbrick/opt2-tealbrick-platform/releases/download/registry/index.json");
});
