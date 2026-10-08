import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { defaultAgentProfile, InvalidAgentProfileError, loadAgentProfile, validateAgentProfile } from "./agent-profile.js";

test("the bundled profile has every required section", () => {
  assert.equal(validateAgentProfile(defaultAgentProfile), defaultAgentProfile);
});

test("profile validation fails closed for missing or malformed sections", () => {
  assert.throws(() => validateAgentProfile("# Agent Profile\n\n## Identity\nagent"), InvalidAgentProfileError);
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
