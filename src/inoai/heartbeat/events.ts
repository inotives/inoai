import { existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { databaseBusyTimeoutMs, createEvent } from "../connectors/persistence/sqlite/legacy-database.js";
import type { RuntimeHome } from "../agent-instance/runtime-home.js";
import type { HeartbeatEvent } from "./supervisor.js";

export type HeartbeatEventRecorder = ((event: HeartbeatEvent) => Promise<void>) & { close(): void };

export function createHeartbeatEventRecorder(home: RuntimeHome): HeartbeatEventRecorder {
  let database: DatabaseSync | undefined;
  const record = (async (event: HeartbeatEvent) => {
    if (!database) {
      if (!existsSync(home.databaseFile)) throw new Error("SQLite database is unavailable");
      database = new DatabaseSync(home.databaseFile);
      database.exec(`PRAGMA busy_timeout = ${databaseBusyTimeoutMs};`);
    }
    try {
      createEvent(database, { session_id: null, message_id: null, event_type: event.event_type, detail: event.detail }, "heartbeat");
    } catch (error) {
      database.close();
      database = undefined;
      throw error;
    }
  }) as HeartbeatEventRecorder;
  record.close = () => {
    database?.close();
    database = undefined;
  };
  return record;
}
