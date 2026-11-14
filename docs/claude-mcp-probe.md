# Claude CLI MCP probe (IP-0009 T-0001)

This note records how Claude CLI `2.1.325` handles per-process MCP servers. It checks the IP-0009 plan assumptions before the connections design depends on them.

Date: 2026-11-13 (UTC). Claude CLI: `2.1.325 (Claude Code)`, macOS arm64, subscription sign-in.

## Setup

- A throwaway stdio MCP server, `server.mjs`, written with Node built-ins only. It speaks newline-delimited JSON-RPC 2.0 and handles `initialize`, `ping`, `tools/list`, and `tools/call`. It has two tools:
  - `echo` returns `server=<PROBE_LABEL> echo=<text> PROBE_SECRET_set=<bool> matches_fake=<bool>`. It reports only whether `PROBE_SECRET` is set and whether it equals the fake value `fake-test-value-123`. It never prints the value.
  - `add` returns `server=<PROBE_LABEL> sum=<a+b>`.
- A private config directory made with `mktemp -d` and `chmod 700`, holding `mcp.json` with `chmod 600` (`umask 077`):

  ```
  drwx------ <scratch>/mcpcfg.XXXXXX
  -rw------- <scratch>/mcpcfg.XXXXXX/mcp.json
  ```

  ```json
  {"mcpServers":{
   "probe-dash":{"type":"stdio","command":"node","args":["<scratch>/server.mjs"],"env":{"PROBE_LABEL":"probe-dash","PROBE_SECRET":"fake-test-value-123"}},
   "probe_under":{"type":"stdio","command":"node","args":["<scratch>/server.mjs"],"env":{"PROBE_LABEL":"probe_under","PROBE_SECRET":"${PROBE_FAKE}"}},
   "missing-cmd":{"type":"stdio","command":"/nonexistent/probe-binary","args":[]},
   "dead-http":{"type":"http","url":"http://127.0.0.1:9/mcp"},
   "codegraph":{"type":"stdio","command":"node","args":["<scratch>/server.mjs"],"env":{"PROBE_LABEL":"clash-probe"}}
  }}
  ```

- The owner's global (user scope) MCP servers at probe time: two stdio servers, one of them `codegraph`, plus three http servers. Plugin and claude.ai connector servers also load. The owner's `~/.claude/settings.json` has the allow rule `mcp__codegraph__*`.
- All runs used a scratch cwd with no `.mcp.json` and no `.claude/` folder. `--model=haiku` was added only to keep subscription use small; it does not change MCP handling.

### Runs

Run A (items 1–6), inoai's chat flags plus `--mcp-config` and `--allowedTools`:

```sh
PROBE_FAKE=fake-test-value-123 claude -p --output-format stream-json --verbose \
  --permission-prompts none --no-session-persistence --model=haiku \
  --mcp-config "<private dir>/mcp.json" \
  "--allowedTools=mcp__probe-dash__echo,mcp__probe_under" \
  "Call these tools in order, one at a time, and continue even if one is denied: mcp__probe-dash__echo with text hi; mcp__probe-dash__add with a=1 b=2; mcp__probe_under__echo with text hi; mcp__probe_under__add with a=2 b=3; mcp__codegraph__echo with text hi. Then reply with the raw text of each result." < /dev/null
```

Run B (item 7), inoai's `reviewArgs()`:

```sh
claude -p --output-format stream-json --verbose --no-session-persistence \
  --permission-prompts none --tools "" --strict-mcp-config --safe-mode \
  --system-prompt "Reply with one word." --model=haiku "Say ok" < /dev/null
```

Run C (extra, init timing): a server that waits 8 seconds before it answers `initialize`:

```sh
claude -p --output-format stream-json --verbose --no-session-persistence \
  --permission-prompts none --strict-mcp-config --mcp-config "<private dir>/slow.json" \
  --model=haiku "Say ok" < /dev/null
```

All three runs exited `0`.

## Findings

### 1. `--mcp-config` adds servers on top of the global config

Holds. Run A's `system`/`init` event lists the probe servers next to the owner's global servers. The global servers still connect.

```json
{"name":"global-a","status":"connected","source":"user"}
{"name":"global-b","status":"failed","source":"user"}
{"name":"probe-dash","status":"connected","source":"dynamic"}
{"name":"probe_under","status":"connected","source":"dynamic"}
```

`--permission-prompts none` does not stop servers from loading. Plugin servers (`source":"plugin"`) and claude.ai connectors (`"source":"claudeai"`) also appear.

### 2. The `init` event's `mcp_servers` shape

Each entry has exactly three fields: `name`, `status`, and `source`.

