# Phase 5b: OpenCode headless contract spike

Date: 2026-10-03
OpenCode CLI: `opencode v2.0.22` (`opencode --version`), installed at `~/.opencode/bin/opencode` (not on the non-interactive PATH)
Scope: OpenCode's configured default model (the free OpenCode Zen model `opencode/fledge-alpha-free`, reported by `session export`), no authenticated providers, disposable `mktemp -d` project directories, trivial prompts

## Question

Does `opencode run --format json --standalone` give the OpenCode adapter what Phase 5b and ADR 0009 assume? That means a stable session ID, resume across separate processes, a read-only way to detect a missing session, a persona channel that adds to OpenCode's own prompt and the project's instructions, observable auto-rejected permissions, clean SIGINT, a usable error and exit-code classification, and acceptable startup time.

## Procedure

Every run used its own fresh `mktemp -d` directory as cwd. No `.inoai-connect*` directory, OpenCode config (`~/.config/opencode/*`, `service.json`), OpenCode database, or credential storage was read or changed, and no `auth`/credential endpoint was called. No run passed `--auto`, `--yolo`, `--dangerously-skip-permissions`, `--model`, or permission-loosening config. The base command was:

```text
opencode run --format json --standalone [--session <id>] ["<prompt>"]
```

It was spawned without a shell from a small Node harness that recorded stdout, stderr, exit code, and timing. Eleven model runs were sent: ten standalone, plus one through the background service for comparison. All prompts were trivial ("Reply with the word ok", a recall question, a permission probe, and a short essay request for the SIGINT test). Read-only checks used `opencode session list|export --standalone` and `opencode api --standalone GET …`. Some answers come from reading strings in the 2.0.22 binary; each one is marked "(binary)".

Samples are trimmed. Session, message, and part IDs are shown as `ses_<id>`, `msg_<id>`, `prt_<id>`. Temp paths are shown as `<tmp>`.

## Findings

### 1. NDJSON event shapes and the stdout/stderr split (confirmed)

stdout carries one JSON object per line. Every event has `type`, `timestamp` (ms), and `sessionID`. Events are emitted per **completed part**, not as deltas: `step_start` and the `text` event arrived close together, after the text was complete.

| Event | Observed shape (trimmed) |
| --- | --- |
| Step start | `{"type":"step_start","sessionID":"ses_<id>","part":{"id":"prt_<id>","messageID":"msg_<id>","type":"step-start"}}` |
| Text | `{"type":"text","sessionID":"ses_<id>","part":{"id":"prt_<id>","messageID":"msg_<id>","type":"text","text":"ok","time":{"start":…,"end":…}}}`. One event per completed text block. |
| Tool use | `{"type":"tool_use","part":{"type":"tool","tool":"read","id":"functions.read:0","state":{"status":"error","input":{"path":"<tmp>/secret.env"},"error":"This non-interactive run cannot ask the user for permission, so the request was rejected. Continue without this action.","metadata":{"providerCall":{"executed":false},"rawInput":"…"},"time":{…}}}}`. `state.status` is `completed` or `error`. |
| Step finish | `{"type":"step_finish","part":{"type":"step-finish","reason":"tool-calls","cost":0,"tokens":{"input":9744,"output":257,…}}}` |
| Error | `{"type":"error","sessionID":"ses_<id>","error":{"type":"provider.auth","message":"…","status":403,"response":{"body":"…"}}}` |

- `reasoning` events did not appear without `--thinking`. Reasoning was still stored in the session (seen in `session export`).
- **There is no reliable end-of-turn event.** `step_finish` appeared only after tool-call steps (`reason:"tool-calls"`). The final text step of every successful run ended with its `text` event and no `step_finish`. The end of a Turn is the process exit. Afterwards, `GET /api/session/<id>` reports `data.outcome` (`"succeeded"` or `"failed"`) for the last completed Turn. After a SIGINT, `outcome` was missing until the next Turn finished.
- On success, stderr was empty. stderr carries the permission auto-rejection lines (see 4), with ANSI color codes.
- **Prompt delivery:** an argv prompt was stored in the session wrapped in literal double quotes (`"\"Reply with the word ok\""` in `session export`). A prompt written to stdin with no argv message was stored verbatim and answered normally. The adapter should send the prompt on stdin.

### 2. Sessions (confirmed, with one constraint)

