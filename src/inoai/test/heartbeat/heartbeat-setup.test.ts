import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { run } from "../../app.js";
import { renderLaunchAgent } from "../../heartbeat/launchagent.js";
import {
  parseHeartbeatSetupCommand,
  preflightHeartbeatSetup,
  reconcileHeartbeatSetup,
  runHeartbeatSetup,
  type HeartbeatSetupFileSystem,
} from "../../heartbeat/setup.js";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "inoai-heartbeat-setup-"));
  const repository = join(root, "checkout");
  await mkdir(join(repository, "dist"), { recursive: true });
  await writeFile(join(repository, "dist", "index.js"), "compiled");
  return { root, repository };
}

const safePreflight = {
  platform: "darwin",
  inspectLock: async () => "missing" as const,
};

test("heartbeat setup requires an explicit connect directory", () => {
  for (const args of [[], ["--connect-dir"], ["--connect-dir", ".inoai-connect", "--connect-dir", ".other"], ["--agent", "robin"]]) {
    assert.throws(() => parseHeartbeatSetupCommand(args), /Usage: inoai heartbeat setup/);
  }
  assert.deepEqual(parseHeartbeatSetupCommand(["--connect-dir", ".robin-xai-test"]), { connectDirectory: ".robin-xai-test" });
});

