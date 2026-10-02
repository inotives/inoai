import assert from "node:assert/strict";
import test from "node:test";

import { probeShowsConcurrentExecution } from "../concurrency-probe.js";

const threads = ["A", "B"];
const notice = (method: string, threadId: string, atMs: number, item?: Record<string, unknown>) => ({
  method, atMs, params: { threadId, ...(item ? { item } : { turn: { status: "completed" } }) },
});
const command = (id: string, exitCode?: number) => ({ type: "commandExecution", id, command: "sleep 8", exitCode });

test("probe requires overlapping completed shell work, not just early turn starts", () => {
  const starts = [notice("turn/started", "A", 0), notice("turn/started", "B", 1)];
  const parallel = [
    ...starts,
    notice("item/started", "A", 100, command("a")),
    notice("item/started", "B", 200, command("b")),
    notice("item/completed", "A", 8_100, command("a", 0)),
    notice("item/completed", "B", 8_200, command("b", 0)),
    notice("turn/completed", "A", 8_300), notice("turn/completed", "B", 8_400),
  ];
  assert.equal(probeShowsConcurrentExecution(threads, parallel), true);
  assert.equal(probeShowsConcurrentExecution(threads, [
    ...parallel.slice(0, 5),
    notice("turn/completed", "A", 8_300),
    notice("item/completed", "B", 16_200, command("b", 0)),
    notice("turn/completed", "B", 16_300),
  ]), false);
  assert.equal(probeShowsConcurrentExecution(threads, [
    ...starts, notice("turn/completed", "A", 8_100), notice("turn/completed", "B", 16_200),
  ]), false);
  assert.equal(probeShowsConcurrentExecution(threads, parallel.map((entry) => entry.method === "item/completed" && entry.params.threadId === "B"
    ? notice("item/completed", "B", entry.atMs, command("b", 1)) : entry)), false);
});
