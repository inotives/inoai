/**
 * @deprecated Legacy/UI SQLite persistence compatibility entry point.
 *
 * Operational persistence belongs to `persistence/operational-store.ts`.
 * Keep this explicit shim for existing UI/tests and external imports while
 * the legacy SQLite implementation remains isolated from the operational
 * store.
 */
export * from "./persistence/legacy-database.js";
