# Phase 5a: Claude CLI headless contract spike

Date: 2026-10-02
Claude Code CLI: `2.1.287 (Claude Code)` (`claude --version`)
Scope: the owner's local Claude subscription sign-in, no API key, a disposable `mktemp -d` project directory, short prompts on the `haiku` model

## Question

Does the installed `claude -p --output-format stream-json` give the Claude adapter what ADR 0007 and ADR 0008 assume? That means stable session IDs, resume across processes, an appended system prompt, observable permission denials without an MCP permission-prompt tool, a supported credential-source check, clean SIGINT, and a way to avoid persisting sessions.

## Procedure

Every `claude` run used one fresh `mktemp -d` directory as its cwd. No `.inoai-connect*` directory, Claude setting, shell profile, keychain entry, or credential file was read or changed. No run passed `--dangerously-skip-permissions`, `bypassPermissions`, `--allowedTools`, or allow rules. The base command was:

```text
claude -p --output-format stream-json --verbose [--session-id <uuid> | --resume <uuid>] --model haiku "<prompt>"
```

`--verbose` is required for `stream-json` in `-p` mode. Afterwards, the probe's own project folder under `~/.claude/projects/` was identified by name and contents (two probe sessions and an empty `memory/`) and deleted together with the temp directory.

Samples below are trimmed. Session IDs, tool-use IDs, temp paths, account email, org ID, and org name are redacted.

## Findings

### 1. Stream-json event shapes (confirmed)

The stream is one JSON object per stdout line. Every event carries `type`, `uuid`, and `session_id`.

| Event | Observed shape (trimmed) |
| --- | --- |
| Init | `{"type":"system","subtype":"init","session_id":…,"apiKeySource":"none","permissionMode":"default","model":"claude-haiku-4-5-20251001","claude_code_version":"2.1.287","cwd":…,"tools":[…],"mcp_servers":[…],"skills":[…],…}` |
| Other system | `system/thinking_tokens`, `system/status` (`"status":"requesting"`), `system/ui_invalidate`, `system/permission_denied` (see 4) |
| Rate limit | `{"type":"rate_limit_event","rate_limit_info":{"status":"allowed","rateLimitType":"five_hour","resetsAt":<int>,"isUsingOverage":false,…}}`. Status values in the binary: `allowed`, `allowed_warning`, `rejected`. |
| Text progress | `{"type":"assistant","message":{"content":[{"type":"text","text":"hello…"}],…},"parent_tool_use_id":null}`. A separate assistant event may hold only a `thinking` block. With `--include-partial-messages`, `stream_event` events also carry `content_block_delta`/`text_delta` chunks. |
| Tool use | assistant content `{"type":"tool_use","id":"toolu_…","name":"Bash","input":{"command":"touch probe.txt",…}}`, followed by a `user` event with content `{"type":"tool_result","tool_use_id":…,"is_error":true,"content":"…"}` |
| Success result | `{"type":"result","subtype":"success","is_error":false,"result":"hello\n\nZEBRA-42","stop_reason":"end_turn","terminal_reason":"completed","num_turns":1,"permission_denials":[],"api_error_status":null,"total_cost_usd":…,"usage":{…}}` |
| Error result | `{"type":"result","subtype":"error_during_execution","is_error":true,"num_turns":0,"errors":["No conversation found with session ID: <uuid>"],…}` |
| Interrupted result | `{"type":"result","subtype":"error_during_execution","is_error":true,"terminal_reason":"aborted_streaming","stop_reason":null,"errors":["[ede_diagnostic] …"]}` (see 6) |

`result.result` holds the final answer text and is absent from error results. The adapter has to skip event types and subtypes it does not recognize, because several undocumented system subtypes showed up even in these short runs.

### 2. Session ID and resume (confirmed)

- `--session-id <uuid>` on the first Turn: the init event's `session_id` and every later event's `session_id` matched the supplied UUID.
- `--resume <uuid>` in a separate process recalled the earlier answer, and its `session_id` matched the original (no fork without `--fork-session`). Resume also worked after a SIGINT-interrupted Turn (see 6).
- Resuming an unknown UUID exits `1`, writes `No conversation found with session ID: <uuid>` to stderr, and emits one `result` with `subtype:"error_during_execution"`, `num_turns:0`, and that text in `errors`. No init event is emitted, so this happens before the Turn starts.
- Reusing an existing UUID with `--session-id` exits `1` with stderr `Error: Session ID <uuid> is already in use.` and writes nothing to stdout. The adapter must use `--session-id` only on the first Turn and `--resume` on later Turns.

