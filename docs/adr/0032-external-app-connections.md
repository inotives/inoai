---
status: accepted
---

# External app connections are per-home MCP servers for Claude

The owner wanted the agent to use external apps during chat Turns and Task Runs (IP-0009). inoai now supports connections. A connection is an MCP server that a runtime home lists in its own `connections.json`. For each Claude chat Turn and Task Run, inoai fills in the server's secrets from `.env`, writes a short-lived private Claude MCP config file, and passes it with `--mcp-config`. The servers are added on top of the owner's own Claude MCP config. Each connection has a tool allow list. Connections work only on Claude CLI homes in this version.

This was chosen over these alternatives:

- **Editing the owner's global Claude config.** inoai never changes global Codex, Claude, or OpenCode configuration (AGENTS.md). A global server would also reach every Claude session on the machine, not one Agent Instance.
- **Replacing the global config with `--strict-mcp-config`.** It hides the owner's own servers, which the owner did not ask for.
- **Passing secrets in Claude's process environment and letting Claude expand `${VAR}`.** Every process that Claude starts, including every MCP server and every shell command, would inherit every secret. The human chose a short-lived private config file instead.
- **Native REST API connections or an inoai-owned tool layer.** They need a new tool protocol, approval surface, and schema import. To connect a REST API, the owner puts an MCP server in front of it.
- **OAuth sign-in for remote servers.** It needs a browser flow and token storage. Header and env secrets are enough for v1.
- **Managing connections from Discord, the UI, or `connections add|remove`.** The owner edits the file by hand. The CLI and the UI only read it.

## The connections file

- Path: `<runtime-home>/connections.json`. Bootstrap does not create it. An absent file means no connections.
- The file is read with `lstat`. A symlink or a non-regular file is invalid (`not a regular file`). A file over 262,144 bytes is invalid.
- The schema follows Claude's `mcpServers` shape:

  ```json
  {
    "version": 1,
    "connections": {
      "github": {
        "type": "stdio",
        "command": "npx",
        "args": ["-y", "@modelcontextprotocol/server-github"],
        "env": { "GITHUB_PERSONAL_ACCESS_TOKEN": "${GITHUB_TOKEN}" },
        "allow": ["search_issues", "get_issue"]
      },
      "docs": {
        "type": "http",
        "url": "https://mcp.example.com/mcp",
        "headers": { "Authorization": "Bearer ${DOCS_API_KEY}" },
        "allow": "all"
      }
    }
  }
  ```

- `version` must be `1`. The top level has only `version` and `connections`.
- A connection name matches `^[a-z0-9][a-z0-9_-]{0,31}$` and must not contain `__`. Claude keeps `-` and `_` unchanged in tool ids, so `mcp__<name>__<tool>` is predictable, and the `__` rule keeps it unambiguous.
- `type` is `stdio` or `http`. A `stdio` connection has `command`, an optional `args` list of strings, and an optional `env` map of strings. An `http` connection has `url` and an optional `headers` map of strings.
- `allow` is optional. It is a list of tool names or the string `"all"`. A tool name matches `^[A-Za-z0-9_-]{1,64}$`, so each generated entry also passes the `CLAUDE_ALLOWED_TOOLS` pattern. A missing `allow` is the same as an empty list.
- Unknown keys are rejected at every level.
- `env` keys match `^[A-Za-z_][A-Za-z0-9_]*$`. Header names are HTTP token characters, at most 128.
- A key name or a reference name that itself looks like a secret (it matches the `secretLike` pattern, for example a pasted `ghp_…` token) is refused.
- Error reasons name the file and the problem, never a value. An unknown key is named only when it is a short word of letters.

## Secrets and `${NAME}` references

- Secret values live only in the runtime home's `.env`. The file refers to them as `${NAME}` inside `env`, `headers`, `url`, and `args`. `${NAME}` is the only reference form; a bare `$NAME` stays literal text, and Claude does not expand it either ([probe](../claude-mcp-probe.md#bare-var-ip-0009-t-0003)).
- `NAME` matches `^[A-Za-z_][A-Za-z0-9_]*$`. Any other form, such as `${lower-case}`, fails with `unsupported reference form`.
- Every referenced name must have a non-empty value in `.env`. An empty value counts as missing.
- inoai refuses its own keys as references: `DISCORD_*`, `ANTHROPIC_API_KEY`, and `POSTGRES_*`. The bot token and other inoai keys never reach a third-party server.
- A `.env` value that contains `${` is refused. After the fill-in, no `${` may remain anywhere in a server's config; if one does, the file is invalid. Claude expands `${VAR}` from its own process environment, so leftover reference text could pull in a variable that inoai never meant to share.
- A literal value that matches `secretLike` (for example `password=…`, `--token=abc`, `Bearer abc…`, an `sk-…` or `ghp_…` token, or a private key header) is refused. A `key=` match is accepted only when a `${NAME}` reference follows it. A `Bearer` match is accepted only when its token is exactly one reference.
- **Secret-named keys.** Under an `env` or `headers` key whose name matches `password|passwd|secret|token|api[_-]?key|authorization` (case-insensitive), the value must be exactly one `${NAME}` reference. It may follow one scheme word: `Bearer `, `Basic `, or `token `. The scheme words are case-sensitive and take exactly one space. A non-secret value under such a key, such as `TOKEN_TYPE=bearer`, is rejected. Rename the key, or move the value to `.env`.

