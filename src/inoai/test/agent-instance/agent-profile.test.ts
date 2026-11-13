import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  defaultAgentProfile, hasEnabledSkillsSection, InvalidAgentProfileError, loadAgentProfile, validateAgentProfile, withoutEnabledSkillsSection,
} from "../../agent-instance/profile.js";

// The six-section default from before RF-0003. Old homes keep this file and must still work.
const oldFormatProfile = `# Agent Profile

## Identity

You are inoai, a local agent for this Agent Instance.

## Mission and Scope

Help the owner.

## Personality and Communication

Be clear.

## Operating Rules

Plan first.

## Safety and Authority

Follow inoai safety rules.

## Enabled Skills

No skills are enabled for this Agent Instance.
`;

test("the bundled profile is the short format and validates", () => {
  assert.equal(validateAgentProfile(defaultAgentProfile), defaultAgentProfile);
  assert.deepEqual([...defaultAgentProfile.matchAll(/^## (.+)$/gm)].map((m) => m[1]), ["Identity", "Mission", "Style", "Rules"]);
  assert.equal(hasEnabledSkillsSection(defaultAgentProfile), false);
  assert.doesNotMatch(defaultAgentProfile, /Safety|Enabled Skills/);
});

test("only the title and a non-empty Identity are required, and old-format files stay valid", () => {
  const minimal = "# Agent Profile\n\n## Identity\n\nYou are Robin.\n";
  assert.equal(validateAgentProfile(minimal), minimal);
  assert.equal(validateAgentProfile(oldFormatProfile), oldFormatProfile);
  assert.equal(validateAgentProfile(minimal + "\n## Anything Else\n\nFree-form.\n"), minimal + "\n## Anything Else\n\nFree-form.\n");
});

test("profile validation fails closed for missing or malformed sections", () => {
  assert.throws(() => validateAgentProfile("# Agent Profile\n\n## Mission\nHelp."), (error: unknown) =>
    error instanceof InvalidAgentProfileError && error.missingSections.join() === "Identity");
  assert.throws(() => validateAgentProfile("# Agent Profile\n\n## Identity\n\n## Mission\nHelp."), /missing required sections: Identity/);
  assert.throws(() => validateAgentProfile(""), /must not be empty/);
  assert.throws(() => validateAgentProfile("---\n# Agent Profile\n\n## Identity\nx"), /without frontmatter/);
  assert.throws(() => validateAgentProfile("# inoai\n"), /must start/);
});

test("profile loader reads the current file for each call", async () => {
  const directory = await mkdtemp(join(tmpdir(), "inoai-profile-"));
  const file = join(directory, "agent.md");
  try {
    await writeFile(file, defaultAgentProfile.replace("You are inoai", "You are planner"));
    assert.match(await loadAgentProfile(file), /You are planner/);
    await writeFile(file, defaultAgentProfile.replace("You are inoai", "You are coder"));
    assert.match(await loadAgentProfile(file), /You are coder/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("an old Enabled Skills section is found and removed up to the next section", () => {
  assert.equal(hasEnabledSkillsSection(oldFormatProfile), true);
  const stripped = withoutEnabledSkillsSection(oldFormatProfile);
  assert.doesNotMatch(stripped, /Enabled Skills|No skills are enabled/);
  assert.match(stripped, /## Safety and Authority\n\nFollow inoai safety rules\.\n$/);
  const middle = "# Agent Profile\n\n## Identity\n\nRobin.\n\n## Enabled Skills\n\nold list\n\n## Notes\n\nOwner text kept.\n";
  assert.equal(withoutEnabledSkillsSection(middle), "# Agent Profile\n\n## Identity\n\nRobin.\n\n## Notes\n\nOwner text kept.\n");
  assert.equal(withoutEnabledSkillsSection(defaultAgentProfile), defaultAgentProfile);
});
