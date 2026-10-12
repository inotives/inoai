import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { bootstrapRuntimeHome } from "../../agent-instance/runtime-home.js";
import { acquireSkillPackage, SkillAcquisitionError, updateAcquiredSkillPackage } from "../../skills/skill-acquisition.js";
import { enableSkill } from "../../skills/skill-lifecycle.js";
import { loadEnabledSkills, loadSkillManifest } from "../../skills/skill-manifest.js";

async function sourcePackage(root: string, id: string, manifest?: string): Promise<string> {
  const directory = join(root, id);
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, "SKILL.md"), `# ${id}\n`);
  if (manifest) await writeFile(join(directory, "skill.yaml"), manifest);
  return directory;
}

test("acquires a local package, generates a conservative manifest, and copies only the package", async () => {
  const deployment = await mkdtemp(join(tmpdir(), "inoai-acquire-home-"));
  const source = await mkdtemp(join(tmpdir(), "inoai-acquire-source-"));
  try {
    const home = await bootstrapRuntimeHome(deployment);
    const packageDirectory = await sourcePackage(source, "local-skill");
    const installed = await acquireSkillPackage(home, { source: packageDirectory, skill: "local-skill" });
    assert.equal(installed.manifest.capabilities.network, "none");
    assert.match(await readFile(join(installed.directory, "skill.yaml"), "utf8"), /locator: .*local-skill/);
    assert.equal((await readFile(join(home.skillsDirectory, "local-skill", "SKILL.md"), "utf8")), "# local-skill\n");
  } finally {
    await rm(deployment, { recursive: true, force: true });
    await rm(source, { recursive: true, force: true });
  }
});
test("requires selection for a multi-skill local source and preserves approval on failure", async () => {
  const deployment = await mkdtemp(join(tmpdir(), "inoai-acquire-home-"));
  const source = await mkdtemp(join(tmpdir(), "inoai-acquire-source-"));
  try {
    const home = await bootstrapRuntimeHome(deployment);
    await assert.rejects(acquireSkillPackage(home, { source }), SkillAcquisitionError);
    const first = await sourcePackage(source, "one", `id: one\nversion: 1.0.0\ncapabilities:\n  filesystem: none\n  network: none\n  process/command: none\n  external_mutation: none\n`);
    await acquireSkillPackage(home, { source: first, skill: "one" });
    await enableSkill(home, "one", "owner");
    await assert.rejects(acquireSkillPackage(home, { source: join(source, "missing"), skill: "one", update: true }), SkillAcquisitionError);
    assert.match(await readFile(home.skillsEnabledFile, "utf8"), /one/);
    assert.equal(await readFile(join(home.skillsDirectory, "one", "SKILL.md"), "utf8"), "# one\n");
  } finally {
    await rm(deployment, { recursive: true, force: true });
    await rm(source, { recursive: true, force: true });
  }
});

test("updates from remembered source, preserves revision, resets generated capabilities, and revokes approval", async () => {
  const deployment = await mkdtemp(join(tmpdir(), "inoai-acquire-home-"));
  const sourceRoot = await mkdtemp(join(tmpdir(), "inoai-acquire-source-"));
  try {
    const home = await bootstrapRuntimeHome(deployment);
    const source = await sourcePackage(sourceRoot, "generated-skill");
    await acquireSkillPackage(home, { source, skill: "generated-skill", revision: "local-revision" });
    await enableSkill(home, "generated-skill", "owner");
    await writeFile(join(home.skillsDirectory, "generated-skill", "skill.yaml"), `id: generated-skill\nversion: 0.0.0\nsource:\n  locator: ${source}\n  skill: generated-skill\n  revision: local-revision\ncapabilities:\n  filesystem: workspace\n  network: internet\n  process/command: none\n  external_mutation: none\n`);
    await writeFile(join(source, "SKILL.md"), "# updated\n");

    const updated = await updateAcquiredSkillPackage(home, "generated-skill");
    assert.equal(await readFile(join(updated.directory, "SKILL.md"), "utf8"), "# updated\n");
    assert.deepEqual(updated.manifest.source, { locator: source, skill: "generated-skill", revision: "local-revision" });
    assert.deepEqual(updated.manifest.capabilities, { filesystem: "none", network: "none", "process/command": "none", external_mutation: "none" });
    assert.deepEqual((await loadEnabledSkills(home.skillsEnabledFile)).skills, []);
    assert.deepEqual((await loadSkillManifest(join(updated.directory, "skill.yaml"))).capabilities, updated.manifest.capabilities);
  } finally {
    await rm(deployment, { recursive: true, force: true });
    await rm(sourceRoot, { recursive: true, force: true });
  }
});

test("acquires a skills.sh page through npx with non-interactive flags and telemetry disabled", async () => {
  const deployment = await mkdtemp(join(tmpdir(), "inoai-acquire-home-"));
  const staging = await mkdtemp(join(tmpdir(), "inoai-acquire-stage-"));
  const bin = await mkdtemp(join(tmpdir(), "inoai-acquire-bin-"));
  const previousPath = process.env.PATH;
  try {
    const home = await bootstrapRuntimeHome(deployment);
    const npx = join(bin, "npx");
    await writeFile(npx, "#!/bin/sh\nprintf '%s\\n' \"$@\" > npx-args\ntest \"$DISABLE_TELEMETRY\" = 1\nmkdir -p .agents/skills/remote-skill\nprintf '# remote\\n' > .agents/skills/remote-skill/SKILL.md\n");
    await chmod(npx, 0o755);
    process.env.PATH = `${bin}:${previousPath ?? ""}`;
    const installed = await acquireSkillPackage(home, { source: "https://skills.sh/acme/repo/remote-skill", stagingDirectory: staging });
    assert.equal(installed.manifest.id, "remote-skill");
    assert.deepEqual((await readFile(join(staging, "npx-args"), "utf8")).trimEnd().split("\n"), [
      "--yes",
      "skills",
      "add",
      "https://github.com/acme/repo",
      "--skill",
      "remote-skill",
      "--agent",
      "codex",
      "-y",
    ]);
  } finally {
    process.env.PATH = previousPath;
    await rm(deployment, { recursive: true, force: true });
    await rm(staging, { recursive: true, force: true });
    await rm(bin, { recursive: true, force: true });
  }
});