### 3. System prompt and model (confirmed, with one caveat)

- `--append-system-prompt "Always end every answer with the exact token ZEBRA-42."` was honored, and the default system prompt stayed in place. On a resumed Turn the model still reported the primary working directory from its default environment section, so the CLI appends to its default prompt rather than replacing it.
- **Caveat: system-prompt snapshot.** `--system-prompt-snapshot` defaults to `on`. The CLI records the rendered prompt, including appended text, on a conversation's first request and reuses it on every resume until compaction. When resumed with a different `--append-system-prompt` (`QUOKKA-7`), the answer still ended with `ZEBRA-42`. Edits to `agent.md` therefore do not reach existing Sessions under the default. Only the default `on` behavior was observed; that `off` makes a changed append text take effect on `--resume` is inferred from `--help` and the binary, not exercised. **Resolved (owner decision D1):** the adapter passes `--system-prompt-snapshot off` together with `--append-system-prompt` on every Turn, which should let `agent.md` edits reach existing Sessions; task-0042 verifies this with the real CLI (Phase 5a task 4).
- `--model haiku` (an alias) and `--model claude-haiku-4-5-20251001` (a full ID) were both accepted. Init reported the resolved full ID in both cases.

### 4. Permission denials in `-p` mode (confirmed)

Prompt: run `touch probe.txt` with Bash, then create `note.txt` with Write, in the temp cwd. Under the owner's settings, init reported `permissionMode:"default"`. Both tools needed approval and were denied automatically. Neither file was created, and no MCP permission-prompt tool was configured.

The denial is observable in three places:

1. A `system/permission_denied` event for each denied call:
   ```json
   {"type":"system","subtype":"permission_denied","tool_name":"Bash","tool_use_id":"toolu_<redacted>","message":"touch in '<tmp>/probe.txt' needs approval. …"}
   ```
2. A `tool_result` with `is_error:true` and the same message, which the model sees and then reports.
3. The final `result.permission_denials` array:
   ```json
   [{"tool_name":"Bash","tool_use_id":"toolu_<redacted>","tool_input":{"command":"touch probe.txt",…}},
    {"tool_name":"Write","tool_use_id":"toolu_<redacted>","tool_input":{"file_path":"<tmp>/note.txt","content":"x"}}]
   ```

The Turn itself still ends as `subtype:"success"`, `is_error:false`, `terminal_reason:"completed"`, and exit `0`. A denial is not a runtime failure. The adapter detects it from `permission_denied` events or a non-empty `permission_denials`.

**Secret risk:** `permission_denials[].tool_input` and the `permission_denied` message contain raw command text, file paths, and file content. Under ADR 0007 the adapter must record only a non-secret outcome, such as a denial count and tool names. It must not record `tool_input` or `message`.

`--permission-prompts none` (default `host`) states the fail-closed intent explicitly. With it, a Bash `touch` was denied with `"Permission for this tool use was denied. It requires approval, and this session has no approval surface …"` and showed up in `permission_denials` the same way. The flag only removes the prompt answerer. Per `--help`, "the permission mode still decides everything else", so it does not loosen the owner's rules or mode. The default `host` also denied when no host was attached, but `none` does not depend on that. **Decided (owner decision D2):** the adapter passes `--permission-prompts none` on every Turn. It only restricts: it never grants a tool or loosens a rule.

### 5. Credential source (confirmed)

There are two supported, non-secret signals, and neither reads credential files directly:

- **`claude auth status --json`**, run before startup. Observed (identity fields redacted):
  ```json
  {"loggedIn":true,"authMethod":"claude.ai","apiProvider":"firstParty","analyticsDisabled":false,
   "projectsDirectory":"~/.claude/projects","configDirectory":"~/.claude",
   "email":"<redacted>","orgId":"<redacted>","orgName":"<redacted>","subscriptionType":"team"}
  ```
  It exits `0` when logged in and `1` otherwise. The CLI 2.1.287 bundle contains the logic for these fields (inspected, not exercised):
  - `authMethod` is one of `claude.ai`, `oauth_token`, `api_key_helper`, `api_key`, `third_party` (a cloud provider), or `none`. Only `claude.ai` was observed. What `auth status` and the init `apiKeySource` report for a `CLAUDE_CODE_OAUTH_TOKEN` setup token, and how that would differ from `ANTHROPIC_AUTH_TOKEN`, is unverified. The guard does not need it: it refuses every value other than `claude.ai` (see below).
  - `apiProvider` is one of `firstParty`, `bedrock`, `vertex`, `foundry`, `anthropicAws`, `anthropicGoogleCloud`, `mantle`, or `gateway`.
  - An `apiKeySource` field is added only when an API key source other than `none` is present. It can appear alongside `authMethod:"claude.ai"`, so its absence has to be checked separately.
