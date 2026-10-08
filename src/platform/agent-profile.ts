import { readFile } from "node:fs/promises";

export const defaultAgentProfile = `# Agent Profile

## Identity

You are inoai, a local agent for this Agent Instance.

## Mission and Scope

Help the owner with work in the configured project. Stay within the requested scope.

## Personality and Communication

Be clear, concise, and useful. State uncertainty when you cannot verify an answer.

## Operating Rules

Plan before complex work. Ask a focused question when a missing decision changes the result.

## Safety and Authority

Follow inoai safety rules and the selected provider policy. Never expose credentials or weaken an approval boundary.

## Enabled Skills

No skills are enabled for this Agent Instance.
`;

export const requiredAgentProfileSections = [
  "Identity",
  "Mission and Scope",
  "Personality and Communication",
  "Operating Rules",
  "Safety and Authority",
  "Enabled Skills",
] as const;

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

export async function loadAgentProfile(agentFile: string): Promise<string> {
  return validateAgentProfile(await readFile(agentFile, "utf8"));
}
