import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { createAgent } from "../../agent-instance/setup.js";
import { loadConfiguration } from "../../agent-instance/config.js";
import { normalizeDirectoryArgs } from "../../agent-instance/direct-directory.js";
import { bootstrapRuntimeHome, resolveRuntimeHome } from "../../agent-instance/runtime-home.js";
import { start } from "../../app.js";

const execFile = promisify(execFileCallback);

function answers(values: string[]) {
  return async (_prompt: string, secret?: boolean) => {
    if (secret) assert.equal(values.length, 4);
    const result = values.shift();
    assert.notEqual(result, undefined);
    return result!;
  };
}

test("setup creates independent direct homes with private configuration and separate project paths", async () => {
  const root = await mkdtemp(join(tmpdir(), "inoai-create-agent-"));
  try {
    const project = join(root, "project");
    await mkdir(project);
    for (const name of ["alpha", "beta"]) {
      const folder = join(root, name);
      await createAgent(answers([name, folder, project, "codex", "fake.token", "123", "456", "789"]), async () => true);
      const config = await loadConfiguration(join(folder, ".env"));
      assert.equal(config.projectDirectory, await import("node:fs/promises").then((fs) => fs.realpath(project)));
      assert.equal(config.agentInstanceId, `agent-${name}`);
      assert.equal((await stat(join(folder, ".env"))).mode & 0o777, 0o600);
      assert.match(await readFile(join(folder, "agent.md"), "utf8"), /## Identity/);
      assert.deepEqual(JSON.parse(await readFile(join(folder, "skills-enabled.json"), "utf8")).skills, []);
      const normalized = normalizeDirectoryArgs(["--dir", folder, "--port", "1234"]);
      assert.equal(resolveRuntimeHome(root, normalized[1]).directory, folder);
    }
    const folder = join(root, "alpha");
    const before = await readFile(join(folder, ".env"), "utf8");
    await assert.rejects(createAgent(answers(["alpha", folder, project, "codex", "other.token", "123", "456", "789"]), async () => true), /already exists/);
    assert.equal(await readFile(join(folder, ".env"), "utf8"), before);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("direct folder management commands work while the runtime holds its lock", async () => {
  const root = await mkdtemp(join(tmpdir(), "inoai-direct-management-"));
  try {
    const folder = join(root, "agent");
    await createAgent(answers(["demo", folder, root, "codex", "fake.token", "123", "456", "789"]), async () => true);
    const runtime = await start(root, `direct:${folder}`);
    try {
      const entrypoint = join(process.cwd(), "dist", "index.js");
      const invoke = (...args: string[]) => execFile(process.execPath, [entrypoint, ...args, "--dir", folder]);
      const added = await invoke("memory", "add", "A useful preference");
      assert.match(added.stdout, /A useful preference/);
      assert.doesNotMatch(added.stdout + added.stderr, /fake\.token/);
      const listed = await invoke("memory", "list");
      assert.match(listed.stdout, /A useful preference/);
      const skills = await invoke("skills", "list");
      assert.deepEqual(JSON.parse(skills.stdout), []);
    } finally { await runtime.release(); }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("setup rejects bad input before creating an agent and direct selection preserves legacy restrictions", async () => {
  const root = await mkdtemp(join(tmpdir(), "inoai-create-invalid-"));
  try {
    const folder = join(root, "agent");
    await assert.rejects(createAgent(answers(["demo", folder, root, "codex", "fake.token", "bad", "456", "789"]), async () => true), /IDs/);
    await assert.rejects(stat(folder), { code: "ENOENT" });
    await assert.rejects(createAgent(answers(["demo", folder, root, "codex"]), async () => false), /not found on PATH/);
    await writeFile(join(root, "file"), "keep");
    await assert.rejects(bootstrapRuntimeHome(root, `direct:${join(root, "file")}`), /not initialized/);
    assert.throws(() => resolveRuntimeHome(root, "../other"), /direct-child/);
    assert.throws(() => normalizeDirectoryArgs(["--dir", folder, "--connect-dir", ".inoai-connect"]), /without/);
    await assert.rejects(bootstrapRuntimeHome(root, `direct:${folder}`), /not initialized/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("validation and skill commands leave an unrelated direct folder unchanged", async () => {
  const root = await mkdtemp(join(tmpdir(), "inoai-uninitialized-"));
  try {
    await writeFile(join(root, "keep.txt"), "unchanged");
    const entrypoint = join(process.cwd(), "dist", "index.js");
    for (const args of [["validate"], ["skills", "list"]]) {
      await assert.rejects(execFile(process.execPath, [entrypoint, ...args, "--dir", root]), /not initialized/);
      assert.deepEqual(await readdir(root), ["keep.txt"]);
      assert.equal(await readFile(join(root, "keep.txt"), "utf8"), "unchanged");
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});