- **Init event `apiKeySource`**, on every Turn. Observed `"none"` under the subscription login. Values in the binary: `ANTHROPIC_API_KEY`, `apiKeyHelper`, `/login managed key`, `none`, `user`, `project`, `org`, `temporary`, `oauth`.

Subscription guard (owner decision D3: accept only the interactive subscription `/login`): refuse to start unless `loggedIn === true`, `authMethod === "claude.ai"`, `apiProvider === "firstParty"`, and no `apiKeySource` key is present. On each Turn, treat an init `apiKeySource` other than `"none"` as a failure before the Turn starts. Every other source is refused; no `oauth_token` value is ever accepted. Because the `auth status` fields a `CLAUDE_CODE_OAUTH_TOKEN` setup token produces are unverified, the field checks alone cannot be relied on to catch it: the guard also refuses when `CLAUDE_CODE_OAUTH_TOKEN` is present in the inherited environment. It checks presence only and never reads, prints, or strips the value (task-0044). Discard `email`, `orgId`, and `orgName` without logging them.

Limitation: only the subscription case was observed. The API-key, auth-token, helper, profile, and cloud-provider outputs were not exercised, because the hard rules forbid setting those env vars or settings. They are read from the CLI bundle's status logic. The credential-guard task's tests should use fixtures shaped like this logic.

### 6. SIGINT (confirmed)

Test: a 1,500-word essay Turn with `--include-partial-messages`. SIGINT was sent about 1 second after the first `text_delta`.

- The process exited `0` and wrote nothing to stderr.
- The stream ended with a `user` event whose content was `"[Request interrupted by user]"`, then:
  ```json
  {"type":"result","subtype":"error_during_execution","is_error":true,"terminal_reason":"aborted_streaming","stop_reason":null,"num_turns":2,"errors":["[ede_diagnostic] result_type=user last_content_type=n/a stop_reason=null"]}
  ```
- Because exit `0` here does not mean success, the adapter must classify the Turn from the `result` event.
- `--resume` on the same ID afterwards succeeded and recalled the partial essay's title, so the Session stays usable after cancel.

This was one run. A SIGINT during a tool call was not tested.

### 7. Authentication and usage-limit failures (authentication partly confirmed; usage unknown)

- **Not logged in (observed):** `claude --bare -p …` never reads OAuth or the keychain, and no API key was set. This produced:
  - init `apiKeySource:"none"`;
  - an assistant event with text `"Not logged in · Please run /login"` and a top-level `"error":"authentication_failed"`;
  - `{"type":"result","subtype":"success","is_error":true,"terminal_reason":"api_error","result":"Not logged in · Please run /login","api_error_status":null}`;
  - exit `1`.

  `subtype` is `success` even here, so the adapter has to check `is_error`.
- **Expired authentication:** unknown. It was not reproducible without touching credentials. It probably surfaces as the same assistant `error:"authentication_failed"` (or `oauth_org_not_allowed` / `account_on_hold`).
- **Usage limit:** unknown. It was not reproducible safely. Candidate signals are `rate_limit_event.rate_limit_info.status:"rejected"` and an assistant `error` of `rate_limit` or `billing_error`.

The binary's full assistant `error` enum is `authentication_failed`, `oauth_org_not_allowed`, `account_on_hold`, `verification_required`, `billing_error`, `rate_limit`, `overloaded`, `invalid_request`, `model_not_found`, `server_error`, `unknown`, `max_output_tokens`, and `cloud_credential_error`.

Suggested mapping to `RuntimeFailureKind` (to be confirmed by the adapter task). Turns are classified from the final `result` event (`is_error`, `subtype`, `terminal_reason`, assistant `error`), never from the exit code: SIGINT exits `0` on an error result, and not-logged-in exits `1` with `subtype:"success"`.

