CREATE TABLE IF NOT EXISTS inoai_control.agent_instances (
  agent_instance_id TEXT PRIMARY KEY,
  agent_name TEXT NOT NULL,
  agent_provider TEXT NOT NULL CHECK (agent_provider IN ('codex', 'claude', 'opencode')),
  runtime_home TEXT NOT NULL,
  agent_schema_name TEXT NOT NULL UNIQUE,
  owner_user_id TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  disabled_at TIMESTAMPTZ,
  CHECK (char_length(agent_instance_id) BETWEEN 7 AND 63),
  CHECK (agent_instance_id ~ '^agent-[a-z0-9]+(?:-[a-z0-9]+)*$'),
  CHECK (char_length(agent_schema_name) BETWEEN 7 AND 63),
  CHECK (agent_schema_name ~ '^agent_[a-z0-9]+(?:_[a-z0-9]+)*$')
);

CREATE INDEX IF NOT EXISTS agent_instances_owner_idx
  ON inoai_control.agent_instances (owner_user_id);

GRANT USAGE ON SCHEMA inoai_control TO inoai_sync;
GRANT SELECT, INSERT, UPDATE ON TABLE inoai_control.agent_instances TO inoai_sync;