| Case | Observed entry |
| --- | --- |
| Working stdio server | `{"name":"probe-dash","status":"connected","source":"dynamic"}` |
| stdio command does not exist | `{"name":"missing-cmd","status":"failed","source":"dynamic"}` |
| http URL that does not respond | `{"name":"dead-http","status":"failed","source":"dynamic"}` |
| Remote server that needs sign-in (owner's plugin/claude.ai servers) | `{"name":"plugin:<name>","status":"needs-auth","source":"plugin"}` |

- Servers from `--mcp-config` have `"source":"dynamic"`. Global servers have `"user"`, plugin servers `"plugin"`, and claude.ai connectors `"claudeai"`.
- The sign-in status string is `needs-auth`, with a hyphen. The plan writes `needs_auth`; inoai must map `needs-auth` to its own value.
- The CLI binary also contains the status strings `pending` and `disabled`. Neither appeared in `init` during the probe. Run C shows that Claude waits for a slow server (8 s) before it emits `init`: the run took 11 s and reported `{"name":"slow-probe","status":"connected","source":"dynamic"}`. inoai should map any status it does not know, including `pending` and `disabled`, to `unknown`.

### 3. `--allowedTools` for MCP tools under `--permission-prompts none`

Holds, with one caveat about the owner's own allow rules (see below).

Run A allowed `mcp__probe-dash__echo` (one tool) and `mcp__probe_under` (whole server). Tool results, in call order:

```json
{"content":[{"type":"text","text":"server=probe-dash echo=hi PROBE_SECRET_set=true matches_fake=true"}]}
{"is_error":true,"content":"Permission for this tool use was denied. It requires approval, and this session has no approval surface ... What required approval: Claude requested permissions to use mcp__probe-dash__add, but you haven't granted it yet."}
{"content":[{"type":"text","text":"server=probe_under echo=hi PROBE_SECRET_set=true matches_fake=true"}]}
{"content":[{"type":"text","text":"server=probe_under sum=5"}]}
{"content":[{"type":"text","text":"server=clash-probe echo=hi PROBE_SECRET_set=false matches_fake=false"}]}
```

- `mcp__probe-dash__echo` ran. `mcp__probe-dash__add` was denied.
- `mcp__probe_under` allowed both `echo` and `add`.
- The denial is reported twice: a `system` event and the `result` event.

  ```json
  {"type":"system","subtype":"permission_denied","tool_name":"mcp__probe-dash__add","tool_use_id":"toolu_<id>","decision_reason_type":"asyncAgent","decision_reason":"no approval surface in this session; permission request denied automatically","message":"..."}
  {"type":"result","subtype":"success","is_error":false,"permission_denials":[{"tool_name":"mcp__probe-dash__add","tool_use_id":"toolu_<id>","tool_input":{"a":1,"b":2}}]}
  ```

- MCP tools are deferred. The model first called `ToolSearch` (`select:mcp__probe-dash__echo,...`) to load their schemas. `ToolSearch` was not in `--allowedTools` and ran without a denial.
- **Caveat.** `mcp__codegraph__echo` was not in `--allowedTools`, but it ran. The owner's global `~/.claude/settings.json` allows `mcp__codegraph__*`. Global (and project) permission allow rules apply to tools from `--mcp-config` servers by name. A connection whose name matches an owner allow rule gets those tools allowed even if its `allow` list does not name them.

### 4. Names with `-` and `_` in tool ids

Both characters are kept unchanged. The `init` `tools` list shows:

```
mcp__probe-dash__echo   mcp__probe-dash__add
mcp__probe_under__echo  mcp__probe_under__add
```

Other characters are replaced with `_`: the server `plugin:context-mode:context-mode` gives `mcp__plugin_context-mode_context-mode__ctx_search`, and `claude.ai Atlassian MCP` gives `mcp__claude_ai_Atlassian_MCP__search`. The plan's name pattern `^[a-z0-9][a-z0-9_-]{0,31}$` uses only kept characters, so `mcp__<name>__<tool>` is predictable. Note that a name containing `__` (allowed by the pattern) makes the id ambiguous to read, for example `a__b` + `c` gives `mcp__a__b__c`.

### 5. Name clash with a global server

The `--mcp-config` server wins and replaces the global one. The global server is not started.

- Run A's `mcp_servers` has one `codegraph` entry: `{"name":"codegraph","status":"connected","source":"dynamic"}`.
- The `tools` list has `mcp__codegraph__add` and `mcp__codegraph__echo`, and no tool of the real global codegraph server.
- `mcp__codegraph__echo` returned `server=clash-probe ...`.

This was tested against a real global server (`codegraph`), so no second `--mcp-config` entry was needed. Combined with the caveat in item 3, a clashing connection hides the owner's global server and also inherits the owner's allow rules for that name.

### 6. `0600` config in a `0700` temporary directory

Holds. Run A read the config from a `mktemp -d` directory with mode `drwx------` and a file with mode `-rw-------`. All five servers loaded.

Filled-in env values reach only their own server: `probe-dash` (literal fake value) reported `PROBE_SECRET_set=true matches_fake=true`, and the clashing `codegraph` entry (no `PROBE_SECRET` in its `env`) reported `PROBE_SECRET_set=false`.

`${VAR}` expansion also works: `probe_under` had `"PROBE_SECRET":"${PROBE_FAKE}"`, with `PROBE_FAKE` set only in Claude's process environment, and reported `matches_fake=true`. The plan does not use this path, because inoai fills in values itself. But it means Claude expands any `${...}` text that is still in the file it reads.

### 7. Memory Review isolation

Holds. Run B (`reviewArgs()` flags, with `--strict-mcp-config` and no `--mcp-config`) reported:

```json
{"mcp_servers":[],"tools":[]}
{"type":"result","subtype":"success","is_error":false,"permission_denials":[],"result":"ok"}
```

## Bare $VAR (IP-0009 T-0003)

Date: 2026-11-13 (UTC). Claude CLI `2.1.325`. This check answers the T-0002 review question: does Claude expand a bare `$VAR` (no braces) in an `--mcp-config` file?

- Setup: a throwaway stdio MCP server (Node built-ins only) wrote what it received to a report file at startup. The config set `env.PROBE_ENV` to the literal text `$PROBE_VAR`, `env.PROBE_BRACED` to `${PROBE_VAR}` (the control), and one `args` element to `$PROBE_VAR`. The file was `0600` in a `0700` directory.
- Run, from a scratch cwd with no `.mcp.json` or `.claude/` folder:

  ```sh
  PROBE_VAR=x claude -p --output-format stream-json --verbose --permission-prompts none \
    --no-session-persistence --model=haiku "--mcp-config=<private dir>/mcp.json" "Say ok" < /dev/null
  ```

- Result: the run exited `0`, and `init` reported `{"name":"probe-var","status":"connected","source":"dynamic"}`. The server received:

  ```json
  {"env":"$PROBE_VAR","braced":"x","arg3":"$PROBE_VAR"}
  ```

- Verdict: Claude does **not** expand bare `$VAR`, in `env` or in `args`. It expands only `${VAR}`. The existing check (no `${` may remain in the filled-in config) is enough, and `connections-file.ts` needs no change.
- The joined form `--mcp-config=<path>` (one argv element) works. inoai uses it, because the option is variadic, like `--allowedTools`.
- Side effects: `~/.claude/settings.json` was unchanged. The run created an empty `~/.claude/projects/<encoded scratch cwd>/memory/` folder; it and the scratch files were removed afterwards.

## Side effects

- `~/.claude/settings.json` modification time: `2026-11-10 09:42:37` local before and after. Unchanged.
- `~/.claude.json` modification time: `2026-11-14 07:01:31` local before, `07:03:26` after. The CLI (and the concurrent interactive session) update this file's internal state on each start, so its time moves without a config change. Its `mcpServers` keys were the same before and after, and no `projects` entry was added for the scratch cwd.
- No project `.mcp.json` exists before or after.
- The `-p` runs created an empty `~/.claude/projects/<encoded scratch cwd>/memory/` folder, even with `--no-session-persistence`. It was removed after the probe. (inoai already cleans the same kind of folder after Memory Reviews.)

## Verdict

Every plan assumption holds, with one qualification: the owner's own global and project allow rules also apply to connection tools by name (item 3):

- `--mcp-config <file>` adds servers on top of the global config.
- `init` lists each server with its status: `connected`, `failed` (missing command and dead http), and `needs-auth`.
- `--allowedTools=mcp__<name>__<tool>` and `--allowedTools=mcp__<name>` allow tools under `--permission-prompts none`. Other tools are denied, and `permission_denials` reports them.
- `-` and `_` appear unchanged in tool ids.
- On a name clash, the `--mcp-config` server wins.
- A `0600` file in a `0700` temporary directory is read correctly.
- `--strict-mcp-config` with no `--mcp-config` gives an empty `mcp_servers`.

Details the later tasks must handle (no plan change is needed, but T-0002–T-0007 should cover them):

1. **Status mapping.** Map `connected` to `connected`, `failed` to `failed`, `needs-auth` to `needs_auth`, and every other string (including `pending` and `disabled`) to `unknown`. Filter by name against `connections.json`; `source` is `dynamic` for connections but the plan's name filter is enough.
2. **Global allow rules widen a connection's tools.** The owner's `permissions.allow` rules in global or project settings apply by tool name. A connection named like a server that the owner already allows (for example `mcp__codegraph__*`) gets those tools even if `allow` omits them. inoai cannot see or change global settings. The docs (T-0007) should say: use distinct connection names, and the owner's own allow rules still apply.
3. **Name clash.** The connection hides the owner's global server of the same name for that Turn. The docs already tell owners to use distinct names; they should also say which one wins.
4. **`${...}` in filled-in values.** Claude expands `${VAR}` in the file it reads from its own process environment. If a `.env` value contains `${...}` text, Claude could expand it after inoai fills it in, and pull in a variable from Claude's environment. T-0002 or T-0003 should reject `.env` values that contain `${`, or otherwise make sure no `${` reaches the per-Turn file.
5. **Optional name rule.** Consider rejecting `__` in connection names so tool ids stay unambiguous.

Status: all five items are closed. Items 1, 4, and 5 are in the code (T-0002 to T-0004). Items 2 and 3 are documented in [ADR 0032](adr/0032-external-app-connections.md#permissions) and in [INSTRUCTIONS.md](../INSTRUCTIONS.md#how-connections-apply).
