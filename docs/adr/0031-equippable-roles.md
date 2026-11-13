---
status: accepted
---

# Equippable roles overlay the Agent Profile

An Agent Instance has one Agent Profile, `agent.md`. The owner wanted to switch the agent between working modes, such as planner, reviewer, or designer, without editing that file (IP-0008). inoai now supports roles. A role is a Markdown file in the runtime home. The owner equips one role per Agent Instance from Discord, the CLI, or the SPA UI. The equipped role is an overlay: `agent.md` stays the base profile, and the role is appended after it.

This was chosen over two alternatives:

- **Swapping `agent.md`.** It replaces the base profile, so a role could drop safety or identity text. It also has no history and no owner check.
- **A role per chat Session.** It needs a per-Session selector on every surface, and Task Runs would need their own rule. One role per Agent Instance is simpler and matches how the owner uses an instance.

## Role model

- **Overlay and authority order.** The authority order is: inoai safety > provider policy > Agent Profile > Equipped Role > Skill Packages > user request. A role cannot weaken safety rules. The rendered block ends with one fixed line: `This Equipped Role ranks below the Agent Profile and inoai safety rules. Follow them when they conflict.`
- **Scope.** One equipped role per Agent Instance. All chat Sessions and Task Runs use it. "No role" (the base profile only) is valid and the default. Roles are not shared between Agent Instances.
- **Owner-only switching.** Only the owner switches roles, from Discord (`/inoai role`), the CLI (`inoai role`), or the SPA UI. The agent cannot change its own role.
- **SQLite only.** With the PostgreSQL store, role commands report that roles are unsupported, and no role is applied.

## Role files

