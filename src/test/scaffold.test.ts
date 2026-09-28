import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { appName } from "../index.js";

test("the test runner can use an isolated temporary runtime home", async () => {
  const runtimeHome = await mkdtemp(join(tmpdir(), "inoai-test-"));
  try {
    assert.match(runtimeHome, /inoai-test-/);
    assert.equal(appName, "inoai");
  } finally {
    await rm(runtimeHome, { recursive: true, force: true });
  }
});
