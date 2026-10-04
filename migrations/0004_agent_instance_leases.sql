CREATE TABLE IF NOT EXISTS inoai_control.agent_instance_leases (
  agent_instance_id TEXT PRIMARY KEY REFERENCES inoai_control.agent_instances(agent_instance_id) ON DELETE CASCADE,
  owner_token TEXT,
  acquired_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  heartbeat_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS agent_instance_leases_expiry_idx
  ON inoai_control.agent_instance_leases (expires_at);

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE inoai_control.agent_instance_leases TO inoai_sync;
