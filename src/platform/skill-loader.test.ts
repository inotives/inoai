import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { bootstrapRuntimeHome } from "./runtime-home.js";
import { enableSkill, installSkillPackage } from "./skill-lifecycle.js";
import { buildEnabledSkillIndex, loadAgentProfileWithSkills, loadSelectedSkill, selectEnabledSkill, SkillSelectionError } from "./skill-loader.js";
import { prepareSkillScript, prepareSkillScripts, SkillScriptError } from "./skill-execution.js";

const manifest = (id: string) => `id: ${id}\nversion: 1.0.0\ncapabilities:\n  filesystem: workspace\n  network: none\n  process/command: none\n  external_mutation: false\n`;

async function packageDirectory(root: string, id: string): Promise<string> {
  const directory = join(root, id);
  await (await import("node:fs/promises")).mkdir(directory, { recursive: true });
  await writeFile(join(directory, "skill.yaml"), manifest(id));
  await writeFile(join(directory, "SKILL.md"), `# ${id}\nFull private instructions for ${id}.\n`);
  return directory;
}

async function scriptPackageDirectory(root: string, id: string): Promise<string> {
  const directory = await packageDirectory(root, id);
  await mkdir(join(directory, "scripts"), { recursive: true });
  await writeFile(join(directory, "scripts", "run.mjs"), "console.log(process.cwd())\n");
  return directory;
}

test("index exposes only current approvals and profile loading does not inject full instructions", async () => {
  const deployment = await mkdtemp(join(tmpdir(), "inoai-skill-loader-"));
  const source = await mkdtemp(join(tmpdir(), "inoai-skill-source-"));
  try {
    const home = await bootstrapRuntimeHome(deployment);
    await installSkillPackage(home, await packageDirectory(source, "web-search"));
    await enableSkill(home, "web-search", "owner");
    const index = await buildEnabledSkillIndex(home);
    assert.deepEqual(index.skills.map((skill) => skill.id), ["web-search"]);
    const profile = await loadAgentProfileWithSkills(home);
    assert.match(profile, /web-search \(version 1\.0\.0\)/);
    assert.doesNotMatch(profile, /Full private instructions/);
  } finally {
    await rm(deployment, { recursive: true, force: true });
    await rm(source, { recursive: true, force: true });
  }
});

test("selection is deterministic, constrained, and fails closed for unknown skills", () => {
  const index = { version: 1 as const, skills: [
    { id: "web-search", version: "1.0.0", capabilities: { filesystem: "workspace", network: "internet", "process/command": "none", external_mutation: false } },
    { id: "web-search-research", version: "1.0.0", capabilities: { filesystem: "workspace", network: "internet", "process/command": "none", external_mutation: false } },
  ] };
  assert.equal(selectEnabledSkill(index, { prompt: "please use web-search" })?.id, "web-search");
  assert.equal(selectEnabledSkill(index, { skillId: "web-search-research" })?.id, "web-search-research");
  assert.throws(() => selectEnabledSkill(index, { skillId: "disabled-skill" }), SkillSelectionError);
  assert.equal(selectEnabledSkill(index, { prompt: "please summarize this" }), undefined);
});

test("full instructions load only for an enabled selected skill", async () => {
  const deployment = await mkdtemp(join(tmpdir(), "inoai-skill-selected-"));
  const source = await mkdtemp(join(tmpdir(), "inoai-skill-source-"));
  try {
    const home = await bootstrapRuntimeHome(deployment);
    await installSkillPackage(home, await packageDirectory(source, "local-helper"));
    assert.equal(await loadSelectedSkill(home, { prompt: "use local-helper" }), undefined);
    await assert.rejects(loadSelectedSkill(home, { skillId: "local-helper" }), SkillSelectionError);
    await enableSkill(home, "local-helper", "owner");
    const instructions = await loadSelectedSkill(home, { skillId: "local-helper" });
    assert.match(instructions!, /Full private instructions/);
    assert.match(instructions!, /provider sandbox, network policy, and approval policy remain authoritative/);
    assert.doesNotMatch(instructions!, /PASSWORD|TOKEN|SECRET|sk-[A-Za-z0-9]/i);
  } finally {
    await rm(deployment, { recursive: true, force: true });
    await rm(source, { recursive: true, force: true });
  }
});

test("approved skill scripts resolve in the project workspace without executing or passing credentials", async () => {
  const deployment = await mkdtemp(join(tmpdir(), "inoai-skill-execution-"));
  const source = await mkdtemp(join(tmpdir(), "inoai-skill-source-"));
  const project = await mkdtemp(join(tmpdir(), "inoai-skill-project-"));
  try {
    const home = await bootstrapRuntimeHome(deployment);
    await installSkillPackage(home, await scriptPackageDirectory(source, "local-helper"));
    await enableSkill(home, "local-helper", "owner");
    const invocation = await prepareSkillScript(home, project, { skillId: "local-helper", scriptPath: "run.mjs" });
    assert.equal(invocation.cwd, project);
    assert.match(invocation.scriptPath, /[\\/]skills[\\/]local-helper[\\/]scripts[\\/]run\.mjs$/);
    const invocations = await prepareSkillScripts(home, project, { skillId: "local-helper" });
    assert.equal(invocations.length, 1);
    assert.equal(invocations[0].scriptPath, invocation.scriptPath);
    assert.doesNotMatch(JSON.stringify(invocation), /PASSWORD|TOKEN|SECRET|\.env/i);
    await assert.rejects(
      prepareSkillScript(home, project, { skillId: "local-helper", scriptPath: "../skill.yaml" }),
      SkillScriptError,
    );
  } finally {
    await rm(deployment, { recursive: true, force: true });
    await rm(source, { recursive: true, force: true });
    await rm(project, { recursive: true, force: true });
  }
});