- **First run without `--session`:** OpenCode creates the session. The ID (`ses_` plus 26 characters) appears in every event's `sessionID`, starting with the first `step_start` or `error` event. It also appears in `session list`.
- **Resume across standalone processes works.** A second `opencode run --standalone --session <id>` in a new process recalled the earlier prompt. Every event carried the same `sessionID`, so the session did not fork. Resume also worked after a SIGINT-interrupted Turn (see 5).
- **A pre-assigned ID does not work on the free tier.** `--session ses_<26 random alphanumerics>` on a first run *created* a session with that ID (it then showed up in `session list`). The model call then failed: exit `1`, and one `error` event:
  ```json
  {"type":"error","sessionID":"ses_<pre-assigned>","error":{"type":"provider.auth","message":"Error from provider (Console): OpenCode's free tier can only be used from within OpenCode","status":403,"response":{"body":"{\"type\":\"error\",\"error\":{\"type\":\"FreeTierError\",…}}"}}}
  ```
  This happened twice in a row: once with persona config and once in a bare directory with no config. A run without `--session`, made immediately afterwards, succeeded. The likely cause is that the Zen free-tier gateway rejects session IDs OpenCode did not generate (inferred, not proven). Either way, the adapter must let OpenCode create the session on the first Turn and store the `sessionID` from the stream.
- **An unknown ID silently creates a session.** `--session <unknown ses_ id>` does not fail with "not found"; it creates a new, empty session under that ID, as the `--help` text says ("Session ID to continue, or to create if it does not exist"). A missing stored session would therefore lose context without any error unless the adapter checks first.
- **Read-only existence check (confirmed; it creates nothing).** Two commands work, and neither created a session:
  - `opencode api --standalone GET /api/session/<id>`: exit `0` with `{"data":{"id":…,"outcome":…,"location":{"directory":…},…}}` when the session exists. Exit `1` when it does not, with stdout `{"_tag":"SessionNotFoundError","sessionID":…,"message":"Session not found: <id>"}` and stderr `HTTP 404 Not Found`.
  - `opencode session export --standalone <id>`: exit `0` with the full transcript on stdout, or exit `1` with `Session not found: <id>`. It is heavier, because it prints the whole transcript.

  Each check took about 0.14–0.3 s. Both found the session from a different cwd, so the lookup is global, not per project. `session list` is per project ("current project") and is not suitable.
- **Deleting sessions:** `opencode session delete --standalone <id>` exits `0` and prints `Session <id> deleted`. It also deletes child sessions. Afterwards, `GET /api/session/<id>` exits `1`. An unknown ID exits `1` with `Session not found: <id>`.
- Standalone runs and the background service share the same store: a standalone-created session was listed through the service.

### 3. Persona (`OPENCODE_CONFIG_CONTENT` `instructions` does **not** work; a working alternative was found)

Owner decision D1 (after this spike): `agent.md` is prepended to every Turn's stdin prompt as a delimited "inoai operating instructions (not a user message)" block. Neither `OPENCODE_CONFIG_CONTENT` nor the experimental instructions API below is used. See "Implications for the adapter".

Setup: a temp project with `persona.md` (`ZEBRA-42` marker), `project-instr.md` (`QUOKKA-7`), `opencode.json` `{"instructions":["project-instr.md"]}`, and `AGENTS.md` (`PANDA-9`). The run set `OPENCODE_CONFIG_CONTENT={"instructions":["<tmp>/persona.md"]}`.

- Observed answer: `ok PANDA-9`. The stored reasoning mentioned only the AGENTS.md rule. Neither the `OPENCODE_CONFIG_CONTENT` `instructions` entry nor the project `opencode.json` `instructions` entry reached the model.
- (binary) In 2.0.22, `instructions` is still in the config schema ("Additional paths or URLs supplying ambient instructions"), and `OPENCODE_CONFIG_CONTENT` is loaded as a virtual config document. However, the only file-based instruction source (`opencode.config.instruction`) reads the global `AGENTS.md` and the project `AGENTS.md` files from cwd up to the project root. Nothing consumes the `instructions` list. The planned `OPENCODE_CONFIG_CONTENT` mechanism is not viable on this version.
- **Working alternative, the session instruction entry API (experimental):** `opencode api --standalone PUT /api/experimental/session/<id>/instructions/entries/inoai-persona -d '{"value":"<text>"}'` exits `0`. `GET …/instructions/entries` then returns `{"data":[{"key":"inoai-persona","value":"…"}]}`. The entry is durable in the session. On the next `run --session <id>`, OpenCode added a synthetic system message to the conversation:
  ```text
  The instructions changed:
  Instructions from: <tmp>/AGENTS.md
  # Project rules … KOALA-5 …

  <context key="inoai-persona">
  Always end every answer with the exact token ZEBRA-42.
  </context>
  ```
  The answer was `ok KOALA-5 ZEBRA-42`: both the entry and the edited project AGENTS.md applied. OpenCode's own prompt stayed in place; the agent still used its tools and environment section. (binary) Instruction sources are concatenated: built-ins, discovered AGENTS.md files, and API entries. So the entry **adds to** OpenCode's default prompt and the project's `AGENTS.md`; it does not replace them. Changes are announced as a diff or update at the next step boundary. A PUT with the same key replaces the value; `DELETE` removes the entry.