test("setup preflight rejects a missing compiled entrypoint before service mutation", async () => {
  const root = await mkdtemp(join(tmpdir(), "inoai-heartbeat-setup-missing-"));
  try {
    const result = await preflightHeartbeatSetup(root, { connectDirectory: ".robin-xai-test" }, safePreflight).catch((error: unknown) => error);
    assert.match(result instanceof Error ? result.message : "", /compiled dist\/index\.js/);
    await assert.rejects(stat(join(root, "Library", "LaunchAgents")));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("setup preflight rejects invalid runtime before service mutation", async () => {
  const f = await fixture();
  try {
    await assert.rejects(
      preflightHeartbeatSetup(f.repository, { connectDirectory: "../outside" }, safePreflight),
      /Heartbeat setup target is invalid/,
    );
    await assert.rejects(stat(join(f.root, "Library", "LaunchAgents")));
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test("setup preflight rejects active lock ownership without mutation", async () => {
  const f = await fixture();
  try {
    const result = await preflightHeartbeatSetup(f.repository, { connectDirectory: ".robin-xai-test" }, {
      ...safePreflight,
      inspectLock: async () => "live" as const,
    }).catch((error: unknown) => error);
    assert.match(result instanceof Error ? result.message : "", /active owner/);
    await assert.rejects(stat(join(f.root, "Library", "LaunchAgents")));
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test("setup rejects an independent live lock before LaunchAgent activation", async () => {
  const f = await fixture();
  try {
    let controlCalls = 0;
    await assert.rejects(
      runHeartbeatSetup(f.repository, { connectDirectory: ".robin-xai-test" }, {
        ...safePreflight,
        userHome: f.root,
        uid: 501,
        serviceStatus: async () => ({ loaded: false }),
        launchctl: async () => { controlCalls += 1; return false; },
        inspectLock: async () => "live",
      }),
      /active owner/,
    );
    assert.equal(controlCalls, 0);
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test("setup rejects a lock that changes to a foreign live owner during preflight", async () => {
  const f = await fixture();
  try {
    const inspectedPids: Array<number | undefined> = [];
    let controlCalls = 0;
    await assert.rejects(
      runHeartbeatSetup(f.repository, { connectDirectory: ".robin-xai-test" }, {
        ...safePreflight,
        userHome: f.root,
        uid: 501,
        serviceStatus: async () => ({ loaded: true, supervisorPid: 100 }),
        childPids: async () => [200],
        processAlive: () => true,
        launchctl: async () => { controlCalls += 1; return false; },
        inspectLock: async (_lockFile, expectedPid) => {
          inspectedPids.push(expectedPid);
          return inspectedPids.length === 1 ? "live" : "foreign";
        },
      }),
      /active owner/,
    );
    assert.deepEqual(inspectedPids, [200, 200]);
    assert.equal(controlCalls, 0);
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test("setup sanitizes target service errors", async () => {
  const f = await fixture();
  try {
    const rawPath = join(f.root, "private-secret", "target.plist");
    await assert.rejects(
      runHeartbeatSetup(f.repository, { connectDirectory: ".robin-xai-test" }, {
        ...safePreflight,
        userHome: f.root,
        uid: 501,
        serviceStatus: async () => ({ loaded: false }),
        launchctl: async () => { throw new Error(`EACCES: ${rawPath}`); },
      }),
      (error: unknown) => error instanceof Error
        && /could not inspect the target service/.test(error.message)
        && !error.message.includes(rawPath),
    );
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test("CLI routes setup through the preflight entry point", async () => {
  let received: string | undefined;
  await run(["heartbeat", "setup", "--connect-dir", ".robin-xai-test"], undefined, undefined, {
    heartbeatSetup: async (_repository, command) => {
      received = command.connectDirectory;
      return "preflight";
    },
  });
  assert.equal(received, ".robin-xai-test");
});

test("successful setup preflight reports the compiled target", async () => {
  const f = await fixture();
  try {
    let loaded = false;
    const launchCalls: string[][] = [];
    const launchctl = async (args: string[]) => {
      launchCalls.push(args);
      if (args[0] === "print") return loaded;
      if (args[0] === "bootstrap" || args[0] === "kickstart") { loaded = true; return true; }
      return true;
    };
    const result = await runHeartbeatSetup(f.repository, { connectDirectory: ".robin-xai-test" }, {
      ...safePreflight,
      userHome: f.root,
      uid: 501,
      launchctl,
      serviceStatus: async () => ({ loaded, supervisorPid: 100 }),
      childPids: async () => [200],
      processAlive: () => true,
      inspectLock: async (_lockFile, expectedPid) => expectedPid === 200 ? "live" : "missing",
    });
    assert.match(result, /Heartbeat setup active \(updated\)/);
    assert.match(result, /service loaded, supervisor alive, child alive, runtime lock owned/);
    assert.ok(launchCalls.some((args) => args[0] === "bootstrap"));
    assert.ok(launchCalls.some((args) => args[0] === "kickstart"));
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test("healthy repeated setup reuses the loaded service without kickstart", async () => {
  const f = await fixture();
  try {
    let loaded = false;
    const launchCalls: string[][] = [];
    const launchctl = async (args: string[]) => {
      launchCalls.push(args);
      if (args[0] === "print") return loaded;
      if (args[0] === "bootstrap" || args[0] === "kickstart") { loaded = true; return true; }
      return true;
    };
    const dependencies = {
      ...safePreflight,
      userHome: f.root,
      uid: 501,
      launchctl,
      serviceStatus: async () => ({ loaded, supervisorPid: 100 }),
      childPids: async () => [200],
      processAlive: () => true,
      inspectLock: async (_lockFile: string, expectedPid?: number) => expectedPid === 200 ? "live" as const : "missing" as const,
    };
    await runHeartbeatSetup(f.repository, { connectDirectory: ".robin-xai-test" }, dependencies);
    launchCalls.length = 0;
    const result = await runHeartbeatSetup(f.repository, { connectDirectory: ".robin-xai-test" }, dependencies);
    assert.match(result, /Heartbeat setup active \(unchanged\)/);
    assert.equal(launchCalls.some((args) => args[0] === "kickstart"), false);
    assert.equal(launchCalls.some((args) => args[0] === "bootstrap"), false);
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test("startup verification timeout removes a newly installed service", async () => {
  const f = await fixture();
  try {
    let loaded = false;
    let now = 0;
    const launchCalls: string[][] = [];
    const launchctl = async (args: string[]) => {
      launchCalls.push(args);
      if (args[0] === "print") return loaded;
      if (args[0] === "bootstrap") { loaded = true; return true; }
      if (args[0] === "kickstart") return true;
      if (args[0] === "kill" || args[0] === "bootout") { loaded = false; return true; }
      return true;
    };
    await assert.rejects(
      runHeartbeatSetup(f.repository, { connectDirectory: ".robin-xai-test" }, {
        ...safePreflight,
        userHome: f.root,
        uid: 501,
        launchctl,
        serviceStatus: async () => ({ loaded, supervisorPid: 100 }),
        childPids: async () => [200],
        processAlive: (pid) => pid === 100,
        inspectLock: async () => "missing",
        clock: { now: () => now, sleep: async (milliseconds) => { now += milliseconds; } },
      }),
      /verification timed out/,
    );
    assert.ok(launchCalls.some((args) => args[0] === "bootout"));
    assert.ok(launchCalls.some((args) => args[0] === "print"));
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test("startup verification bounds a hanging service probe per call", async () => {
  const f = await fixture();
  try {
    let loaded = false;
    let now = 0;
    const never = () => new Promise<{ loaded: boolean }>(() => undefined);
    const launchctl = async (args: string[]) => {
      if (args[0] === "print") return loaded;
      if (args[0] === "bootstrap") { loaded = true; return true; }
      if (args[0] === "kickstart") return true;
      if (args[0] === "kill" || args[0] === "bootout") { loaded = false; return true; }
      return true;
    };
    await assert.rejects(
      runHeartbeatSetup(f.repository, { connectDirectory: ".robin-xai-test" }, {
        ...safePreflight,
        userHome: f.root,
        uid: 501,
        launchctl,
        serviceStatus: never,
        inspectLock: async () => "missing",
        probeTimeoutMs: 5,
        clock: { now: () => now, sleep: async (milliseconds) => { now += milliseconds; } },
      }),
      /verification timed out/,
    );
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

function recordingFileSystem(calls: string[]): HeartbeatSetupFileSystem {
  return {
    readFile: async (path) => readFile(path, "utf8"),
    mkdir: async (path, options) => { calls.push(`mkdir:${path}`); await mkdir(path, options); },
    writeFile: async (path, data, options) => { calls.push(`write:${path}`); await writeFile(path, data, options); },
    rename: async (source, destination) => { calls.push(`rename:${source}->${destination}`); await rename(source, destination); },
    rm: async (path, options) => { calls.push(`rm:${path}`); await rm(path, options); },
  };
}

async function reconciliationFixture() {
  const f = await fixture();
  const preflight = await preflightHeartbeatSetup(f.repository, { connectDirectory: ".robin-xai-test" }, safePreflight);
  const fileCalls: string[] = [];
  const launchCalls: string[][] = [];
  let loaded = false;
  const launchctl = async (args: string[]) => {
    launchCalls.push(args);
    if (args[0] === "print") return loaded;
    if (args[0] === "kill" || args[0] === "bootout") { loaded = false; return true; }
    if (args[0] === "bootstrap") { loaded = true; return true; }
    return true;
  };
  return {
    ...f,
    preflight,
    userHome: f.root,
    fileCalls,
    launchCalls,
    setLoaded: (value: boolean) => { loaded = value; },
    launchctl,
    fileSystem: recordingFileSystem(fileCalls),
  };
}

test("unchanged healthy target is reused without restart or rewrite", async () => {
  const f = await reconciliationFixture();
  try {
    await reconcileHeartbeatSetup(f.repository, { connectDirectory: ".robin-xai-test" }, f.preflight, {
      userHome: f.userHome, launchctl: f.launchctl, fileSystem: f.fileSystem, uid: 501,
    });
    f.setLoaded(true);
    f.launchCalls.length = 0;
    f.fileCalls.length = 0;
    const result = await reconcileHeartbeatSetup(f.repository, { connectDirectory: ".robin-xai-test" }, f.preflight, {
      userHome: f.userHome, launchctl: f.launchctl, fileSystem: f.fileSystem, uid: 501,
    });
    assert.equal(result.changed, false);
    assert.equal(result.loaded, true);
    assert.deepEqual(f.launchCalls, [["print", result.target]]);
    assert.equal(f.fileCalls.some((call) => call.startsWith("write:")), false);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test("plist drift stops and unloads only the exact target before replacement", async () => {
  const f = await reconciliationFixture();
  try {
    await reconcileHeartbeatSetup(f.repository, { connectDirectory: ".robin-xai-test" }, f.preflight, {
      userHome: f.userHome, launchctl: f.launchctl, fileSystem: f.fileSystem, uid: 501,
    });
    f.setLoaded(true);
    f.launchCalls.length = 0;
    const result = await reconcileHeartbeatSetup(f.repository, { connectDirectory: ".robin-xai-test" }, f.preflight, {
      userHome: f.userHome, nodeExecutable: "/tmp/alternate-node", launchctl: f.launchctl, fileSystem: f.fileSystem, uid: 501,
    });
    assert.equal(result.changed, true);
    assert.deepEqual(f.launchCalls, [
      ["print", result.target],
      ["kill", "SIGTERM", result.target],
      ["bootout", result.target],
    ]);
    assert.ok(f.fileCalls.some((call) => call.startsWith("rename:")));
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test("PATH drift replaces the LaunchAgent and a repeated PATH is unchanged", async () => {
  const f = await reconciliationFixture();
  const originalPath = process.env.PATH;
  try {
    process.env.PATH = "/first/bin:/usr/bin";
    await reconcileHeartbeatSetup(f.repository, { connectDirectory: ".robin-xai-test" }, f.preflight, {
      userHome: f.userHome, launchctl: f.launchctl, fileSystem: f.fileSystem, uid: 501,
    });
    f.setLoaded(true);
    process.env.PATH = "/second/bin:/usr/bin";
    f.launchCalls.length = 0;
    const updated = await reconcileHeartbeatSetup(f.repository, { connectDirectory: ".robin-xai-test" }, f.preflight, {
      userHome: f.userHome, launchctl: f.launchctl, fileSystem: f.fileSystem, uid: 501,
    });
    assert.equal(updated.changed, true);
    assert.match(await readFile(updated.plistPath, "utf8"), /<key>PATH<\/key><string>\/second\/bin:\/usr\/bin<\/string>/);
    assert.deepEqual(f.launchCalls, [
      ["print", updated.target],
      ["kill", "SIGTERM", updated.target],
      ["bootout", updated.target],
    ]);

    f.launchCalls.length = 0;
    const repeated = await reconcileHeartbeatSetup(f.repository, { connectDirectory: ".robin-xai-test" }, f.preflight, {
      userHome: f.userHome, launchctl: f.launchctl, fileSystem: f.fileSystem, uid: 501,
    });
    assert.equal(repeated.changed, false);
    assert.deepEqual(f.launchCalls, [["print", repeated.target]]);
  } finally {
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
    await rm(f.root, { recursive: true, force: true });
  }
});

test("failed replacement restores the previous plist and loaded target state", async () => {
  const f = await reconciliationFixture();
  try {
    await reconcileHeartbeatSetup(f.repository, { connectDirectory: ".robin-xai-test" }, f.preflight, {
      userHome: f.userHome, launchctl: f.launchctl, fileSystem: f.fileSystem, uid: 501,
    });
    const rendered = renderLaunchAgent(
      f.repository, { operation: "install", connectDirectory: ".robin-xai-test", runAtLoad: true, keepAlive: true }, f.userHome,
    );
    const plistPath = rendered.plistPath;
    const previous = await readFile(plistPath, "utf8");
    f.setLoaded(true);
    f.launchCalls.length = 0;
    let renameCount = 0;
    const failingFileSystem: HeartbeatSetupFileSystem = {
      ...f.fileSystem,
      rename: async (source, destination) => {
        renameCount += 1;
        if (renameCount === 1) throw new Error("simulated plist replacement failure");
        await rename(source, destination);
      },
    };
    await assert.rejects(
      reconcileHeartbeatSetup(f.repository, { connectDirectory: ".robin-xai-test" }, f.preflight, {
        userHome: f.userHome, nodeExecutable: "/tmp/alternate-node", launchctl: f.launchctl, fileSystem: failingFileSystem, uid: 501,
      }),
      /Heartbeat setup reconciliation failed/,
    );
    assert.equal(await readFile(plistPath, "utf8"), previous);
    assert.ok(f.launchCalls.some((args) => args[0] === "bootstrap" && args.at(-1) === plistPath));
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test("bootout failure after kill still restores the previously loaded target", async () => {
  const f = await reconciliationFixture();
  try {
    await reconcileHeartbeatSetup(f.repository, { connectDirectory: ".robin-xai-test" }, f.preflight, {
      userHome: f.userHome, launchctl: f.launchctl, fileSystem: f.fileSystem, uid: 501,
    });
    const rendered = renderLaunchAgent(
      f.repository, { operation: "install", connectDirectory: ".robin-xai-test", runAtLoad: true, keepAlive: true }, f.userHome,
    );
    const plistPath = rendered.plistPath;
    const target = `gui/501/${rendered.label}`;
    const previous = await readFile(plistPath, "utf8");
    f.setLoaded(true);
    f.launchCalls.length = 0;
    const launchctl = async (args: string[]) => {
      f.launchCalls.push(args);
      if (args[0] === "print") return true;
      if (args[0] === "kill") return true;
      if (args[0] === "bootout") throw new Error("simulated bootout failure");
      if (args[0] === "bootstrap") return true;
      return true;
    };
    await assert.rejects(
      reconcileHeartbeatSetup(f.repository, { connectDirectory: ".robin-xai-test" }, f.preflight, {
        userHome: f.userHome, nodeExecutable: "/tmp/alternate-node", launchctl, fileSystem: f.fileSystem, uid: 501,
      }),
      /Heartbeat setup reconciliation failed/,
    );
    assert.equal(await readFile(plistPath, "utf8"), previous);
    assert.deepEqual(f.launchCalls, [
      ["print", target],
      ["kill", "SIGTERM", target],
      ["bootout", target],
      ["bootstrap", "gui/501", plistPath],
    ]);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});