## The per-Turn config file

- At Turn time inoai fills in the references and writes `{ "mcpServers": … }` to `mcp.json` with mode `0600`, inside a new private directory made with `mkdtemp` (mode `0700`) in the system temp folder. The directory name is `inoai-mcp-<pid>-XXXXXX`.
- The file is passed as one argv element, `--mcp-config=<path>`. The option is variadic, like `--allowedTools`, so the joined form cannot consume later arguments. inoai never passes `--strict-mcp-config` on a Turn.
- inoai deletes the directory when the Turn ends, on every exit path: answer, failure, cancel, and timeout. `close()` on process shutdown removes any directory that still exists. That includes a directory left by an abandoned Turn generator that was never resumed, the same lifecycle as the Turn's child process. On startup, a Claude home removes leftover `inoai-mcp-<pid>-` directories whose pid is no longer running and that the current user owns. Directories of a running inoai process (another Agent Instance) are kept.
- The path is never logged.
- Each secret reaches only its own server. Secret values never go in argv, in Claude's own process environment, in SQLite, in logs, in Discord, or in UI data.
- **The accepted trade-off.** The human accepted that a filled-in secret sits on local disk, owner-only, for the length of one Turn. That is the only place it goes outside `.env`.

## Permissions

- Each `allow` entry becomes an `--allowedTools` entry: `mcp__<name>__<tool>` for a listed tool, or `mcp__<name>` for `"all"`. They are merged with `CLAUDE_ALLOWED_TOOLS`. A Turn without connections keeps the configured list unchanged.
- Under `--permission-prompts none`, a tool that is not allowed is denied, and the existing denial handling applies (ADR 0007). A connection with no allowed tools still starts, but its tool calls are denied.
- `ToolSearch` stays unrestricted. MCP tools are deferred, and the model loads their schemas through it.
- **The owner's own allow rules still apply.** Claude applies the owner's global and project `permissions.allow` rules, including broad patterns such as `mcp__codegraph__*`, to connection tools by name. A tool that a connection's `allow` list leaves out can still be allowed by such a rule. inoai does not read or change those rules. It never works around them with `--setting-sources` or settings edits.
- **Name clashes.** A connection with the same name as one of the owner's global MCP servers wins: the global server is hidden and does not start for that Turn. The connection also inherits the owner's allow rules for that name. Owners should use distinct connection names.

## Where connections apply

- Claude chat Turns and Task Runs load `connections.json` once per Turn, the same way they resolve the Equipped Role. A file change applies from the next Turn, without a restart.
- Memory Reviews never get connections. They still pass `--strict-mcp-config` with no config, `--tools ""`, and `--safe-mode` (ADR 0010, unchanged). The startup concurrency probe also gets none.
- **Claude only.** On Codex, OpenCode, and `anthropic-api` homes, a `connections.json` causes only a startup warning: `connections.json is ignored; connections are supported only on Claude homes in this version.` These homes never refuse to start or fail Turns because of the file, even an invalid one. `inoai connections validate` still reports its errors.

## Fail-closed behavior

- **Startup.** A Claude home with an unusable file refuses to start. The error is `Invalid connections file <path>: <reason>`.
- **Turns and Task Runs.** If the file becomes invalid while the agent runs, the Turn or Task Run fails before the runtime starts. The worker and the Task Run executor:
  - mark the message or run failed with `Connections file invalid; replay_safe=false`;
  - write a `turn_failed` event with `reason=connections_invalid`;
  - post `The connections file connections.json is invalid: <reason>. Fix it, then send a fresh request.`

  A failed Task Run whose run folder exists also writes the notice to its `result.md`. The replay rules match `role_invalid` (ADR 0031): the failed message is not replayed, and a recurring Task keeps its schedule and tries again at its next run.

## Server status

