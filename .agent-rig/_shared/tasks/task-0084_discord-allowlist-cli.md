---
id: task-0084
title: Add a CLI for managing Discord allowlist users
type: task
status: done
assigned_to: worker
created_by: planner
created_on: 2026-10-05
updated_on: 2026-10-04
priority: medium
parent: ""
depends_on:
  - task-0083
message: "Independent review clean: CLI behavior, idempotency, guild scoping,
  defaults, owner protection, audit fields, secret-safe errors/docs verified;
  tests/typecheck/build/diff pass."
storage_status: migrated
migrated_to: sqlite
migrated_at: 2026-10-06T13:48:17.599Z
---




# Task

## Goal

Provide a simple credential-safe command for adding and disabling Discord allowlist users without hand-written SQL.

## Scope

- Add `npm run allowlist:add -- --user-id <id> --display-name <name>` using the selected runtime home and PostgreSQL store.
- Use the configured Discord guild/workspace and default new users to active `family`.
- Add a matching disable/remove command or flag with explicit confirmation-safe behavior.
- Never print `POSTGRES_URL`, passwords, bot tokens, or raw driver errors.
- Document the commands and verification query in README/local PostgreSQL docs.

## Acceptance Criteria

- [ ] Add command is idempotent for the same Discord user and guild.
- [ ] New users are active `family` users; owner role is not granted by default.
- [ ] Disable/remove prevents future inbound classification.
- [ ] Missing/invalid arguments fail clearly without secrets.
- [ ] Tests, typecheck, build, and diff checks pass.
