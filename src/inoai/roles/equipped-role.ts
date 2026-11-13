import { InvalidRoleError, loadRole, renderRoleBlock, reservedRoleId } from "./role-file.js";

/** The optional SQLite-only role methods. A store without them (PostgreSQL) applies no role. */
export type RoleStore = {
  getEquippedRole?(): Promise<{ role_id: string } | null>;
  lastAppliedRole?(sessionId: number): Promise<{ roleId: string | null } | undefined>;
  recordRoleApplied?(sessionId: number, roleId: string | null, actor?: string): Promise<unknown>;
};

/**
 * The role for one Turn, read once when the Turn starts. `block` is appended to the instructions, `note` goes in the
 * Turn prompt only, and `record` says whether `role_applied` must be written once the runtime accepts the Turn.
 */
export type TurnRole = { roleId: string | null; block?: string; note?: string; record: boolean };

export function invalidRoleNotice(roleId: string): string {
  return `Equipped role ${roleId} is missing or invalid; fix roles/${roleId}.md or unequip it.`;
}

/** Throws `InvalidRoleError` with `roleId` set when the equipped role file is missing or invalid. */
export async function prepareTurnRole(store: RoleStore, rolesDirectory: string, sessionId: number): Promise<TurnRole> {
  if (!store.getEquippedRole || !store.lastAppliedRole || !store.recordRoleApplied) return { roleId: null, record: false };
  const equipped = await store.getEquippedRole();
  const roleId = equipped?.role_id ?? null;
  let block: string | undefined;
  if (roleId !== null) {
    try {
      block = renderRoleBlock(await loadRole(rolesDirectory, roleId));
    } catch (error: unknown) {
      if (error instanceof InvalidRoleError) throw new InvalidRoleError(error.reason, roleId);
      throw error;
    }
  }
  const last = await store.lastAppliedRole(sessionId);
  const changed = last === undefined || last.roleId !== roleId;
  const note = last !== undefined && changed
    ? `Role changed from ${last.roleId ?? reservedRoleId} to ${roleId ?? reservedRoleId}.` : undefined;
  return { roleId, block, note, record: changed };
}

/** Records the applied role after the runtime accepted the Turn. Best effort: a failed write leaves the note pending. */
export async function recordTurnRole(store: RoleStore, sessionId: number, role: TurnRole, actor: string): Promise<void> {
  if (!role.record || !store.recordRoleApplied) return;
  try {
    await store.recordRoleApplied(sessionId, role.roleId, actor);
  } catch {
    // The next Turn compares against the last record again.
  }
}

/** Puts the change note before the current user message or Task instruction. */
export function withRoleNote(prompt: string, role: TurnRole): string {
  return role.note ? `${role.note}\n\n${prompt}` : prompt;
}
