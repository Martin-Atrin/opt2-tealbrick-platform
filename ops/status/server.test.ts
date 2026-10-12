import assert from "node:assert/strict";
import { test } from "node:test";
import { probe } from "./server.ts";

const t = (expect: { status: number; bodyIncludes?: string }) => ({ id: "x", name: "X", url: "https://example.invalid/", expect });
const fake = (status: number, body = ""): typeof fetch => (async () => new Response(body, { status })) as typeof fetch;

test("probe: status and body expectations", async () => {
  assert.equal((await probe(t({ status: 200 }), fake(200))).ok, true);
  assert.equal((await probe(t({ status: 200 }), fake(503))).ok, false);
  assert.equal((await probe(t({ status: 401, bodyIncludes: '"error"' }), fake(401, '{"error":{}}'))).ok, true);
  assert.equal((await probe(t({ status: 401, bodyIncludes: '"error"' }), fake(401, "<html>"))).ok, false);
  const down = await probe(t({ status: 200 }), (async () => {
    throw new TypeError("fetch failed");
  }) as typeof fetch);
  assert.deepEqual([down.ok, down.detail], [false, "unreachable"]);
});
