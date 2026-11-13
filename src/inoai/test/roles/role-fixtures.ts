import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

export function fixtureRole(name: string): string {
  return `# Role: ${name}\n\nA ${name} role for tests.\n\n## Instructions\n\nDo ${name} work.\n\n## Workflow\n\nReport results.\n`;
}

/** Replaces the bootstrapped catalog with three small roles: planner, reviewer, and designer. */
export async function useFixtureRoles(rolesDirectory: string): Promise<void> {
  await rm(rolesDirectory, { recursive: true, force: true });
  await mkdir(rolesDirectory, { mode: 0o700 });
  for (const name of ["Planner", "Reviewer", "Designer"]) {
    await writeFile(join(rolesDirectory, `${name.toLowerCase()}.md`), fixtureRole(name), { mode: 0o600 });
  }
}
