import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { launchUi } from "../ui.js";

test("launches a distinct sibling UI process for each selected SQLite path", async () => {
  const deployment = await mkdtemp(join(tmpdir(), "inoai-test-"));
  try {
    const home = join(deployment, ".inoai-connect-2");
    const database = join(home, "inoai.sqlite");
    const otherHome = join(deployment, ".inoai-connect-3");
    const otherDatabase = join(otherHome, "inoai.sqlite");
    await mkdir(join(deployment, "inoai-ui.app"));
    await mkdir(home);
    await mkdir(otherHome);
    await writeFile(database, "unchanged");
    await writeFile(otherDatabase, "also unchanged");

    const calls: Array<{ command: string; args: string[]; detached: boolean }> = [];
    await launchUi(deployment, ".inoai-connect-2", (nextCommand, nextArgs, options) => {
      calls.push({ command: nextCommand, args: nextArgs, detached: options.detached === true });
      return { unref() {} };
    });
    await launchUi(deployment, ".inoai-connect-3", (nextCommand, nextArgs, options) => {
      calls.push({ command: nextCommand, args: nextArgs, detached: options.detached === true });
      return { unref() {} };
    });

    assert.deepEqual(calls, [
      { command: "open", args: ["-n", join(deployment, "inoai-ui.app"), "--args", "--database", database], detached: true },
      { command: "open", args: ["-n", join(deployment, "inoai-ui.app"), "--args", "--database", otherDatabase], detached: true },
    ]);
    assert.equal(await readFile(database, "utf8"), "unchanged");
    assert.equal(await readFile(otherDatabase, "utf8"), "also unchanged");
  } finally {
    await rm(deployment, { recursive: true, force: true });
  }
});
