import assert from "node:assert/strict";
import test from "node:test";
import { assertPatchedNode, isPatchedNode } from "./node-version.mjs";

test("accepts patched versions on supported lines", () => {
  for (const version of ["v22.23.4", "22.24.0", "v24.22.1", "v24.23.0", "v26.12.1", "v26.13.0", "v27.0.0", "v28.1.0"]) assert.equal(isPatchedNode(version), true, version);
});

test("refuses unpatched, odd, older, and malformed versions", () => {
  for (const version of ["v22.23.3", "v22.0.0", "v24.21.0", "v24.22.0", "v26.12.0", "v26.11.9", "v23.99.0", "v25.9.0", "v20.19.0", "nope", ""]) assert.equal(isPatchedNode(version), false, version);
  assert.throws(() => assertPatchedNode("v24.21.0"), /v24\.21\.0 lacks the October 2026 security fixes/);
  assert.doesNotThrow(() => assertPatchedNode("v26.12.1"));
});
