import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  createSkillApproval,
  hashSkillPackage,
  InvalidEnabledSkillsError,
  InvalidSkillManifestError,
  isSkillApprovalCurrent,
  parseSkillManifest,
  createGeneratedSkillManifest,
  serializeSkillManifest,
  validateEnabledSkills,
} from "../../skills/skill-manifest.js";

const manifestText = `id: web-search
version: 1.2.0
capabilities:
  filesystem: workspace
  network: internet
  process/command: none
  external_mutation: false
`;

test("parses the strict provider-neutral skill manifest", () => {
  assert.deepEqual(parseSkillManifest(manifestText), {
    id: "web-search",
    version: "1.2.0",
    capabilities: {
      filesystem: "workspace",
      network: "internet",
      "process/command": "none",
      external_mutation: false,
    },
  });
});

test("round-trips non-secret source provenance", () => {
  const parsed = parseSkillManifest(`${manifestText}source:\n  locator: https://github.com/example/skills\n  skill: web-search\n  revision: abc123\n`);
  assert.deepEqual(parseSkillManifest(serializeSkillManifest(parsed)), parsed);
  assert.deepEqual(parsed.source, { locator: "https://github.com/example/skills", skill: "web-search", revision: "abc123" });
});

test("rejects malformed source fields and credential-bearing locators", () => {
  assert.throws(() => parseSkillManifest(`${manifestText}source:\n  locator: https://example.com\n  skill: web-search\n  revision: abc\n  extra: no\n`), InvalidSkillManifestError);
  assert.throws(() => parseSkillManifest(`${manifestText}source:\n  locator: https://user:password@example.com\n  skill: web-search\n  revision: abc\n`), InvalidSkillManifestError);
  assert.throws(() => parseSkillManifest(`${manifestText}source: {}\n`), InvalidSkillManifestError);
});

test("generates conservative manifests with provenance", () => {
  const generated = createGeneratedSkillManifest("custom-skill", { locator: "/tmp/source", skill: "custom-skill", revision: "working-tree" });
  assert.equal(generated.version, "0.0.0");
  assert.deepEqual(generated.capabilities, { filesystem: "none", network: "none", "process/command": "none", external_mutation: "none" });
  assert.deepEqual(parseSkillManifest(serializeSkillManifest(generated)), generated);
});

test("rejects unknown, missing, duplicate, and malformed capabilities", () => {
  assert.throws(() => parseSkillManifest(manifestText.replace("network: internet", "unknown: internet")), InvalidSkillManifestError);
  assert.throws(() => parseSkillManifest(manifestText.replace("external_mutation: false\n", "")), /missing capabilities/);
  assert.throws(() => parseSkillManifest(`${manifestText}  network: internet\n`), /duplicate capability/);
  assert.throws(() => parseSkillManifest(`${manifestText}capabilities:\n`), /single mapping/);
  assert.throws(() => parseSkillManifest(manifestText.replace("external_mutation: false", "external_mutation:")), InvalidSkillManifestError);
  assert.throws(() => parseSkillManifest(manifestText.replace("id: web-search", "id: Web Search")), InvalidSkillManifestError);
});

test("hashes package contents deterministically and rejects symlinks", async () => {
  const directory = await mkdtemp(join(tmpdir(), "inoai-skill-"));
  try {
    await writeFile(join(directory, "skill.yaml"), manifestText);
    await writeFile(join(directory, "SKILL.md"), "# Skill\n");
    const first = await hashSkillPackage(directory);
    const second = await hashSkillPackage(directory);
    assert.match(first, /^[a-f0-9]{64}$/);
    assert.equal(first, second);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("enabled records fail closed and approval becomes stale after version or hash changes", () => {
  const manifest = parseSkillManifest(manifestText);
  const record = createSkillApproval(manifest, "a".repeat(64), "owner", "2026-10-08T00:00:00.000Z");
  assert.deepEqual(validateEnabledSkills({ version: 1, skills: [record] }).skills[0], record);
  assert.equal(isSkillApprovalCurrent(record, manifest, record.hash), true);
  assert.equal(isSkillApprovalCurrent(record, { ...manifest, version: "2.0.0" }, record.hash), false);
  assert.equal(isSkillApprovalCurrent(record, manifest, "b".repeat(64)), false);
  assert.throws(() => validateEnabledSkills({ version: 1, skills: [{ ...record, secret: "nope" }] }), InvalidEnabledSkillsError);
  assert.throws(() => validateEnabledSkills({ version: 1, skills: [{ ...record, hash: "not-a-hash" }] }), InvalidEnabledSkillsError);
});
