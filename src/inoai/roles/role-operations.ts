import { InvalidRoleError, listRoles, loadRole, reservedRoleId } from "./role-file.js";

export type RoleOperation = "list" | "show" | "equip" | "unequip";

/** The optional SQLite-only role methods. A store without them (PostgreSQL) does not support roles. */
export type RoleOperationsStore = {
  getEquippedRole?(): Promise<{ role_id: string } | null>;
  equipRole?(roleId: string, actor: string): Promise<{ changed: boolean; previous: { role_id: string } | null }>;
  unequipRole?(actor: string): Promise<{ changed: boolean; previous: { role_id: string } | null }>;
};

export type RoleListOutput = Array<{ id: string; name: string | null; valid: boolean; reason: string | null; equipped: boolean }>;
export type RoleShowOutput = { role_id: string; name: string | null; valid: boolean | null; reason: string | null };
export type RoleWriteOutput = { action: "equip" | "unequip"; role_id: string; previous: string; changed: boolean };
export type RoleOperationOutput = RoleListOutput | RoleShowOutput | RoleWriteOutput;

export const roleCliActor = "cli:owner";
export const roleSchemaUpgradeMessage = "Start the Agent Instance once to upgrade its database.";

/**
 * Role operations for the CLI. They read role files but never create folders or files.
 * `schemaReady` is false when the database has no `role_equips` table yet: reads report no role and writes fail.
 */
export async function manageRoleWithStore(
  store: RoleOperationsStore,
  rolesDirectory: string,
  operation: RoleOperation,
  roleId?: string,
  schemaReady = true,
): Promise<RoleOperationOutput> {
  if (!store.getEquippedRole || !store.equipRole || !store.unequipRole) throw new Error("Roles are supported only with the SQLite store.");
  if (operation === "list" || operation === "show") {
    const equipped = schemaReady ? (await store.getEquippedRole())?.role_id ?? null : null;
    if (operation === "list") return (await listRoles(rolesDirectory)).map(({ id, name, valid, reason }) => ({ id, name, valid, reason, equipped: id === equipped }));
    if (equipped === null) return { role_id: reservedRoleId, name: null, valid: null, reason: null };
    try {
      const role = await loadRole(rolesDirectory, equipped);
      return { role_id: equipped, name: role.name, valid: true, reason: null };
    } catch (error) {
      if (!(error instanceof InvalidRoleError)) throw error;
      return { role_id: equipped, name: null, valid: false, reason: error.reason };
    }
  }
  if (!schemaReady) throw new Error(roleSchemaUpgradeMessage);
  if (operation === "equip") {
    try {
      await loadRole(rolesDirectory, roleId ?? "");
    } catch (error) {
      if (error instanceof InvalidRoleError) throw new Error(`Cannot equip role: ${error.reason}`);
      throw error;
    }
    const result = await store.equipRole(roleId!, roleCliActor);
    return { action: "equip", role_id: roleId!, previous: result.previous?.role_id ?? reservedRoleId, changed: result.changed };
  }
  const result = await store.unequipRole(roleCliActor);
  return { action: "unequip", role_id: reservedRoleId, previous: result.previous?.role_id ?? reservedRoleId, changed: result.changed };
}
