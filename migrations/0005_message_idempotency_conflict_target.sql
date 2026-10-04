-- Make the archiveMessage ON CONFLICT target inferable by PostgreSQL.
-- Migration 0003 created a partial unique index. PostgreSQL requires the
-- conflict target to include that predicate when using a partial index, while
-- OperationalStore intentionally uses the simpler unqualified target.

ALTER FUNCTION inoai_control.provision_agent_schema(TEXT)
  RENAME TO provision_agent_schema_base;

CREATE OR REPLACE FUNCTION inoai_control.provision_agent_schema(target_schema TEXT)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, inoai_control
AS $function$
BEGIN
  IF target_schema !~ '^agent_[a-z0-9]+(?:_[a-z0-9]+)*$' OR char_length(target_schema) > 63 THEN
    RAISE EXCEPTION 'unsafe Agent Schema name: %', target_schema;
  END IF;

  PERFORM inoai_control.provision_agent_schema_base(target_schema);

  EXECUTE format(
    'CREATE UNIQUE INDEX IF NOT EXISTS unique_external_message_conflict_target ON %I.messages (transport, workspace_id, external_message_id)',
    target_schema
  );
END;
$function$;

REVOKE ALL ON FUNCTION inoai_control.provision_agent_schema(TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION inoai_control.provision_agent_schema_base(TEXT) FROM PUBLIC;

-- Existing Agent Schemas were created by the 0003 function and need the same
-- inferable index. The original partial index is retained for compatibility.
DO $migration$
DECLARE
  schema_name TEXT;
BEGIN
  FOR schema_name IN
    SELECT n.nspname
    FROM pg_namespace AS n
    WHERE n.nspname LIKE 'agent_%'
      AND to_regclass(format('%I.messages', n.nspname)) IS NOT NULL
  LOOP
    EXECUTE format(
      'CREATE UNIQUE INDEX IF NOT EXISTS unique_external_message_conflict_target ON %I.messages (transport, workspace_id, external_message_id)',
      schema_name
    );
  END LOOP;
END;
$migration$;