- **Edits apply on the next run:** an edit to `AGENTS.md` between two `--session` runs reached the second run as "The instructions changed: …". An entry PUT between runs reached the next run in the same way. Re-PUTting a *changed* value was not run separately, but it uses the same update path (binary).
- Limitation (superseded by D1, see Implications; the adapter does not use this API): an entry needs an existing session. On the first Turn the session does not exist until `run` creates it. One workaround is to create the session first with `POST /api/session` and then PUT the entry; this was not exercised, and a pre-created session might hit the same free-tier check as a pre-assigned ID. The endpoint is under `/api/experimental/` and may change between versions.

### 4. Permission auto-rejection (confirmed)

Prompt: read `secret.env` in cwd (it held `FAKE=not-a-secret`), then list `/usr/share`. Both requests hit default `ask` rules and were rejected automatically. Neither the file contents nor the listing reached the model.

- stdout: a `tool_use` event with `state.status:"error"`, `metadata.providerCall.executed:false`, and the fixed error text `"This non-interactive run cannot ask the user for permission, so the request was rejected. Continue without this action."` `state.input` and `metadata.rawInput` contain the raw path.
- stderr: one line per rejection, written verbatim, ANSI codes included:
  ```text
  \e[93m\e[1m! \e[0mpermission requested: read (secret.env); auto-rejecting
  \e[93m\e[1m! \e[0mpermission requested: external_directory (/usr/share/*); auto-rejecting
  ```
- The Turn continued and the model reported both denials. The run exited `0`. A denial is not a runtime failure.
- **Secret risk:** the stderr resource list, `state.input`, and `rawInput` hold raw paths and could hold commands or content. The adapter records only a count of rejections. It never records tool names, input, the resource text, or the error string.
- **Count source:** the count is the number of stdout `tool_use` events with `state.status:"error"` whose `state.error` starts with the fixed prefix "This non-interactive run cannot ask the user for permission". stderr lines are never added to it.
- **Resolved by task-0053:** a real check with one `read` and one `external_directory` rejection produced 2 stdout `tool_use` error events with the fixed prefix and 2 stderr lines, so each rejection (including `external_directory`) has its own stdout event and the stdout-only count does not under-count.

### 5. SIGINT (confirmed)

Test: a 600-word essay prompt. SIGINT was sent only to the spawned CLI pid, 6.0 s after spawn, while the model was still in reasoning.

- Exit code `130`, stderr empty, and no stray `opencode` processes afterwards.
- The stream was `step_start`, then about 6 ms after the signal:
  ```json
  {"type":"error","sessionID":"ses_<id>","error":{"type":"unknown","message":"Transport: The socket connection was closed unexpectedly. …"}}
  ```
  The `error.type` is a generic `unknown`, not an abort type, so the adapter must classify from exit `130` together with whether it requested the cancel.
- The stored assistant message ended with `finish:"error"`, `error:{"type":"aborted","message":"Step interrupted"}`. The session's `outcome` was missing until the next Turn.
- `--session <id>` (prompt on stdin) afterwards succeeded and recalled the topic ("The history of tea."). The interrupted step was **not** automatically re-run. This was one run; a SIGINT during a tool execution was not tested.

### 6. Exit codes and error classification (partly confirmed)