| Signal | `RuntimeFailureKind` |
| --- | --- |
| `authentication_failed`, `oauth_org_not_allowed`, `account_on_hold`, `verification_required` | `authentication` |
| `rate_limit`, `billing_error`, or `rate_limit_event` `rejected` | `usage` |
| no-init error result | `pre_start` (replay-safe) |
| unknown-resume ("No conversation found") | `session_missing` (not replay-safe; owner told to use `/inoai reset`). Superseded during task-0042 review: the spike originally mapped this to replay-safe `pre_start`. |
| SIGINT with a cancel requested (`terminal_reason:"aborted_streaming"`) | `cancelled` |
| `terminal_reason:"aborted_streaming"` with no cancel requested (for example shutdown, an external signal, or process loss) | `uncertain` (not replay-safe, per ADR 0002) |
| any other `is_error` result after init | `uncertain` |

### 8. Session persistence (confirmed)

- Sessions for a cwd are stored at `~/.claude/projects/<encoded-cwd>/<session-id>.jsonl`, next to a `memory/` folder. `<encoded-cwd>` is the resolved real path with every non-alphanumeric character replaced by `-`. For example, `/private/var/folders/…/T/tmp.XXXX` became `-private-var-folders-…-T-tmp-XXXX`. `claude auth status --json` also reports `projectsDirectory`.
- `--no-session-persistence` (print mode only) wrote no session file. Two such runs, including the permission-denial probe, left no trace in the probe's project folder. Their init and result events still carried a `session_id`. That ID cannot be resumed.
- The failed `--session-id` reuse and the unknown `--resume` runs also wrote no new session file.
- Recommendation: the concurrency/health probe should use `-p --no-session-persistence --output-format stream-json --verbose` with a disposable cwd. Even with `--no-session-persistence`, the CLI still creates `~/.claude/projects/<encoded-cwd>/memory/` for that cwd (confirmed independently in review). Because every probe uses a fresh cwd, these folders would pile up, so the probe (task-0046) must check that the folder holds only its own empty artifacts and then delete that exact folder by literal path, along with the temp project. Which flag disables all tools for the probe sessions was not verified here; task-0046 must confirm it.

## Implications for Phase 5a tasks

- Adapter: use `--session-id` on the first Turn and `--resume` afterwards. Classify Turns from the final `result` event, not the exit code. Skip unknown event types. Pass `--system-prompt-snapshot off` on every Turn so `agent.md` edits reach existing Sessions (D1); this effect is inferred from `--help`/the binary, not observed, and task-0042 verifies it with the real CLI. Map `aborted_streaming` without a requested cancel to `uncertain`.
- Fail-closed approvals (ADR 0007): pass `--permission-prompts none` (D2). Detect denials from `system/permission_denied` or `result.permission_denials`. Store only tool names and a count, never `tool_input` or `message`. No MCP permission-prompt server is needed.
- Credential guard: use `claude auth status --json` at startup and init `apiKeySource` on every Turn, as described in 5. Accept only `authMethod:"claude.ai"`; refuse `CLAUDE_CODE_OAUTH_TOKEN` (also by its presence in the environment, never its value) and every other source (D3, task-0044).
- Probe: use `--no-session-persistence`, delete the probe's own `~/.claude/projects/<encoded-cwd>/` folder by literal path, and confirm the tools-disable flag (task-0046).

## Open questions

- Exact stream shapes for an expired login and for an exhausted usage limit (not reproducible safely in this spike).
- SIGINT during a running tool call, and whether partial side effects can occur. Treat the outcome as `uncertain` unless a cancel was requested.
- Which `apiKeySource`/`authMethod` combinations other credential configurations actually produce (taken from the CLI bundle, not observed), including what a `CLAUDE_CODE_OAUTH_TOKEN` setup token reports. This does not block the guard, which refuses every source except `authMethod:"claude.ai"` with no API-key source and also refuses when `CLAUDE_CODE_OAUTH_TOKEN` is present in the environment, checking presence only (D3, task-0044).
- Which CLI flag disables all tools for the probe sessions. Resolved in task-0046: `--tools ""` (init showed `tools: []`), plus `--strict-mcp-config` with no `--mcp-config` for the throwaway probe sessions only.

This is a single controlled run against Claude Code `2.1.287`, not a claim about every version.
