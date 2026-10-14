// PLAT-01: a failing restore test never prunes the good dumps; it deletes its own dump instead (L34: fires + quiet).
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { retain } from "./backup.ts";

function dirWith(n: number): string {
  const d = mkdtempSync(join(tmpdir(), "tb-backup-"));
  mkdirSync(d, { recursive: true });
  for (let i = 1; i <= n; i++) writeFileSync(join(d, `portal-2026-10-${String(i).padStart(2, "0")}T000000Z.dump`), "x");
  writeFileSync(join(d, "RESTORE-LOG.jsonl"), "");
  return d;
}

test("PLAT-01: a failed restore deletes only its own dump and prunes nothing", () => {
  const d = dirWith(16);
  try {
    const removed = retain(d, "portal-2026-10-16T000000Z.dump", false, 14);
    assert.deepEqual(removed, ["portal-2026-10-16T000000Z.dump"]);
    const left = readdirSync(d).filter((f) => f.endsWith(".dump"));
    assert.equal(left.length, 15, "every earlier dump is kept (no pruning on failure)");
    assert.ok(left.includes("portal-2026-10-01T000000Z.dump"), "the oldest good dump survives");
    assert.ok(readdirSync(d).includes("RESTORE-LOG.jsonl"));
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});

test("PLAT-01: a passing restore prunes to KEEP, newest kept, the log untouched", () => {
  const d = dirWith(16);
  try {
    const removed = retain(d, "portal-2026-10-16T000000Z.dump", true, 14);
    assert.deepEqual(removed, ["portal-2026-10-01T000000Z.dump", "portal-2026-10-02T000000Z.dump"]);
    const left = readdirSync(d).filter((f) => f.endsWith(".dump"));
    assert.equal(left.length, 14);
    assert.ok(left.includes("portal-2026-10-16T000000Z.dump"), "this run's good dump is kept");
    assert.ok(readdirSync(d).includes("RESTORE-LOG.jsonl"));
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});