| Observed | Exit | Stream |
| --- | --- | --- |
| Success | `0` | `step_start`/`text` (+ `tool_use`/`step_finish`), no `error` |
| Success with auto-rejected tools | `0` | `tool_use` `status:"error"` with the rejection text; stderr lines |
| Free-tier rejection (pre-assigned ID) | `1` | single `error` `type:"provider.auth"`, `status:403`, body `FreeTierError` |
| SIGINT | `130` | `step_start`, then `error` `type:"unknown"` (transport closed) |

- (binary) Provider error types that runs can emit include `provider.rate-limit`, `provider.auth`, `provider.quota`, `provider.content-filter`, `provider.transport`, `provider.internal`, `provider.invalid-output`, `provider.invalid-request`, `provider.unsupported-operation`, `provider.no-route`, `provider.unknown`, `provider.timeout`, and a generic `unknown`.
- **Rate limit / quota:** not observed; the free tier never rate-limited these runs. The expected shape is an `error` event with `type:"provider.rate-limit"` or `"provider.quota"` and exit `1` (binary, not verified).
- Not-logged-in / expired auth for a paid provider: not observed (no provider is configured). `provider.auth` is the expected type.

### 7. Startup latency (confirmed acceptable)

Measured from spawn until the session's user message was created (from `session export` timestamps): 287, 292, 296, 305, and 306 ms across five standalone runs. Session creation took 257–269 ms after spawn. A bare `session list --standalone` takes about 0.27 s. Time to the first stdout event (1.0–4.1 s, once 22 s) and total time (1.1–12 s, once 22 s) are dominated by model latency, because events are emitted only after each part completes. The single background-service run created its session 106 ms after spawn, with first event at 1.6 s and total 2.1 s. Standalone adds roughly 150–200 ms per Turn, which is acceptable. Standalone runs needed no change to service configuration.

### 8. Cleanup (done)

Eight spike sessions were created: five normal sessions, two pre-assigned-ID sessions that failed, and one through the background service. Each was deleted with `opencode session delete --standalone <id>` from its own temp directory. After deletion, `GET /api/session/<id>` returned exit `1` for every ID and `session list` was `[]` in every temp directory. All seven temp directories were removed. OpenCode may still keep per-directory *project* records (`projectId`) for those temp paths. This CLI has no project-delete command, so they were left alone rather than touching the database.

## Implications for the adapter

- **Spawn:** `opencode run --format json --standalone [--session <id>]` with no shell. Write the prompt to stdin and pass no argv message. Never pass `--model`, `--auto`, `--yolo`, or `--dangerously-skip-permissions`. Skip unknown event types.
- **Answer:** join the `part.text` of the `text` events from the final step only, meaning the events after the last `step_start`, separated by `"\n\n"`. Text from earlier tool-call steps (steps that end with `step_finish reason:"tool-calls"`) is interim narration and is not part of the answer. This is the closest match to the Claude adapter, which answers from the final `result` only. Each event is a completed block, so there are no deltas to merge. The Turn ends when the process exits; there is no terminal event. The evidence fits this rule: every successful run's final step was `step_start` followed by `text` with no `step_finish`, and tool steps ended with `step_finish reason:"tool-calls"`. Interim text inside a tool-call step was not specifically captured, so task-0052 should cover it with a fake-CLI test.
- **Sessions:** on the first Turn, omit `--session` and store the first event's `sessionID`. Never pre-assign. Before resuming a session this process has not yet seen succeed (for example, the first resumed Turn after a restart), run `opencode api --standalone GET /api/session/<id>`. This mirrors the Claude adapter's in-memory record of sessions it has persisted, so the check does not add about 0.2–0.3 s to every Turn. Results:
  - Exit `0` → resume with `--session <id>`.
  - Exit `1` with `SessionNotFoundError` → `session_missing` (not replay-safe; tell the owner to use `/inoai reset`).
  - Any other failure (exit `1` without `SessionNotFoundError`, or a spawn failure) → `pre_start`, because no Turn ran.

  Never run `--session` on an ID that was neither checked nor seen to succeed, because an unknown ID silently creates an empty session. A `sessionID` stored from a first Turn that then failed or was `uncertain` has not been seen to succeed, so it is also checked before its first resume.
