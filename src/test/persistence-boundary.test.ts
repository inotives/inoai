import assert from "node:assert/strict";
import test from "node:test";

import { databaseBusyTimeoutMs } from "../persistence/legacy-database.js";
import { PostgresOperationalStore } from "../persistence/operational-store.js";

test("persistence capability exposes separate legacy and operational entry points", () => {
  assert.equal(databaseBusyTimeoutMs, 5_000);
  assert.equal(typeof PostgresOperationalStore, "function");
});
