import { lstat, readFile } from "node:fs/promises";
import { join } from "node:path";

import { loadAgentProfile } from "./agent-profile.js";
import { inspectInstalledSkill } from "./skill-lifecycle.js";
import {
  isSkillApprovalCurrent,
  loadEnabledSkills,
  type EnabledSkillRecord,
  type SkillCapabilities,
} from "./skill-manifest.js";
export type SkillHome = {
  agentFile: string;
  skillsDirectory: string;
  skillsEnabledFile: string;
};

export type EnabledSkillIndexEntry = {
  id: string;
  version: string;
  capabilities: SkillCapabilities;
};

export type EnabledSkillIndex = {
  version: 1;
  skills: EnabledSkillIndexEntry[];
};

export class SkillSelectionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SkillSelectionError";
  }
}

const skillExecutionPolicyInstructions = [
  "",
  "[Skill execution policy]",
  "If this skill needs a local script, use the installed package script with the Agent Runtime project workspace as the current working directory.",
  "Use the provider's normal command tools. The provider sandbox, network policy, and approval policy remain authoritative.",
  "Do not read runtime-home .env files or copy credentials into command arguments, files, prompts, logs, or replies.",
  "Do not install, enable, update, or approve skills from a Turn.",
  "[End skill execution policy]",
].join("\n");

function skillDirectory(home: SkillHome, skillId: string): string {
  return join(home.skillsDirectory, skillId);
}

/**
 * Build the small provider-neutral index from current owner approvals.
 * Stale, missing, or changed packages are not exposed to the runtime.
 */
export async function buildEnabledSkillIndex(home: SkillHome): Promise<EnabledSkillIndex> {
  const trust = await loadEnabledSkills(home.skillsEnabledFile);
  const entries: EnabledSkillIndexEntry[] = [];
  for (const record of trust.skills) {
    try {
      const installed = await inspectInstalledSkill(skillDirectory(home, record.id));
      if (!isSkillApprovalCurrent(record, installed.manifest, installed.hash)) continue;
      entries.push({
        id: installed.manifest.id,
        version: installed.manifest.version,
        capabilities: { ...installed.manifest.capabilities },
      });
    } catch {
      // A package that cannot be revalidated is not trusted for this Turn.
    }
  }
  entries.sort((a, b) => a.id.localeCompare(b.id));
  return { version: 1, skills: entries };
}

function managedSection(index: EnabledSkillIndex): string {
  if (!index.skills.length) return "No skills are enabled for this Agent Instance.";
  return [
    "The harness exposes only the following owner-approved provider-neutral skills.",
    "Full instructions load only when the harness selects a skill for the current Turn.",
    ...index.skills.map((skill) => `- ${skill.id} (version ${skill.version})`),
  ].join("\n");
}

/** Replace only the harness-owned Enabled Skills section in a profile snapshot. */
export function renderEnabledSkillsProfile(profile: string, index: EnabledSkillIndex): string {
  const marker = /^## Enabled Skills\s*$/m;
  const match = marker.exec(profile);
  if (!match) throw new SkillSelectionError("Agent profile is missing the Enabled Skills section");
  const bodyStart = match.index + match[0].length;
  const nextSection = profile.slice(bodyStart).search(/^##\s/m);
  const bodyEnd = nextSection < 0 ? profile.length : bodyStart + nextSection;
  return `${profile.slice(0, bodyStart).trimEnd()}\n\n${managedSection(index)}\n${profile.slice(bodyEnd).replace(/^\n+/, "\n")}`;
}

/** Load a profile snapshot with the current trust-derived skill index. */
export async function loadAgentProfileWithSkills(home: SkillHome): Promise<string> {
  const profile = await loadAgentProfile(home.agentFile);
  return renderEnabledSkillsProfile(profile, await buildEnabledSkillIndex(home));
}

function terms(text: string): string[] {
  return [...new Set((text.toLowerCase().match(/[a-z0-9]+/g) ?? []))];
}

/**
 * Select an enabled skill. Explicit selection always wins and fails closed.
 * Automatic selection is intentionally constrained to tokens in the skill ID.
 */
export function selectEnabledSkill(index: EnabledSkillIndex, request?: { skillId?: string; prompt?: string }): EnabledSkillIndexEntry | undefined {
  const explicit = request?.skillId?.trim();
  if (explicit) {
    const selected = index.skills.find((skill) => skill.id === explicit);
    if (!selected) throw new SkillSelectionError(`Skill is unknown or disabled: ${explicit}`);
    return selected;
  }
  const promptTerms = new Set(terms(request?.prompt ?? ""));
  const matches = index.skills.map((skill) => {
    const score = terms(skill.id).filter((term) => promptTerms.has(term)).length;
    return { skill, score };
  }).filter((item) => item.score > 0).sort((a, b) => b.score - a.score || a.skill.id.localeCompare(b.skill.id));
  return matches[0]?.skill;
}

/**
 * Load full instructions only after the selected skill has passed the current
 * trust and hash checks. Unknown and disabled skills fail closed.
 */
export async function loadSelectedSkill(home: SkillHome, request?: { skillId?: string; prompt?: string }): Promise<string | undefined> {
  const index = await buildEnabledSkillIndex(home);
  const selected = selectEnabledSkill(index, request);
  if (!selected) return undefined;
  const directory = skillDirectory(home, selected.id);
  const file = join(directory, "SKILL.md");
  const info = await lstat(file);
  if (!info.isFile() || info.isSymbolicLink()) throw new SkillSelectionError(`Skill instructions are not a regular file: ${selected.id}`);
  const instructions = (await readFile(file, "utf8")).trim();
  if (!instructions) throw new SkillSelectionError(`Skill instructions are empty: ${selected.id}`);
  return `\n\n[Enabled skill: ${selected.id}]\n${instructions}\n[End enabled skill: ${selected.id}]${skillExecutionPolicyInstructions}`;
}
