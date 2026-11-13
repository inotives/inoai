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

const fenceOpen = /^ {0,3}(`{3,}|~{3,})/;

/**
 * Splits text into lines, each tagged as a `##` section boundary or not. Lines inside fenced code
 * blocks (``` or ~~~, indented 0-3 spaces, closed by the same marker at the same or greater length)
 * are never boundaries. An unclosed fence makes the role invalid.
 */
function scanLines(text: string): { line: string; boundary: boolean }[] {
  let fence: string | null = null;
  const lines = text.split("\n").map((line) => {
    const marker = line.match(fenceOpen)?.[1];
    if (fence) {
      if (marker && marker[0] === fence[0] && marker.length >= fence.length && line.trim() === marker) fence = null;
      return { line, boundary: false };
    }
    if (marker) {
      fence = marker;
      return { line, boundary: false };
    }
    return { line, boundary: /^##(?:\s|$)/.test(line) };
  });
  if (fence) throw new InvalidRoleError("unclosed code fence");
  return lines;
}

function sectionBody(lines: { line: string; boundary: boolean }[], title: string): string {
  const start = lines.findIndex(({ line, boundary }) => boundary && new RegExp(`^## ${title}[ \\t]*\r?$`).test(line));
  if (start < 0) return "";
  let end = start + 1;
  while (end < lines.length && !lines[end]!.boundary) end += 1;
  return lines.slice(start + 1, end).map(({ line }) => line).join("\n").trim();
}

export function validateRole(text: string): RoleContent {
  if (typeof text !== "string") throw new InvalidRoleError("role file must be text");
  if (Buffer.byteLength(text, "utf8") > maxRoleBytes) throw new InvalidRoleError(`larger than ${maxRoleBytes} bytes`);
  if (secretLike.test(text)) throw new InvalidRoleError("secret-like text");
  if (text.startsWith("---")) throw new InvalidRoleError("frontmatter is not allowed");
  const heading = text.match(/^# Role:[ \t]*(\S[^\r\n]*?)[ \t]*(?:\r?\n|$)/);
  if (!heading) throw new InvalidRoleError("first line must be '# Role: <Name>'");
  const lines = scanLines(text.slice(heading[0].length));
  const firstBoundary = lines.findIndex(({ boundary }) => boundary);
  const summary = lines.slice(0, firstBoundary < 0 ? lines.length : firstBoundary).map(({ line }) => line).join("\n").trim();
  if (!summary) throw new InvalidRoleError("empty summary paragraph");
  const instructions = sectionBody(lines, "Instructions");
  if (!instructions) throw new InvalidRoleError("missing or empty '## Instructions' section");
  const workflow = sectionBody(lines, "Workflow");
  if (!workflow) throw new InvalidRoleError("missing or empty '## Workflow' section");
  return { name: heading[1]!, summary, instructions, workflow };
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