- **Persona (owner decision D1):** `OPENCODE_CONFIG_CONTENT` `instructions` is ignored by 2.0.22, so the originally planned mechanism does not work. The owner chose to prepend `agent.md` to every Turn's stdin prompt as a clearly delimited "inoai operating instructions (not a user message)" block, read fresh each Turn. The adapter does not use `OPENCODE_CONFIG_CONTENT` or the experimental session instructions API. Edits to `agent.md` therefore reach the next Turn, and the project's `AGENTS.md` still applies natively. The cost is that the persona is part of conversation history rather than instructions. The planner updated these docs for D1:
  - `docs/implementation-phases.md` Phase 5b task 3 (`:201`) and the Phase 5b persona test scenario (`:214`)
  - `docs/discord-codex-cli-harness-proposal.md` "OpenCode runtime (Phase 5b)" section (`:104`)
  - `docs/plan-review.md` decision 29
  - the Persona scope bullet in task-0052

  Do not write the project's `AGENTS.md`: it belongs to the project.
- **Failure kinds** (map `RuntimeFailureKind`):

  | Signal | Kind |
  | --- | --- |
  | `error.type` `provider.auth` (including `FreeTierError` 403) | `authentication` |
  | `error.type` `provider.rate-limit` or `provider.quota` (binary, not observed) | `usage` |
  | spawn failure (ENOENT/EACCES) of `opencode run` | `pre_start` (replay-safe) |
  | existence check exit `1` without `SessionNotFoundError`, or the check fails to spawn | `pre_start` (no Turn ran) |
  | existence check `SessionNotFoundError` | `session_missing` |
  | exit `130` after the adapter sent SIGINT for `/inoai cancel` or `reset` | `cancelled` |
  | exit `130` or a signal with no cancel requested, or process loss | `uncertain` |
  | the 5-minute idle timeout fired | `timed_out` |
  | any other non-zero exit, signal, or `error` event, including a non-zero exit with zero parsed stdout events | `uncertain` |

  Rule: replay-safe `pre_start` is only a spawn failure (ENOENT/EACCES) or an existence-check failure without `SessionNotFoundError`. Once `opencode run` has spawned, every other non-zero exit or signal is `uncertain`, even with zero parsed stdout events. OpenCode stores the session and the user message about 0.3 s after spawn (see 7), but emits its first stdout event only after 1.0–4.1 s, once a part is complete (see 1). A run that crashes or is killed in that window may already have recorded the user message, or run a tool whose `tool_use` event was never emitted, so a replay could duplicate the message or its side effects. The free-tier `provider.auth` error shows this: it arrived with no `step_start`, yet the session and the user message were already recorded.

  Precedence, first match wins: spawn failure (`pre_start`) → `timed_out` → `authentication`/`usage` from an `error` event → `cancelled` (cancel requested) → `pre_start` (existence check only) → `uncertain`. The order of `timed_out` before `cancelled` before `pre_start` mirrors `src/claude-runtime.ts`, so a cancel or an idle timeout before the first event is never replay-safe. Unlike Claude, which treats a run with no init event as `pre_start`, OpenCode has no early start event emitted before model or tool work, so "no events yet" proves nothing here.
- **Denials:** the count is the number of stdout `tool_use` events where `state.status:"error"` and `state.error` begins with "This non-interactive run cannot ask the user for permission". Never add stderr `permission requested: … auto-rejecting` lines to it. Post the fixed notice once per Turn with a count-only `approval_unsupported` Event (`denials=<n>`, no tool names). Never store tool names, `input`, `rawInput`, the resource list, or the message. Task-0053 confirmed the stdout and stderr counts match (see 4).
- **Free-tier risk:** the Zen free tier allows use only "from within OpenCode". inoai runs pass today because they are the stock CLI with OpenCode-generated session IDs. A future gateway or CLI change could reject them; that would surface as `provider.auth` and map to `authentication`, where the login hint `opencode auth login` would mislead a free-tier user. Recommend that the README (task-0054) mention this, and that the OpenCode `authentication` notice be worded to cover a free-tier refusal (for example, "OpenCode could not authenticate with its configured provider…").
- **Cancel:** send SIGINT to the spawned pid. Expect exit `130` and an `unknown` transport error event. The session stays usable afterwards.
- **Latency:** standalone startup is about 0.3 s, so the stop rule does not apply.

## Open questions

- Whether the free-tier rejection of pre-assigned IDs is about the ID format or about something else.
- Real rate-limit and quota event shapes, and auth errors for paid providers.
- SIGINT during a running tool call.
- Whether a later OpenCode version restores `instructions` from config. The adapter should not depend on it.

This was one controlled run against OpenCode `v2.0.22`; it is not a claim about other versions.
