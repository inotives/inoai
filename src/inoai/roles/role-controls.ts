import { InvalidRoleError, listRoles, loadRole } from "./role-file.js";
import type { RoleOperationsStore } from "./role-operations.js";

export type RoleControlCommand = "role-list" | "role-show" | "role-equip" | "role-unequip";

export const roleDiscordActor = "discord:owner";
export const rolesUnsupported = "Roles are not supported with this store.";
const replyLimit = 1900;

function clip(text: string, limit: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > limit ? `${flat.slice(0, limit - 1)}…` : flat;
}

function label(name: string, id: string): string {
  return `${clip(name, 60)} (${id})`;
}

/**
 * Discord replies for `/inoai role`. The caller has already checked the owner. Replies show only the role name and a
 * shortened summary of valid roles, never other role file text, and stay within the Discord reply limit.
 */
export async function roleControlReply(store: RoleOperationsStore, rolesDirectory: string, command: RoleControlCommand, roleId?: string): Promise<string> {
  if (!store.getEquippedRole || !store.equipRole || !store.unequipRole) return rolesUnsupported;
  if (command === "role-list") {
    const equipped = (await store.getEquippedRole())?.role_id ?? null;
    const roles = await listRoles(rolesDirectory);
    if (!roles.length) return "No roles found. Add role files to the runtime home's roles/ folder.";
    const lines = roles.map((role) => {
      const mark = role.id === equipped ? " [equipped]" : "";
      return role.valid && role.name !== null
        ? `${role.id}${mark}: ${clip(role.name, 60)} — ${clip(role.summary ?? "", 80)}`
        : `${role.id}${mark}: invalid: ${role.reason ?? "unknown"}`;
    });
    const shown: string[] = [];
    let length = 0;
    for (const [index, line] of lines.entries()) {
      const rest = lines.length - index - 1;
      const reserve = rest ? `\n…and ${lines.length} more.`.length : 0;
      if (length + (shown.length ? 1 : 0) + line.length + reserve > replyLimit) break;
      length += (shown.length ? 1 : 0) + line.length;
      shown.push(line);
    }
    if (shown.length < lines.length) shown.push(`…and ${lines.length - shown.length} more.`);
    return shown.join("\n");
  }
  if (command === "role-show") {
    const equipped = (await store.getEquippedRole())?.role_id ?? null;
    if (equipped === null) return "No role is equipped. The base Agent Profile applies.";
    try {
      const role = await loadRole(rolesDirectory, equipped);
      return `Equipped role: ${label(role.name, equipped)}\n${clip(role.summary, 300)}`;
    } catch (error) {
      if (!(error instanceof InvalidRoleError)) throw error;
      return `Equipped role ${equipped} is missing or invalid (${error.reason}); fix roles/${equipped}.md or unequip it.`;
    }
  }
  if (command === "role-equip") {
    let role;
    try {
      role = await loadRole(rolesDirectory, roleId ?? "");
    } catch (error) {
      if (!(error instanceof InvalidRoleError)) throw error;
      return `Cannot equip role: ${error.reason}. Use /inoai role list to see valid roles.`;
    }
    const result = await store.equipRole(role.id, roleDiscordActor);
    return result.changed
      ? `Role equipped: ${label(role.name, role.id)}. Previous: ${result.previous?.role_id ?? "none"}. It applies from the next Turn.`
      : `Role ${label(role.name, role.id)} is already equipped.`;
  }
  const result = await store.unequipRole(roleDiscordActor);
  return result.changed && result.previous
    ? `Role ${result.previous.role_id} unequipped. The base Agent Profile applies from the next Turn.`
    : "No role is equipped.";
}

/** The `/inoai status` role line: `Role: <name> (<id>)` or `Role: none`. */
export async function roleStatusLine(store: RoleOperationsStore, rolesDirectory: string): Promise<string> {
  const equipped = store.getEquippedRole ? (await store.getEquippedRole())?.role_id ?? null : null;
  if (equipped === null) return "Role: none";
  try {
    return `Role: ${label((await loadRole(rolesDirectory, equipped)).name, equipped)}`;
  } catch (error) {
    if (!(error instanceof InvalidRoleError)) throw error;
    return `Role: ${equipped} (invalid: ${error.reason})`;
  }
}
