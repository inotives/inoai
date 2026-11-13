import { lstat, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { secretLike } from "../conversation/prompt-context.js";

export const roleIdPattern = /^[a-z0-9][a-z0-9-]{0,63}$/;
export const maxRoleBytes = 49_152;
/** Means "no role" in `role_applied` details and change notes, so no role file may use it. */
export const reservedRoleId = "none";

export type RoleContent = {
  name: string;
  summary: string;
  instructions: string;
  workflow: string;
};

export type Role = RoleContent & { id: string };

export type RoleListEntry = {
  id: string;
  name: string | null;
  summary: string | null;
  valid: boolean;
  reason: string | null;
};

/** A role file that cannot be used. `reason` is short and never quotes the file text. `roleId` names the equipped role, when known. */
export class InvalidRoleError extends Error {
  readonly reason: string;
  readonly roleId?: string;

  constructor(reason: string, roleId?: string) {
    super(`Invalid role: ${reason}`);
    this.name = "InvalidRoleError";
    this.reason = reason;
    this.roleId = roleId;
  }
}

export function isValidRoleId(roleId: string): boolean {
  return typeof roleId === "string" && roleIdPattern.test(roleId) && roleId !== reservedRoleId;
}

function sectionBody(text: string, title: string): string {
  const match = text.match(new RegExp(`^## ${title}[ \\t]*$([\\s\\S]*?)(?=^##\\s|(?![\\s\\S]))`, "m"));
  return match?.[1]?.trim() ?? "";
}

export function validateRole(text: string): RoleContent {
  if (typeof text !== "string") throw new InvalidRoleError("role file must be text");
  if (Buffer.byteLength(text, "utf8") > maxRoleBytes) throw new InvalidRoleError(`larger than ${maxRoleBytes} bytes`);
  if (secretLike.test(text)) throw new InvalidRoleError("secret-like text");
  if (text.startsWith("---")) throw new InvalidRoleError("frontmatter is not allowed");
  const heading = text.match(/^# Role:[ \t]*(\S[^\r\n]*?)[ \t]*(?:\r?\n|$)/);
  if (!heading) throw new InvalidRoleError("first line must be '# Role: <Name>'");
  const rest = text.slice(heading[0].length);
  const summary = (rest.match(/^##\s/m) ? rest.slice(0, rest.search(/^##\s/m)) : rest).trim();
  if (!summary) throw new InvalidRoleError("empty summary paragraph");
  const instructions = sectionBody(rest, "Instructions");
  if (!instructions) throw new InvalidRoleError("missing or empty '## Instructions' section");
  const workflow = sectionBody(rest, "Workflow");
  if (!workflow) throw new InvalidRoleError("missing or empty '## Workflow' section");
  return { name: heading[1], summary, instructions, workflow };
}

export async function loadRole(rolesDirectory: string, roleId: string): Promise<Role> {
  if (roleId === reservedRoleId) throw new InvalidRoleError("reserved role id");
  if (!isValidRoleId(roleId)) throw new InvalidRoleError("invalid role id");
  const file = join(rolesDirectory, `${roleId}.md`);
  let text: string;
  try {
    const stats = await lstat(file);
    if (!stats.isFile()) throw new InvalidRoleError("not a regular file");
    if (stats.size > maxRoleBytes) throw new InvalidRoleError(`larger than ${maxRoleBytes} bytes`);
    text = await readFile(file, "utf8");
  } catch (error: unknown) {
    if (error instanceof InvalidRoleError) throw error;
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new InvalidRoleError("role file not found");
    throw new InvalidRoleError("role file cannot be read");
  }
  return { id: roleId, ...validateRole(text) };
}

/** Lists `*.md` entries in `rolesDirectory`. A missing folder lists nothing; it never creates anything. */
export async function listRoles(rolesDirectory: string): Promise<RoleListEntry[]> {
  let names: string[];
  try {
    names = await readdir(rolesDirectory);
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const ids = names.filter((name) => name.endsWith(".md")).map((name) => name.slice(0, -".md".length)).sort();
  return Promise.all(ids.map(async (id): Promise<RoleListEntry> => {
    try {
      const role = await loadRole(rolesDirectory, id);
      return { id, name: role.name, summary: role.summary, valid: true, reason: null };
    } catch (error: unknown) {
      if (!(error instanceof InvalidRoleError)) throw error;
      return { id, name: null, summary: null, valid: false, reason: error.reason };
    }
  }));
}

export const roleAuthorityLine = "This Equipped Role ranks below the Agent Profile and inoai safety rules. Follow them when they conflict.";

export function renderRoleBlock(role: RoleContent): string {
  return [
    `## Equipped Role: ${role.name}`,
    role.summary,
    "### Instructions",
    role.instructions,
    "### Workflow",
    role.workflow,
    roleAuthorityLine,
  ].join("\n\n") + "\n";
}
