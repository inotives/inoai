import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { manageLaunchAgent, parseLaunchAgentCommand, renderLaunchAgent, type LaunchAgentCommand } from "../heartbeat/launchagent.js";
import { run } from "../app/application.js";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "inoai-launchagent-"));
  return { root, repository: join(root, "checkout & <test>"), userHome: join(root, "owner"), nodeExecutable: join(root, "node binary"), platform: "darwin", uid: 501 };
}

test("dynamic rendering escapes paths, selects planner, and disables automatic start", async () => {
  const f = await fixture();
  try {
    const rendered = renderLaunchAgent(f.repository, { operation: "render" }, f.userHome, f.nodeExecutable);
    assert.equal(rendered.runtimeHome, join(f.repository, ".inoai-connect-planner"));
    assert.equal(rendered.executable, join(f.repository, "dist", "index.js"));
    assert.ok(rendered.plist.includes(f.nodeExecutable));
    assert.match(rendered.plist, /checkout &amp; &lt;test&gt;/);
    assert.match(rendered.plist, /<string>heartbeat<\/string><string>--connect-dir<\/string><string>\.inoai-connect-planner<\/string>/);
    assert.ok(rendered.plist.includes(join(f.userHome, "Library", "Logs", "inoai", "heartbeat.log")));
    assert.ok(rendered.plist.includes(join(f.userHome, "Library", "Logs", "inoai", "heartbeat-error.log")));
    assert.match(rendered.plist, /<key>RunAtLoad<\/key><false\/>/);
    assert.match(rendered.plist, /<key>KeepAlive<\/key><false\/>/);
    assert.deepEqual(rendered, renderLaunchAgent(f.repository, { operation: "render" }, f.userHome, f.nodeExecutable));
    const alternate = renderLaunchAgent(f.repository, { operation: "render", connectDirectory: ".inoai-connect-test", runAtLoad: true, keepAlive: true }, f.userHome);
    assert.notEqual(alternate.label, rendered.label);
    assert.match(alternate.plist, /<key>KeepAlive<\/key><true\/>/);
    assert.match(alternate.plist, /<key>RunAtLoad<\/key><true\/>/);
    assert.throws(() => renderLaunchAgent(f.repository, { operation: "render", connectDirectory: "../other" }), /direct-child/);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test("install is idempotent and does not call launchctl or initialize runtime data", async () => {
  const f = await fixture();
  try {
    const options = { ...f, launchctl: async () => { assert.fail("installation must not load service"); } };
    const command = { operation: "install" } as const;
    await manageLaunchAgent(f.repository, command, options);
    const rendered = renderLaunchAgent(f.repository, command, f.userHome, f.nodeExecutable);
    const first = await readFile(rendered.plistPath, "utf8");
    await manageLaunchAgent(f.repository, command, options);
    assert.equal(await readFile(rendered.plistPath, "utf8"), first);
    assert.equal(first, rendered.plist);
    await assert.rejects(stat(rendered.runtimeHome), { code: "ENOENT" });
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test("absent plist makes lifecycle operations safe", async () => {
  const f = await fixture();
  try {
    for (const operation of ["status", "stop", "unload", "uninstall"] as const) {
      assert.equal(await manageLaunchAgent(f.repository, { operation }, { ...f, launchctl: async () => { assert.fail("absent service"); } }), "LaunchAgent is not installed");
    }
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test("loaded lifecycle uses scoped service commands and unloads before uninstall", async () => {
  const f = await fixture();
  try {
    const calls: string[][] = [];
    const options = { ...f, launchctl: async (args: string[]) => { calls.push(args); return true; } };
    await manageLaunchAgent(f.repository, { operation: "install" }, options);
    const rendered = renderLaunchAgent(f.repository, { operation: "install" }, f.userHome);
    const target = `gui/501/${rendered.label}`;
    assert.match(await manageLaunchAgent(f.repository, { operation: "status" }, options), /installed and loaded/);
    await manageLaunchAgent(f.repository, { operation: "stop" }, options);
    assert.deepEqual(calls.at(-1), ["kill", "SIGTERM", target]);
    await manageLaunchAgent(f.repository, { operation: "unload" }, options);
    assert.deepEqual(calls.at(-1), ["bootout", target]);
    await manageLaunchAgent(f.repository, { operation: "uninstall" }, options);
    assert.deepEqual(calls.slice(-2), [["print", target], ["bootout", target]]);
    await assert.rejects(stat(rendered.plistPath), { code: "ENOENT" });
    assert.ok(calls.every((args) => args.at(-1) === target));
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test("unloaded and failed service controls preserve safe uninstall behavior", async () => {
  const f = await fixture();
  try {
    await manageLaunchAgent(f.repository, { operation: "install" }, f);
    const rendered = renderLaunchAgent(f.repository, { operation: "install" }, f.userHome);
    const failure = { ...f, launchctl: async () => { throw new Error("control unavailable"); } };
    await assert.rejects(manageLaunchAgent(f.repository, { operation: "uninstall" }, failure), /control unavailable/);
    await stat(rendered.plistPath);
    for (const operation of ["status", "stop", "unload"] as const) {
      const absentCalls: string[][] = [];
      const result = await manageLaunchAgent(f.repository, { operation }, { ...f, launchctl: async (args) => { absentCalls.push(args); return false; } });
      assert.equal(absentCalls.length, 1);
      if (operation === "status") assert.match(result, /not loaded/);
    }
    const calls: string[][] = [];
    await manageLaunchAgent(f.repository, { operation: "uninstall" }, { ...f, launchctl: async (args) => { calls.push(args); return false; } });
    assert.equal(calls.length, 1);
    await assert.rejects(stat(rendered.plistPath), { code: "ENOENT" });
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test("CLI routes explicit operations and rejects invalid options", async () => {
  let received: LaunchAgentCommand | undefined;
  await run(["heartbeat", "launchagent", "install", "--connect-dir", ".inoai-connect-other", "--run-at-load"], undefined, undefined, {
    launchagent: async (_repository, command) => { received = command; return "test install"; },
  });
  assert.deepEqual(received, { operation: "install", connectDirectory: ".inoai-connect-other", runAtLoad: true });
  for (const args of [[], ["start"], ["status", "--keep-alive"], ["install", "--connect-dir"], ["install", "--keep-alive", "--keep-alive"]]) assert.throws(() => parseLaunchAgentCommand(args), /Usage/);
});