- Path: `<runtime-home>/roles/<role-id>.md`. The file name without `.md` is the role id.
- The id matches `^[a-z0-9][a-z0-9-]{0,63}$`. This also prevents path traversal. The id `none` is reserved, because `none` means "no role" in events and change notes.
- Format: no frontmatter. The file must not start with `---`. Line 1 is `# Role: <Name>`. A non-empty summary paragraph follows. Then the required non-empty sections `## Instructions` and `## Workflow`.
- Section parsing is fence-aware. A `##` line inside a fenced code block (```` ``` ```` or `~~~`, indented at most 3 spaces, closed by a line that, after trimming, holds only the same marker character at the same or greater length (`line.trim() === marker`)) is not a section boundary. A file with an unclosed fence is invalid, with the reason `unclosed code fence`. An owner role file that was valid before this rule can therefore become invalid after an upgrade. If it is equipped, Turns fail closed until the owner closes the fence or unequips it.
- A file over 48 KB (49,152 bytes) is invalid. The cap was 16 KB at first; it rose so that every converted catalog role fits.
- A file that matches the `secretLike` pattern is invalid. Its text is never sent to a runtime, and UI data omits its text. Every surface reports only `invalid: secret-like text` and never quotes the match.
- Files are read with `lstat`. A symlink or a non-regular file is invalid.
- A `.md` file whose name is not a valid id is listed as invalid. Files that do not end in `.md` are ignored. A missing `roles/` lists nothing.
- Only runtime bootstrap creates `roles/`. When it creates the folder, it copies the role catalog (see [Role catalog](#role-catalog)). It never overwrites an existing file. The UI server and the live CLI never create folders or files.
- The validator fails closed. Equipping an unknown or invalid file is refused on every surface.

## Role catalog

The role catalog is converted from [github/awesome-copilot](https://github.com/github/awesome-copilot), `agents/*.agent.md`, at upstream commit `222eba62d518c27317e917c92e3ec1a7e6729455`. awesome-copilot is licensed under MIT, Copyright GitHub, Inc. It replaces the three hand-written starter roles (`planner`, `reviewer`, `designer`) of the first plan.

- **Vendored snapshot.** The converted files are committed in `src/inoai/roles/catalog/` and embedded in `src/inoai/roles/role-catalog.generated.ts`, so the standalone build includes them. The MIT license is in `licenses/awesome-copilot-LICENSE.md`. The standalone `THIRD_PARTY_NOTICES.txt` (and `inoai --licenses`) has an "awesome-copilot role catalog" entry with the upstream commit and the license text.
- **Vendoring report.** `src/inoai/roles/catalog-vendoring.md` is generated. It records the upstream URL, the commit, the counts, and every skipped file with its reason.
- **Counts.** 230 upstream files: 202 converted and 28 skipped. 25 matched `secretLike` (mostly false positives such as `PublicKeyToken=`), 1 had no `description`, and 2 have an unclosed code fence upstream.
- **Converter.** Maintainers run `npm run build && node scripts/convert-awesome-copilot-roles.mjs <path-to-awesome-copilot>` against a local checkout. It rewrites the catalog, the report, and the embedding module. The output depends only on the checkout's files and HEAD commit, so a second run gives no diff. Conversion rules:
  - Line 1 is `# Role: <frontmatter name>`. The frontmatter `description` is the summary. `tools`, `model`, `mcp-servers`, and all other frontmatter keys are dropped; a role never changes provider permissions.
  - The id is the file name without `.agent.md`, with CamelCase split, `_` replaced by `-`, and lowercased. An id that clashes, is invalid, or is `none` is skipped.
  - The first H1 title is dropped. The first non-empty top-level `##` section whose title ends with "Workflow", "Process", or "Steps" (case-insensitive, trailing punctuation ignored) becomes `## Workflow`. Otherwise `## Workflow` is the fixed line `Follow the instructions above step by step and report results.` The first plan lifted any heading that contained one of these words; that rule lifted wrong sections and was tightened.
  - The rest of the body goes in `## Instructions`. Outside fenced code blocks, headings are demoted one level and never above `###`, so no heading becomes a section boundary. Extra H1s therefore do not end `## Instructions`.
  - A file that matches `secretLike` is skipped. Every written file must pass `validateRole`, and its parsed Instructions and Workflow must equal what the converter intended (a round-trip check). A file that fails is skipped and reported.
- **Refresh on creation only.** Bootstrap copies the catalog only when it creates `roles/`. An existing `roles/` folder is left alone, so edited or deleted roles stay that way, and a newer catalog does not reach it. A later `inoai role sync` is a backlog item.

## Rendering

The composed instructions are `renderEnabledSkillsProfile(agent.md)`, a blank line, and the role block. Since RF-0003, `renderEnabledSkillsProfile` returns `agent.md` (without any old `## Enabled Skills` section), then `## inoai Safety`, then `## Enabled Skills` only when a skill is enabled ([ADR 0018](0018-agent-profiles-and-local-skill-packages.md)). The role block always comes last. Role headings are demoted: `## Equipped Role: <Name>`, the summary, `### Instructions`, and `### Workflow`.

## Persistence

- The `role_equips` table has one row per equip, with audit fields. The current role is the one row with `unequipped_at IS NULL`. A partial unique index enforces this.
- Unequip and replacement set `unequipped_at` and `unequipped_by`. Rows are never physically deleted.
- Equipping the equipped role succeeds and writes no row. Unequipping with no role equipped succeeds and writes nothing. A switch closes the open row and inserts the new one in one `BEGIN IMMEDIATE` transaction.
- Actors: `cli:owner`, `discord:owner`, and `ui:owner`.
- A database without `role_equips` reads as "no role". Role writes on it fail with `Start the Agent Instance once to upgrade its database.` The UI returns 409. This matches the ADR 0026 handling of missing Task schedule columns.

## Turns and the change note

- A role switch takes effect at the next Turn. An in-flight Turn keeps its starting instructions. Agent sessions are not reset.
- A Task Run uses the role that is equipped when the run starts.
- The change note `Role changed from <old-id|none> to <new-id|none>.` goes in the Turn prompt, before the current user message or Task instruction. It does not go in the instructions. Codex keeps developer instructions per thread, and the Anthropic API runtime appends a `system` history row whenever the instructions change. A one-Turn note in the instructions would cause two instruction changes and leave a stale note.
- After the runtime accepts a Turn, the worker records a `role_applied` event (`detail: role=<id|none>`) for that Session when the role differs from the last recorded one. Actors: `conversation-worker` for chat Turns and `task-runtime` for Task Runs.
- The note appears when the current role differs from the last recorded role for the Session. A Session with no recorded role records the role and gets no note. A Turn that fails before the runtime starts records nothing, so the next Turn still gets the note.
- Editing the equipped file without re-equipping it applies at the next Turn with no note.
- Earlier role text may stay in the session context. Claude replaces `--append-system-prompt` each Turn. Codex history, the Anthropic API system prompt and history, and the OpenCode per-Turn persona prompt keep earlier text. The change note tells the model which role is current. Owners who want a clean context use `/inoai reset`. A switch also invalidates provider prompt caches once.

## Fail-closed Turns

If the equipped file becomes missing or invalid, the Turn or Task Run fails before it reaches the runtime. The role stays equipped. The worker and the Task Run executor:

- mark the message or run failed with `replay_safe=false`;
- write a `turn_failed` event with `reason=role_invalid`;
- post `Equipped role <id> is missing or invalid; fix roles/<id>.md or unequip it.`

The failed message is not replayed. The owner resends it after fixing the file. A recurring Task keeps its schedule, and its next run tries again.

## Amendment to ADR 0025

`inoai role equip` and `inoai role unequip`, and the read-only `inoai role list` and `inoai role show`, join the live maintenance commands. They use a short-lived connection with the 5-second busy timeout while the Agent Instance runs. A busy write returns `SQLite database is busy. Retry the role command shortly.` On the live path, the missing-table check runs before role validation. Other database-writing commands are still not supported.

## Amendment to ADR 0026

UI writes are now Tasks and the equipped role. All other UI data stays read-only.

### Routes

| Route | Body | Success |
| --- | --- | --- |
| `POST /api/role/equip` | `{ "roleId": "<id>" }` | 200 `{ role }` |
| `POST /api/role/unequip` | Empty or `{}`. Other content is ignored. | 200 `{ role: null }` |

`{ role }` has the same shape as a `roles.list` item in `/api/ui-data`. It carries no role text.

Each route uses the ADR 0026 security checks in the same order: Host, Origin, Content-Type, token, and the 32 KB body cap. Each write uses a short-lived connection with the 5-second busy timeout and the actor `ui:owner`. Equip validates the role file before it writes.

Response codes:

- **400**: the body is not valid JSON, is not an object, or `roleId` is not a valid role id. `none` is not a valid id.
- **403** `{"error":"Forbidden."}`: a security check failed.
- **404**: the role file does not exist, or the path is an unknown `/api/role/...` path.
- **405**: a wrong method. `Allow: POST`.
- **409**: the role file is invalid (`Cannot equip role: <reason>`), the database file is missing, or the database has no `role_equips` table.
- **503** `{"error":"The database is busy. Try again.","retryable":true}`: SQLite stayed busy for 5 seconds. Nothing was written.
- **500**: the database path is unsafe, or the write failed for another reason.

Logging rule: a rejected security, JSON, method, or route check, and a 500 or 503, log one line: `ui role write rejected: <method> <path> <reason>`. The server never logs the token, headers, body, or role text.

### Read model

`/api/ui-data` gains `roles`:

```json
{ "equipped": "planner", "list": [{ "id": "planner", "name": "Planning mode instructions", "summary": "...", "valid": true, "reason": null }] }
```

- `equipped` is the equipped role id, or `null`. It may name a file that is now missing or invalid.
- `list` holds every `.md` file in `roles/`, sorted by id. An invalid file has `name: null`, `summary: null`, `valid: false`, and a short `reason`.
- UI data carries no role text. The first version sent `text` for valid roles; it was removed because about 200 roles at up to 48 KB each would make every `/api/ui-data` poll large.
- The UI reads `roles/` without creating it. It never reads `.env`.

### Role picker

The SPA has no separate Roles page. The agent profile view has a Role block:

- the equipped role, with its name, summary, and **Unequip**, or a warning when the equipped file is missing or invalid;
- a search box that filters roles by id, name, and summary, with an all, valid, or invalid filter;
- one row per role, with **Equip** for valid roles. Invalid roles stay listed with their reason and no Equip.

The shared search list shows at most 200 rows, with the note "Showing the newest 200 · refine the search" when more roles match. The full catalog of 202 roles shows the note until you search. Search covers the whole list. The profile's Storage line reads `SQLite · Tasks and role writes`.

## Consequences

- SQLite stays the source of truth. Role switches need no IPC or request queue.
- The owner can switch roles while the agent runs. The change applies at the next Turn.
- A broken role file stops Turns until the owner fixes or unequips it. This is deliberate: a silent fallback would run the agent in a mode the owner did not choose.
- New runtime homes start with about 200 catalog roles. Existing `roles/` folders do not get catalog updates.
- An upgrade can make an owner role invalid (`unclosed code fence`), which stops Turns while that role is equipped.
- Any further UI write still needs a new decision.
