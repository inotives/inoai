# BigQuery is an optional one-way analytics sink

SQLite remains inoai's operational source of truth. Phase 6c adds an asynchronous, configurable SQLite-to-BigQuery export for analytics; BigQuery never becomes a write path for Discord work, queue claims, Memory Reviews, or Manual Memory Entries.

Each runtime home gets a stable generated `agent_instance_id` and a non-unique `agent_name` (defaulting to the runtime-home folder name). Exported rows carry both identifiers. The exporter sends only Conversations, Sessions, Messages, Memory, Recaps, and non-secret Events. Text is redacted with inoai's existing secret rules; credentials, environment values, approval details, and raw tool input/output are excluded. Soft deletes are exported as tombstones.

Sync is optional and non-blocking. Missing configuration or Application Default Credentials leaves inoai fully usable. Unavailable BigQuery records a local non-secret failure and retries later without delaying Discord Turns or Memory Reviews. Incremental writes use durable local watermarks and idempotent source keys. The GCP project and dataset are configurable; exported tables are partitioned by time and clustered by `agent_instance_id`.

## Implementation boundary

The current Phase 6c code implements the local metadata, configuration validation, table definitions, exporter, scheduler, watermark/retry state, and offline fake-sink acceptance. It bundles `@google-cloud/bigquery`, constructs an ADC-backed client when BigQuery is configured, and starts/stops the scheduler from `src/index.ts`. ADC setup and the required project, dataset, and IAM configuration remain host/deployment prerequisites; the offline test suite does not require live cloud credentials.
