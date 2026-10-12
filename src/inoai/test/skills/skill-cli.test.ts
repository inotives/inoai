import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { bootstrapRuntimeHome } from "../../agent-instance/runtime-home.js";
import { parseSkillsCommand, resolveSkillConnectDirectory } from "../../app.js";
import { disableSkill, enableSkill, installSkillPackage, removeSkill } from "../../skills/skill-lifecycle.js";

test("parses named-agent public skill commands and preserves explicit connect-dir support", () => {
  assert.deepEqual(parseSkillsCommand(["add", "./repo", "--skill", "helper", "--agent", "robin"]), {
    operation: "add", source: "./repo", skillId: "helper", agent: "robin", connectDirectory: ".inoai-connect-robin",
  });
  assert.equal(resolveSkillConnectDirectory(undefined, ".robin-xai-test"), ".robin-xai-test");
  assert.deepEqual(parseSkillsCommand(["list", "--connect-dir", ".robin-xai-test"]), {
    operation: "list", connectDirectory: ".robin-xai-test",
  });
});

test("rejects unsafe targets, ambiguous targets, and unconfirmed removal", () => {
  assert.throws(() => resolveSkillConnectDirectory("../outside"), /safe Agent Instance/);
  assert.throws(() => parseSkillsCommand(["list", "--agent", "robin", "--connect-dir", ".inoai-connect"]), /only one/);
  assert.throws(() => parseSkillsCommand(["remove", "helper", "--agent", "robin"]), /--yes/);
  assert.throws(() => parseSkillsCommand(["enable", "helper", "--package-dir", "."]), /Usage/);
  assert.throws(() => parseSkillsCommand(["disable", "helper", "--package-dir", "."]), /Usage/);
  assert.throws(() => parseSkillsCommand(["remove", "helper", "--yes", "--package-dir", "."]), /Usage/);
  assert.throws(() => parseSkillsCommand(["add", "./repo", "--skill", "helper", "--approved-by", "owner"]), /Usage/);
  assert.throws(() => parseSkillsCommand(["add", "./repo", "--skill", "helper", "--yes"]), /Usage/);
});

test("removal rejects approved packages and deletes only disabled packages", async () => {
  const deployment = await mkdtemp(join(tmpdir(), "inoai-skill-cli-home-"));
  const sourceRoot = await mkdtemp(join(tmpdir(), "inoai-skill-cli-source-"));
  try {
    const home = await bootstrapRuntimeHome(deployment);
    const source = join(sourceRoot, "helper");
    await mkdir(source, { recursive: true });
    await writeFile(join(source, "SKILL.md"), "# helper\n");
    await writeFile(join(source, "skill.yaml"), "id: helper\nversion: 1.0.0\ncapabilities:\n  filesystem: none\n  network: none\n  process/command: none\n  external_mutation: false\n");
    await installSkillPackage(home, source);
    await enableSkill(home, "helper", "owner");
    await assert.rejects(removeSkill(home, "helper"), /disable it/);
    await disableSkill(home, "helper");
    assert.equal(await removeSkill(home, "helper"), true);
    assert.equal(await removeSkill(home, "helper"), false);
  } finally {
    await rm(deployment, { recursive: true, force: true });
    await rm(sourceRoot, { recursive: true, force: true });
  }
});
