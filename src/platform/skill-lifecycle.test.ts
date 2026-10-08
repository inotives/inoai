import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { bootstrapRuntimeHome } from "./runtime-home.js";
import { disableSkill, enableSkill, installSkillPackage, inspectInstalledSkill, listInstalledSkills, updateSkillPackage } from "./skill-lifecycle.js";

const manifest = `id: local-helper
version: 1.0.0
capabilities:
  filesystem: workspace
  network: none
  process/command: none
  external_mutation: false
`;

async function packageDirectory(root: string, version = "1.0.0"): Promise<string> {
  const directory = join(root, `package-${version}`);
  await (await import("node:fs/promises")).mkdir(directory, { recursive: true });
  await writeFile(join(directory, "skill.yaml"), manifest.replace("1.0.0", version));
  await writeFile(join(directory, "SKILL.md"), `# Local helper ${version}\n`);
  return directory;
}

test("stages a local package without enabling it, then requires explicit approval", async () => {
  const deployment = await mkdtemp(join(tmpdir(), "inoai-skill-lifecycle-"));
  const sourceRoot = await mkdtemp(join(tmpdir(), "inoai-skill-source-"));
  try {
    const home = await bootstrapRuntimeHome(deployment);
    const source = await packageDirectory(sourceRoot);
    const installed = await installSkillPackage(home, source);
    assert.equal(installed.manifest.id, "local-helper");
    assert.deepEqual(await listInstalledSkills(home).then((items) => items.map((item) => item.enabled)), [false]);
    await assert.rejects(enableSkill(home, "local-helper", ""), /valid approver/);
    await enableSkill(home, "local-helper", "owner");
    assert.deepEqual(await listInstalledSkills(home).then((items) => items.map((item) => item.enabled)), [true]);
    assert.match(await readFile(home.skillsEnabledFile, "utf8"), /local-helper/);
  } finally {
    await rm(deployment, { recursive: true, force: true });
    await rm(sourceRoot, { recursive: true, force: true });
  }
});

test("update replaces the package and revokes approval until reapproval", async () => {
  const deployment = await mkdtemp(join(tmpdir(), "inoai-skill-update-"));
  const sourceRoot = await mkdtemp(join(tmpdir(), "inoai-skill-source-"));
  try {
    const home = await bootstrapRuntimeHome(deployment);
    await installSkillPackage(home, await packageDirectory(sourceRoot));
    await enableSkill(home, "local-helper", "owner");
    const updated = await updateSkillPackage(home, await packageDirectory(sourceRoot, "2.0.0"));
    assert.equal(updated.manifest.version, "2.0.0");
    assert.equal((await listInstalledSkills(home))[0].enabled, false);
    await enableSkill(home, "local-helper", "owner");
    assert.equal((await listInstalledSkills(home))[0].enabled, true);
  } finally {
    await rm(deployment, { recursive: true, force: true });
    await rm(sourceRoot, { recursive: true, force: true });
  }
});

test("rejects malformed packages and package symlinks", async () => {
  const root = await mkdtemp(join(tmpdir(), "inoai-skill-invalid-"));
  try {
    const malformed = join(root, "malformed");
    await (await import("node:fs/promises")).mkdir(malformed);
    await writeFile(join(malformed, "skill.yaml"), manifest);
    await assert.rejects(inspectInstalledSkill(malformed), /SKILL.md is required/);
    const target = await packageDirectory(root);
    const link = join(root, "link");
    await symlink(target, link);
    await assert.rejects(inspectInstalledSkill(link), /real directory/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("disable removes approval but keeps the local package", async () => {
  const deployment = await mkdtemp(join(tmpdir(), "inoai-skill-disable-"));
  const sourceRoot = await mkdtemp(join(tmpdir(), "inoai-skill-source-"));
  try {
    const home = await bootstrapRuntimeHome(deployment);
    await installSkillPackage(home, await packageDirectory(sourceRoot));
    await enableSkill(home, "local-helper", "owner");
    assert.equal(await disableSkill(home, "local-helper"), true);
    assert.equal((await listInstalledSkills(home))[0].enabled, false);
    assert.equal(await disableSkill(home, "local-helper"), false);
  } finally {
    await rm(deployment, { recursive: true, force: true });
    await rm(sourceRoot, { recursive: true, force: true });
  }
});
