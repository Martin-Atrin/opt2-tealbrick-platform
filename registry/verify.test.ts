import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { test } from "node:test";
import { verifyIndex } from "./verify.ts";

test("verifyIndex accepts a signed index and rejects tampering or a foreign key", () => {
  const a = generateKeyPairSync("ed25519");
  const b = generateKeyPairSync("ed25519");
  const pubA = a.publicKey.export({ type: "spki", format: "pem" }).toString();
  const pubB = b.publicKey.export({ type: "spki", format: "pem" }).toString();
  const text = `${JSON.stringify({ schema: "opt2.release-index/v1", kid: "k", generatedAt: "t", releases: [] }, null, 2)}\n`;
  const sig = sign(null, new TextEncoder().encode(text), a.privateKey).toString("base64");
  assert.equal(verifyIndex(text, sig, pubA).releases.length, 0);
  assert.throws(() => verifyIndex(text.replace("[]", '[{"x":1}]'), sig, pubA), /does not verify/);
  assert.throws(() => verifyIndex(text, sig, pubB), /does not verify/);
});
