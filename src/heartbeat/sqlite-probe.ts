import { DatabaseSync } from "node:sqlite";
import { workerData } from "node:worker_threads";

// Read only: never create, migrate, recover, or change the child's database.
const database = new DatabaseSync(workerData.databaseFile, { readOnly: true });
try {
  database.exec(`PRAGMA busy_timeout = ${workerData.timeout}`);
  database.prepare("SELECT count(*) FROM sqlite_schema").get();
} finally {
  database.close();
}
