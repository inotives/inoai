import type { DatabaseSync } from "node:sqlite";
import { BigQuery } from "@google-cloud/bigquery";

import { createEvent, getAgentInstanceMetadata } from "./database.js";
import { redactSecrets } from "./memory-review.js";
import type { BigQueryConfiguration } from "./config.js";

export type BigQueryFieldType = "STRING" | "INT64" | "TIMESTAMP";

export type BigQueryField = {
  name: string;
  type: BigQueryFieldType;
  mode?: "NULLABLE" | "REQUIRED";
};

export type BigQueryTableDefinition = {
  name: string;
  fields: readonly BigQueryField[];
  partitionField: string;
  clusteringFields: readonly string[];
  keyFields: readonly string[];
};

export type BigQueryRow = Record<string, string | number | null>;

export type BigQueryUpsertRequest = {
  projectId: string;
  datasetId: string;
  table: BigQueryTableDefinition;
  rows: readonly BigQueryRow[];
};

/** The cloud adapter is deliberately tiny so tests do not need credentials or the SDK. */
export type BigQueryClient = {
  upsertRows(request: BigQueryUpsertRequest): Promise<void>;
};

export type BigQueryMergeQuery = {
  query: string;
  params: Record<string, string | number | null>;
  types: Record<string, BigQueryFieldType>;
};

/** Builds a typed MERGE so nullable parameters retain their BigQuery type. */
export function buildBigQueryMergeQuery(
  projectId: string,
  datasetId: string,
  table: BigQueryTableDefinition,
  row: BigQueryRow,
): BigQueryMergeQuery {
  const fields = table.fields.map(({ name, type }) => {
    const parameter = `p_${name}`;
    const cast = type === "TIMESTAMP" ? "TIMESTAMP(CAST(@PARAM AS STRING))" : `CAST(@PARAM AS ${type})`;
    return { name, type, expression: cast.replace("@PARAM", `@${parameter}`), value: row[name] };
  });
  const source = fields.map(({ name, expression }) => `${expression} AS \`${name}\``).join(", ");
  const assignments = fields.map(({ name }) => `T.\`${name}\` = S.\`${name}\``).join(", ");
  const columns = fields.map(({ name }) => `\`${name}\``).join(", ");
  const values = fields.map(({ name }) => `S.\`${name}\``).join(", ");
  return {
    query: `MERGE \`${projectId}.${datasetId}.${table.name}\` T
      USING (SELECT ${source}) S
      ON T.\`agent_instance_id\` = S.\`agent_instance_id\` AND T.\`source_id\` = S.\`source_id\`
      WHEN MATCHED THEN UPDATE SET ${assignments}
      WHEN NOT MATCHED THEN INSERT (${columns}) VALUES (${values})`,
    params: Object.fromEntries(fields.map(({ name, value }) => [`p_${name}`, value])),
    types: Object.fromEntries(fields.map(({ name, type }) => [`p_${name}`, type])),
  };
}

/** Uses ADC supplied by the host; credentials never enter inoai configuration or logs. */
export function createBigQueryClient(configuration: Pick<BigQueryConfiguration, "projectId">): BigQueryClient {
  const client = new BigQuery({ projectId: configuration.projectId });
  const tables = new Set<string>();
  return {
    async upsertRows(request) {
      const dataset = client.dataset(request.datasetId);
      const table = dataset.table(request.table.name);
      if (!tables.has(request.table.name)) {
        const [exists] = await table.exists();
        if (!exists) {
          await dataset.createTable(request.table.name, {
            schema: request.table.fields.map(({ name, type, mode }) => ({ name, type, mode })),
            timePartitioning: { type: "DAY", field: request.table.partitionField },
            clustering: { fields: [...request.table.clusteringFields] },
          });
        }
        tables.add(request.table.name);
      }
      for (const row of request.rows) {
        await client.query(buildBigQueryMergeQuery(request.projectId, request.datasetId, request.table, row));
      }
    },
  };
}

export type BigQueryExportResult =
  | { state: "disabled"; reason: "not_configured" }
  | { state: "exported"; tables: number; rows: number }
  | { state: "deferred"; until: number }
  | { state: "failed"; error: unknown };