- inoai reads each connection's status from the `mcp_servers` list in Claude's `system`/`init` event. It ignores servers that are not in `connections.json`, such as the owner's global, plugin, and claude.ai servers.
- Status mapping: `connected` to `connected`, `failed` to `failed`, `needs-auth` to `needs_auth`, and any other string (such as `pending` or `disabled`) to `unknown`. A connection missing from the list is `failed`.
- inoai records one `connection_status` event per connection per Turn, with `detail` `name=<name> status=<connected|failed|needs_auth|unknown>` and no other detail. Actors are `conversation-worker` and `task-runtime`. The write is best effort and never changes the Turn outcome.
- **The pre-init rule.** If the runtime was called but the Turn ended before `init` (for example a spawn failure, a timeout, or a cancel), each connection is recorded as `unknown`.
- **The retry rule.** A chat Turn can retry an attempt that never started (ADR 0002). Each attempt's `init` replaces the earlier report. When a retry fails before `init`, the earlier attempt's report is kept and recorded.
- A Turn cancelled or stopped before the runtime starts records no status.

## Failure notes

When a Turn answers and any connection is not `connected`, inoai adds one line per such connection:

- `Connection <name> failed to start.`
- `Connection <name> needs authentication; check its credentials in .env.`
- `Connection <name> reported an unknown status.`

A chat reply gets the lines after the answer, separated by a blank line. A completed Task Run's `result.md` gets a `## Connections` section with the same lines, after `## Files`. The Turn still runs and answers with the servers that did start.

## Status views

- **`/inoai status`** adds a `Connections:` line. It reads only names from `connections.json`, never `.env`, and never fills in references. Its states:
  - `Connections: none`: no file, or a file with no connections.
  - `Connections: <name> (<status>), …`: each name with its newest `connection_status` value.
  - `<name> (not used yet)`: a name with no `connection_status` event.
  - `<name> (status unknown)`: the store cannot read statuses (the PostgreSQL store).
  - `Connections: invalid (run inoai connections validate)`.
  - `Connections: ignored (Claude only)`: a non-Claude home with a file.
  - At most 20 names are shown, followed by `and <n> more`.
- **The CLI.** `inoai connections validate` and `inoai connections list` read only `connections.json` and `.env`. They never open SQLite, so they are safe while the agent runs and need no live-maintenance change (ADR 0025). `list` prints only name, type, and allow list.

## Amendment to ADR 0026

The UI now reads `connections.json`. It still writes only Tasks and the equipped role, and it never writes `connections.json`.

- `/api/ui-data` gains `connections`: `{ "state": "absent" | "valid" | "invalid" | "ignored", "list": [{ "name", "type", "allow", "status" }] }`. `status` is the newest `connection_status` value, or `null` when the connection has not been used yet.
- The read model copies only name, type, allow, and status. `command`, `args`, `url`, `headers`, and `env` never enter UI data. The UI never reads `.env` and never fills in references.
- `invalid` carries no list and no error text. The UI uses the schema-only loader, so `invalid` covers schema errors only, the same as the status line. A missing `.env` reference, a refused key, or a literal secret shows as `valid` in the UI. `inoai connections validate` is the full check.
- The UI cannot read `.env`, so it takes the provider from the newest Session, the same source as the profile view. A home with no Session is read like a Claude home. A non-Claude provider with a file gives `ignored`.
- The agent profile view has a read-only, collapsible Connections block below the Role block. It shows each connection's name, type, allowed tools, and last status. It has no write controls.

## Limits

- **Detection limits.** The checks cannot catch every secret:
  - a raw secret under a neutral key, such as `X-Auth` or `GH_PAT`, that does not look like a known token format;
  - user info in a URL, such as `https://user:pass@host/`;
  - literal text after a reference, such as `--token=${X}<lit>` in `args`.

  So every secret must be a `${NAME}` reference.
- **Trust.** inoai does not check URLs or commands beyond the schema. The owner is responsible for trusting each server. A `stdio` server runs as the owner, with the owner's file access. Tool results from any server, and especially remote ones, can contain prompt injection. Allow only the tools you need, and prefer read-only tools.
- The connection status is the status Claude reported at `init`. A server that fails later in the Turn is not tracked.

## Consequences

- An owner connects an Agent Instance to an external app by editing two files in its runtime home: `connections.json` and `.env`.
- A broken file stops a Claude home from starting, and stops Turns while it runs, until the owner fixes it. This is deliberate: a silent fallback would run the agent without the tools the owner expects, or with references the owner did not check.
- A server that fails at runtime does not stop the Turn. The owner sees it in the reply note, `/inoai status`, and the UI.
- The owner's global allow rules and same-name global servers interact with connections. Distinct names avoid surprises.
- A filled-in secret is on local disk, owner-only, for the length of one Turn.
- Codex, OpenCode, and `anthropic-api` support, OAuth, and UI management are later features.
