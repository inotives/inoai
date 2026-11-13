import { readFile } from "node:fs/promises";

export const defaultAgentProfile = `# Agent Profile

## Identity

You are inoai, a local agent for this Agent Instance.

## Mission

Help the owner with work in the configured project. Stay within the requested scope.

## Style

Be clear, concise, and useful. State uncertainty when you cannot verify an answer.

## Rules

- Plan before complex work.
- Ask one focused question when a missing decision changes the result.
`;

export const requiredAgentProfileSections = ["Identity"] as const;

/** inoai's own safety text. It is always added after agent.md, so the owner does not repeat it. */
export const inoaiSafetySection = `## inoai Safety

Follow inoai safety rules and the selected provider policy. Never expose credentials or weaken an approval boundary.`;

export const enabledSkillsSectionWarning = "agent.md has an '## Enabled Skills' section. inoai manages enabled skills and ignores this section; remove it.";

export class InvalidAgentProfileError extends Error {
  readonly missingSections: readonly string[];

  constructor(message: string, missingSections: readonly string[] = []) {
    super(message);
    this.name = "InvalidAgentProfileError";
    this.missingSections = missingSections;
  }
}

function sectionBody(profile: string, title: string): string {
  const escaped = title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = profile.match(new RegExp(`^## ${escaped}\\s*$([\\s\\S]*?)(?=^##\\s|(?![\\s\\S]))`, "m"));
  return match?.[1]?.trim() ?? "";
}

export function validateAgentProfile(profile: string): string {
  if (typeof profile !== "string" || !profile.trim()) {
    throw new InvalidAgentProfileError("Agent profile must not be empty");
  }
  if (/^---\s*$/m.test(profile.slice(0, 200))) {
    throw new InvalidAgentProfileError("Agent profile must be Markdown without frontmatter");
  }
  if (!/^# Agent Profile\s*$/m.test(profile)) {
    throw new InvalidAgentProfileError("Agent profile must start with '# Agent Profile'");
  }
  const missing = requiredAgentProfileSections.filter((section) => !sectionBody(profile, section));
  if (missing.length) {
    throw new InvalidAgentProfileError(`Agent profile is missing required sections: ${missing.join(", ")}`, missing);
  }
  return profile;
}

const enabledSkillsHeading = /^## Enabled Skills\s*$/m;

/** True when agent.md still has the old harness-owned Enabled Skills section. */
export function hasEnabledSkillsSection(profile: string): boolean {
  return enabledSkillsHeading.test(profile);
}

/** Removes an old Enabled Skills section, from its heading to the next `##` heading or the end. */
export function withoutEnabledSkillsSection(profile: string): string {
  const match = enabledSkillsHeading.exec(profile);
  if (!match) return profile;
  const bodyStart = match.index + match[0].length;
  const next = profile.slice(bodyStart).search(/^##\s/m);
  const rest = next < 0 ? "" : profile.slice(bodyStart + next);
  return `${profile.slice(0, match.index).trimEnd()}\n${rest ? `\n${rest}` : ""}`;
}

export async function loadAgentProfile(agentFile: string): Promise<string> {
  return validateAgentProfile(await readFile(agentFile, "utf8"));
}