export type BigQuerySyncClock = {
  now(): Date;
  setInterval(callback: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
};

const systemClock: BigQuerySyncClock = {
  now: () => new Date(),
  setInterval: (callback, ms) => setInterval(callback, ms).unref(),
  clearInterval: (handle) => clearInterval(handle as NodeJS.Timeout),
};

const overlapSeconds = 1;
const maxBackoffSeconds = 60 * 60;
const syncActor = "bigquery-sync";

const commonFields: readonly BigQueryField[] = [
  { name: "agent_instance_id", type: "STRING", mode: "REQUIRED" },
  { name: "agent_name", type: "STRING", mode: "REQUIRED" },
  { name: "source_id", type: "INT64", mode: "REQUIRED" },
  { name: "source_created_at", type: "TIMESTAMP", mode: "REQUIRED" },
  { name: "source_updated_at", type: "TIMESTAMP", mode: "REQUIRED" },
  { name: "source_deleted_at", type: "TIMESTAMP" },
];

const auditFields = [
  { name: "created_by", type: "STRING" as const },
  { name: "updated_by", type: "STRING" as const },
];

const withCommon = (name: string, fields: readonly BigQueryField[]): BigQueryTableDefinition => ({
  name,
  fields: [...commonFields, ...fields, ...auditFields],
  partitionField: "source_updated_at",
  clusteringFields: ["agent_instance_id"],
  keyFields: ["agent_instance_id", "source_id"],
});

export const bigQueryTables = {
  agent_instances: withCommon("agent_instances", [
    { name: "runtime_provider", type: "STRING" },
    { name: "runtime_home_name", type: "STRING" },
  ]),
  sessions: withCommon("sessions", [
    { name: "user_source_id", type: "INT64" },
    { name: "transport", type: "STRING" },
    { name: "workspace_id", type: "STRING" },
    { name: "parent_conversation_id", type: "STRING" },
    { name: "conversation_id", type: "STRING" },
    { name: "initiating_external_message_id", type: "STRING" },
    { name: "agent_provider", type: "STRING" },
    { name: "agent_session_id", type: "STRING" },
    { name: "project_path", type: "STRING" },
    { name: "state", type: "STRING" },
    { name: "ended_at", type: "TIMESTAMP" },
  ]),
  messages: withCommon("messages", [
    { name: "session_source_id", type: "INT64" },
    { name: "transport", type: "STRING" },
    { name: "workspace_id", type: "STRING" },
    { name: "external_message_id", type: "STRING" },
    { name: "external_author_id", type: "STRING" },
    { name: "user_source_id", type: "INT64" },
    { name: "direction", type: "STRING" },
    { name: "redacted_body", type: "STRING" },
    { name: "reply_to_external_message_id", type: "STRING" },
    { name: "in_reply_to_source_id", type: "INT64" },
    { name: "state", type: "STRING" },
    { name: "redacted_failure_detail", type: "STRING" },
    { name: "delivery_state", type: "STRING" },
    { name: "started_at", type: "TIMESTAMP" },
    { name: "runtime_started_at", type: "TIMESTAMP" },
    { name: "completed_at", type: "TIMESTAMP" },
  ]),
  memory_reviews: withCommon("memory_reviews", [
    { name: "session_source_id", type: "INT64" },
    { name: "from_message_source_id", type: "INT64" },
    { name: "through_message_source_id", type: "INT64" },
    { name: "state", type: "STRING" },
    { name: "attempts", type: "INT64" },
    { name: "redacted_recap", type: "STRING" },
    { name: "redacted_failure_detail", type: "STRING" },
    { name: "started_at", type: "TIMESTAMP" },
    { name: "completed_at", type: "TIMESTAMP" },
  ]),
  memories: withCommon("memories", [
    { name: "redacted_body", type: "STRING" },
    { name: "source_message_source_id", type: "INT64" },
    { name: "created_by_user_source_id", type: "INT64" },
    { name: "review_source_id", type: "INT64" },
    { name: "origin", type: "STRING" },
    { name: "state", type: "STRING" },
  ]),
  events: withCommon("events", [
    { name: "session_source_id", type: "INT64" },
    { name: "message_source_id", type: "INT64" },
    { name: "event_type", type: "STRING" },
    { name: "redacted_detail", type: "STRING" },
  ]),
} as const satisfies Record<string, BigQueryTableDefinition>;

type SqlRow = Record<string, unknown>;

type SyncState = {
  table_name: string;
  watermark_updated_at: number | null;
  watermark_source_id: number | null;
  consecutive_failures: number;
  next_attempt_at: number;
};

const timestamp = (value: unknown): string | null => typeof value === "number" ? new Date(value * 1000).toISOString() : null;
const text = (value: unknown): string | null => typeof value === "string" ? redactSecrets(value) : null;
const numberValue = (value: unknown): number | null => typeof value === "number" ? value : null;

function commonRow(metadata: SqlRow, row: SqlRow): BigQueryRow {
  return {
    agent_instance_id: String(metadata.agent_instance_id),
    agent_name: String(metadata.agent_name),
    source_id: numberValue(row.id),
    source_created_at: timestamp(row.created_at),
    source_updated_at: timestamp(row.updated_at),
    source_deleted_at: timestamp(row.deleted_at),
    created_by: text(row.created_by),
    updated_by: text(row.updated_by),
  };
}

function readRows(database: DatabaseSync, metadata: SqlRow, states: Map<string, SyncState>): Array<{ table: BigQueryTableDefinition; rows: BigQueryRow[] }> {
  const rows = (table: BigQueryTableDefinition, sql: string, map: (row: SqlRow) => BigQueryRow, params: readonly number[] = []) => ({
    table,
    rows: (database.prepare(sql).all(...params) as SqlRow[]).map(map),
  });
  const changed = (table: BigQueryTableDefinition, map: (row: SqlRow) => BigQueryRow) => {
    const state = states.get(table.name);
    const since = state?.watermark_updated_at === null || state?.watermark_updated_at === undefined
      ? undefined : Math.max(0, state.watermark_updated_at - overlapSeconds);
    const source = table.name === "agent_instances" ? "agent_instance_metadata" : table.name;
    const filter = table.name === "events" ? " WHERE event_type NOT LIKE 'bigquery_sync_%'" : "";
    return since === undefined
      ? rows(table, `SELECT * FROM ${source}${filter} ORDER BY id`, map)
      : rows(table, `SELECT * FROM ${source}${filter ? `${filter} AND` : " WHERE"} updated_at >= ? ORDER BY id`, map, [since]);
  };
  return [
    changed(bigQueryTables.agent_instances, (row) => ({
      ...commonRow(metadata, row), runtime_provider: text(row.runtime_provider), runtime_home_name: text(row.runtime_home_name),
    })),
    changed(bigQueryTables.sessions, (row) => ({
      ...commonRow(metadata, row), user_source_id: numberValue(row.user_id), transport: text(row.transport), workspace_id: text(row.workspace_id),
      parent_conversation_id: text(row.parent_conversation_id), conversation_id: text(row.conversation_id), initiating_external_message_id: text(row.initiating_external_message_id),
      agent_provider: text(row.agent_provider), agent_session_id: text(row.agent_session_id), project_path: text(row.project_path), state: text(row.state), ended_at: timestamp(row.ended_at),
    })),
    changed(bigQueryTables.messages, (row) => ({
      ...commonRow(metadata, row), session_source_id: numberValue(row.session_id), transport: text(row.transport), workspace_id: text(row.workspace_id),
      external_message_id: text(row.external_message_id), external_author_id: text(row.external_author_id), user_source_id: numberValue(row.user_id), direction: text(row.direction),
      redacted_body: text(row.body), reply_to_external_message_id: text(row.reply_to_external_message_id), in_reply_to_source_id: numberValue(row.in_reply_to_message_id), state: text(row.state),
      redacted_failure_detail: text(row.failure_detail), delivery_state: text(row.delivery_state), started_at: timestamp(row.started_at), runtime_started_at: timestamp(row.runtime_started_at), completed_at: timestamp(row.completed_at),
    })),
    changed(bigQueryTables.memory_reviews, (row) => ({
      ...commonRow(metadata, row), session_source_id: numberValue(row.session_id), from_message_source_id: numberValue(row.from_message_id), through_message_source_id: numberValue(row.through_message_id),
      state: text(row.state), attempts: numberValue(row.attempts), redacted_recap: text(row.recap), redacted_failure_detail: text(row.failure_detail), started_at: timestamp(row.started_at), completed_at: timestamp(row.completed_at),
    })),
    changed(bigQueryTables.memories, (row) => ({
      ...commonRow(metadata, row), redacted_body: text(row.body), source_message_source_id: numberValue(row.source_message_id), created_by_user_source_id: numberValue(row.created_by_user_id),
      review_source_id: numberValue(row.review_id), origin: text(row.origin), state: text(row.state),
    })),
    changed(bigQueryTables.events, (row) => ({
      ...commonRow(metadata, row), session_source_id: numberValue(row.session_id), message_source_id: numberValue(row.message_id), event_type: text(row.event_type), redacted_detail: text(row.detail),
    })),
  ];
}

export async function exportToBigQuery(
  database: DatabaseSync,
  configuration: BigQueryConfiguration | undefined,
  client: BigQueryClient | undefined,
  now = Math.floor(Date.now() / 1000),
): Promise<BigQueryExportResult> {
  if (!configuration || !client) return { state: "disabled", reason: "not_configured" };
  try {
    const metadata = getAgentInstanceMetadata(database) as unknown as SqlRow;
    const states = new Map((database.prepare("SELECT * FROM bigquery_sync_state").all() as SyncState[]).map((state) => [state.table_name, state]));
    const blocked = [...states.values()].find((state) => state.next_attempt_at > now);
    if (blocked) {
      createEvent(database, { session_id: null, message_id: null, event_type: "bigquery_sync_deferred",
        detail: `table=${blocked.table_name}; retry_at=${blocked.next_attempt_at}` }, syncActor);
      return { state: "deferred", until: blocked.next_attempt_at };
    }
    const batches = readRows(database, metadata, states);
    let rows = 0;
    for (const batch of batches) {
      if (!batch.rows.length) {
        database.prepare(`INSERT OR IGNORE INTO bigquery_sync_state
          (table_name, watermark_updated_at, watermark_source_id, consecutive_failures, next_attempt_at, last_error, updated_at)
          VALUES (?, NULL, NULL, 0, 0, NULL, ?)`).run(batch.table.name, now);
        continue;
      }
      try {
        await client.upsertRows({ projectId: configuration.projectId, datasetId: configuration.datasetId, ...batch });
        const max = batch.rows.reduce<{ updated: number; id: number }>((latest, row) => {
          const updated = row.source_updated_at ? Math.floor(Date.parse(String(row.source_updated_at)) / 1000) : 0;
          return updated > latest.updated || (updated === latest.updated && Number(row.source_id) > latest.id)
            ? { updated, id: Number(row.source_id) } : latest;
        }, { updated: 0, id: 0 });
        database.prepare(`INSERT INTO bigquery_sync_state (table_name, watermark_updated_at, watermark_source_id, consecutive_failures, next_attempt_at, last_error, updated_at)
          VALUES (?, ?, ?, 0, 0, NULL, ?) ON CONFLICT(table_name) DO UPDATE SET watermark_updated_at = excluded.watermark_updated_at,
          watermark_source_id = excluded.watermark_source_id, consecutive_failures = 0, next_attempt_at = 0, last_error = NULL, updated_at = excluded.updated_at`)
          .run(batch.table.name, max.updated, max.id, now);
        rows += batch.rows.length;
      } catch (error) {
        const prior = states.get(batch.table.name)?.consecutive_failures ?? 0;
        const failures = prior + 1;
        const retryAt = now + Math.min(2 ** Math.min(failures, 10) * 60, maxBackoffSeconds);
        database.prepare(`INSERT INTO bigquery_sync_state (table_name, consecutive_failures, next_attempt_at, last_error, updated_at)
          VALUES (?, ?, ?, 'unavailable', ?) ON CONFLICT(table_name) DO UPDATE SET consecutive_failures = excluded.consecutive_failures,
          next_attempt_at = excluded.next_attempt_at, last_error = 'unavailable', updated_at = excluded.updated_at`)
          .run(batch.table.name, failures, retryAt, now);
        createEvent(database, { session_id: null, message_id: null, event_type: "bigquery_sync_failed",
          detail: `table=${batch.table.name}; retry_at=${retryAt}` }, syncActor);
        return { state: "failed", error };
      }
    }
    createEvent(database, { session_id: null, message_id: null, event_type: "bigquery_sync_succeeded",
      detail: `tables=${batches.length}; rows=${rows}` }, syncActor);
    return { state: "exported", tables: batches.length, rows };
  } catch (error) {
    return { state: "failed", error };
  }
}

export type BigQuerySyncSchedulerOptions = {
  clock?: BigQuerySyncClock;
  onResult?: (result: BigQueryExportResult) => void;
};

export class BigQuerySyncScheduler {
  private readonly clock: BigQuerySyncClock;
  private interval: unknown;
  private activeRun: Promise<BigQueryExportResult | undefined> | undefined;
  private stopped = false;

  constructor(private readonly database: DatabaseSync, private readonly configuration: BigQueryConfiguration | undefined,
    private readonly client: BigQueryClient | undefined, options: BigQuerySyncSchedulerOptions = {}) {
    this.clock = options.clock ?? systemClock;
    this.onResult = options.onResult;
  }

  private readonly onResult?: (result: BigQueryExportResult) => void;

  start(): void {
    if (this.stopped || this.interval !== undefined) return;
    if (!this.configuration || !this.client) return;
    this.interval = this.clock.setInterval(() => { void this.poke(); }, this.configuration.syncIntervalMinutes * 60_000);
    void this.poke();
  }

  async poke(): Promise<BigQueryExportResult | undefined> {
    if (this.stopped || this.activeRun || !this.configuration || !this.client) return undefined;
    this.activeRun = (async () => {
      const result = await exportToBigQuery(this.database, this.configuration, this.client!, Math.floor(this.clock.now().getTime() / 1000));
      this.onResult?.(result);
      return result;
    })();
    try { return await this.activeRun; } finally { this.activeRun = undefined; }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.interval !== undefined) this.clock.clearInterval(this.interval);
    this.interval = undefined;
    await this.activeRun;
  }
}
