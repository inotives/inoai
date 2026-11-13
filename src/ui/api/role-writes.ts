// Role equip and unequip from the local UI (ADR 0031). Each write opens a short-lived SQLite
// connection with the 5-second busy timeout (ADR 0025) and closes it in `finally`.
import type { DatabaseSync } from "node:sqlite";
import type { RuntimeHome } from "../../inoai/agent-instance/runtime-home.js";
import { equipRole, unequipRole } from "../../inoai/connectors/persistence/sqlite/legacy-database.js";
import { InvalidRoleError, isValidRoleId, loadRole } from "../../inoai/roles/role-file.js";
import { roleSchemaUpgradeMessage } from "../../inoai/roles/role-operations.js";
import { readUiRole, type UiRole } from "./read-model.js";
import { asUiWriteError, openUiWriteDatabase, TaskWriteError, uiActor } from "./task-writes.js";

// Opens the existing database and requires the `role_equips` table. The store's equip and unequip
// methods start their own `BEGIN IMMEDIATE` transaction, so `operation` must not open an outer one.
async function withRoleDatabase<T>(home: RuntimeHome, operation: (database: DatabaseSync) => Promise<T>): Promise<T> {
  let database: DatabaseSync | undefined;
  try {
    database = openUiWriteDatabase(home, "Start the agent once before managing roles from the UI.");
    if (!database.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='role_equips'").get()) {
      throw new TaskWriteError(409, roleSchemaUpgradeMessage);
    }
    return await operation(database);
  } catch (error) {
    throw asUiWriteError(error);
  } finally {
    database?.close();
  }
}

/** Equips the role named by `{ roleId }`. Validates the role file with `loadRole` before it writes. */
export async function equipUiRole(home: RuntimeHome, input: unknown): Promise<UiRole> {
  const roleId = input !== null && typeof input === "object" && !Array.isArray(input) ? (input as { roleId?: unknown }).roleId : undefined;
  if (typeof roleId !== "string" || !isValidRoleId(roleId)) throw new TaskWriteError(400, "Invalid role id.");
  return withRoleDatabase(home, async (database) => {
    try {
      await loadRole(home.rolesDirectory, roleId);
    } catch (error) {
      if (!(error instanceof InvalidRoleError)) throw error;
      if (error.reason === "role file not found") throw new TaskWriteError(404, "Role not found.");
      throw new TaskWriteError(409, `Cannot equip role: ${error.reason}`);
    }
    equipRole(database, roleId, uiActor);
    return readUiRole(home.rolesDirectory, roleId);
  });
}

/** Unequips the current role. Succeeds and writes nothing when no role is equipped. */
export async function unequipUiRole(home: RuntimeHome): Promise<null> {
  return withRoleDatabase(home, async (database) => {
    unequipRole(database, uiActor);
    return null;
  });
}
