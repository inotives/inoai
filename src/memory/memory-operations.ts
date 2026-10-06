import type { MemoryRecord } from "../persistence/legacy-database.js";
import type { OperationalStore } from "../persistence/operational-store.js";

/** Manual Memory operations are deliberately store-only: they never start an
 * Agent Runtime or transport. */
export async function manageMemoryWithStore(
  store: Pick<OperationalStore, "listMemories" | "createMemory" | "softDeleteMemory">,
  operation: "add" | "list" | "delete",
  argument: string | undefined,
  ownerUserId: number | null = null,
): Promise<MemoryRecord | MemoryRecord[] | void> {
  const actor = ownerUserId === null ? "manual-cli" : `manual-cli:user:${ownerUserId}`;
  if (operation === "list") return store.listMemories();
  if (operation === "add") {
    const body = argument?.trim();
    if (!body) throw new Error("Usage: inoai memory add <text>");
    return store.createMemory({ body, source_message_id: null, created_by_user_id: ownerUserId, review_id: null, origin: "manual" }, actor);
  }
  const id = Number(argument);
  if (!Number.isSafeInteger(id) || id < 1) throw new Error("Usage: inoai memory delete <id>");
  if (!(await store.listMemories()).some((memory) => memory.id === id)) throw new Error(`Manual Memory Entry not found: ${id}`);
  await store.softDeleteMemory(id, actor);
}
