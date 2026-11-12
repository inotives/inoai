---
status: accepted
---

# An Anthropic API runtime alongside the headless CLIs

inoai drove only locally signed-in CLIs: Codex, Claude CLI, and OpenCode. The owner asked for an API key as another choice (IP-0007). inoai now has a fourth Agent Runtime, `anthropic-api`. It calls the Anthropic Messages API directly with the official `@anthropic-ai/sdk` and a Console API key. The Codex and Claude CLI runtimes are unchanged and still refuse API keys.

This was chosen over two alternatives:

- **API-key login for the existing CLIs.** The Claude CLI and Codex guards exist to keep those runtimes on the owner's subscription (ADR 0008, Phase 4, Phase 5a). Weakening them would mix two billing models in one provider. A separate provider keeps each runtime's billing obvious.
- **The Claude Agent SDK.** ADR 0008 rejected it for subscription login. With an API key it would still bring local tools and a permission model. inoai needs only chat and web tools, so the plain Messages API is smaller.

## Narrowed V1 boundary

The V1 rule "Codex and Claude never use the OpenAI or Anthropic API" now applies to the `codex` and `claude` providers only:

- The `codex` provider still uses only the owner's ChatGPT sign-in.
- The `claude` provider still uses only the owner's Claude subscription sign-in. Its credential guard still refuses `ANTHROPIC_API_KEY` and every other non-subscription credential.
- Only the `anthropic-api` provider uses an API key.

`loadConfiguration` never copies `.env` into `process.env`. A key in a `claude` home's `.env` therefore never reaches the Claude CLI.

## Decisions

Interview:

- **Q1.** Build a direct API runtime, not API-key auth for the existing CLIs.
- **Q2.** Anthropic only. No OpenAI, OpenAI-compatible, Bedrock, Vertex, or Foundry runtime.
- **Q3.** Chat plus Anthropic server tools only: `web_search_20260209` and `web_fetch_20260209`. No local tools, MCP servers, skill scripts, or approval cards. Nothing runs on the owner's machine.
- **Q4.** History is stored as exact API content blocks in new append-only SQLite tables.
- **Q5.** `ANTHROPIC_API_KEY` lives only in the runtime home's `.env`.
- **Q6.** `ANTHROPIC_API_MODEL` defaults to `claude-opus-5-5` and accepts any model ID. `ANTHROPIC_API_EFFORT` is optional: `low`, `medium`, `high`, `xhigh`, or `max`. Unset means the model's own default.
- **Q7.** `anthropic-api` homes run Memory Review as one tool-free request.
- **Q8.** Usage records tokens only. There is no `cost_usd`.
- **Q9.** No compaction. A conversation too long for the model fails the Turn with a notice to use `/inoai reset`.
- **Q10.** Server-side refusal fallbacks are on (`fallbacks: "default"`).

Plan review:

- **R1.** On a home whose `AGENT_PROVIDER` is not `anthropic-api`, the three `ANTHROPIC_API_*` settings are ignored. `validate` and startup print a warning that names the setting, never its value. The home keeps working.
- **R2.** The system prompt and tool list are frozen per Session. A later instruction change is sent as a mid-conversation system message.
- **R3.** Task runs on `anthropic-api` use a text-only prompt line.
- **R4.** `inoai setup` supports `anthropic-api`.
- **R5.** An answer that cites web search results ends with a `Sources:` list.

## Client and startup

- The SDK client is pinned: explicit `apiKey`, `baseURL` `https://api.anthropic.com`, `logLevel: "off"`, OpenTelemetry off, `maxRetries: 0`, and a 600-second request timeout. `ANTHROPIC_BASE_URL`, `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_LOG`, and `ANTHROPIC_OPEN_TELEMETRY*` in `process.env` change nothing.
- Startup refuses to run when `ANTHROPIC_CUSTOM_HEADERS` is set in `process.env`. The SDK always adds those headers and cannot turn them off.
- Startup calls `models.retrieve` with a 30-second timeout. This proves the key and model without spending tokens. The model must support adaptive thinking and web search, and the configured effort if one is set. A failure stops startup with a fixed message that never quotes the key or a response body.
- `runRuntimeTurn` owns retries (ADR 0002). The home runs in per-Session mode without a probe. A later `uncertain` or `timed_out` Turn still drops the worker to global FIFO.

## Turns

- Each Turn is one streamed `client.beta.messages.stream` request with adaptive thinking, the configured effort, top-level automatic `cache_control` (5-minute TTL), and `max_tokens` set to the model's maximum, capped at 64,000.
- For `claude-fable-5-2`, `claude-fable-5-1`, `claude-opus-5-5`, `claude-opus-5`, and `claude-sonnet-5-5`, the request adds the beta `server-side-fallback-2026-07-01` and `fallbacks: "default"`. Other models get neither.
- Tools: `web_search` and `web_fetch`, each with `allowed_callers: ["direct"]` and `max_uses: 5` per request. `web_fetch` has `max_content_tokens: 20000`.
- Text streams as progress events. A `pause_turn` stop is continued at most 5 times per Turn. Usage is summed across continuations and fallback attempts.
- `Sources:` lists up to 5 unique URLs from web search citations. Pages read with web fetch carry no citations and are not listed (BL-0044).

## History and the frozen prompt

History lives in `agent_history_sessions` and `agent_history` ([schema](../sqlite-schema.md)). Both tables are append-only, with no-update and no-delete triggers, like `memory_uses`. They are not part of `/api/ui-data`.

- On a Session's first Turn, the instructions (`agent.md` plus the enabled-skill index) and the tool list are frozen in its `agent_history_sessions` row. Every later Turn resends exactly that prefix. The prefix holds no timestamp, so the prompt cache stays valid.
- When the current instructions differ from the latest ones the model saw, the Turn appends a mid-conversation `role: "system"` message after its user message. That message becomes part of history. The frozen prefix never changes.
- Each stored user message is the full composed prompt: the Memory section, the Task-block instruction with the current time, and any `SKILL.md` text. Later Turns resend all of it, including Memory deleted afterwards. The CLI runtimes behave the same way.
- A Turn's rows are written in one transaction just before its answer is yielded. A failed, cancelled, refused, or output-limited Turn writes nothing. `createSession` writes nothing, and a Session with no rows is empty, not `session_missing`.
- Rows are stored raw. On replay, inside a response that holds a `fallback` block, the `thinking`, `redacted_thinking`, `tool_use`, and unmatched `server_tool_use` blocks before the final `fallback` block are dropped, as the API requires.
- `/inoai reset` starts a new Agent Session. Old rows stay and are never resent.

**Crash gap.** History is written before the answer is archived and posted. If the process stops between the two, history holds an answer the owner never saw. Existing recovery marks that Message failed or uncertain (ADR 0002, ADR 0005). This gap is accepted.

**Model limit.** Mid-conversation system messages work only on models that support them. The default `claude-opus-5-5` does. Claude Sonnet 5 does not: after an `agent.md` or skill change, every later Turn in an existing thread fails with the generic `uncertain` notice until `/inoai reset`. The startup check cannot detect this support.

## Stop reasons and failures

Notices are fixed text. They never include SDK error messages, response bodies, or the key.

- `refusal` (the whole fallback chain declined) and `max_tokens` end the Turn with a fixed notice as its answer and write no history. In a Task run, that notice becomes `result.md`, and the run counts as completed.
- `model_context_window_exceeded`, or a 400 whose message says the prompt is too long, is the new failure kind `context_exhausted`. Its notice asks the owner to use `/inoai reset`.
- 401 and 403 → `authentication`, with a notice to check `ANTHROPIC_API_KEY` and restart.
- 429 and `billing_error` → `usage`. A low-credit error that the API sends as a plain 400 shows the generic `uncertain` notice instead. The live check confirms which shape the API uses.
- Connection errors and 5xx (including 529) before the Turn's first stream event → `pre_start`, replay-safe.
- Any error after the first stream event, including in a continuation → `uncertain`, not replay-safe.
- No stream event for 300 seconds → `timed_out`. A long silent thinking phase at high effort could trip it (BL-0043).
- The refusal, `max_tokens`, and authentication notices, and every failure notice, are excluded from Memory Review.

## Memory Review

This supersedes the sentence in ADR 0010 that only Claude reviews run in V1. Claude and `anthropic-api` homes review.

An `anthropic-api` review is one streamed request with no tools, no history, no betas, no fallbacks, and no thinking setting. Its system prompt is `reviewInstructions`. It uses the model's default effort (`medium` on Opus 5.5); `ANTHROPIC_API_EFFORT` does not apply. Its `max_tokens` is the model's maximum, capped at 16,000. It times out after 600 seconds with no stream event. It fails closed unless the reply ends with `end_turn` and holds only text and thinking blocks. Nothing is stored, so a failed review is safe to rerun.

## Skills and Task runs

- Skills: the worker still adds the selected `SKILL.md` text. It skips `prepareSkillScripts` and the execution instructions, because the runtime has no shell.
- Task runs: the prompt says "Reply in text; you cannot create files." inoai still writes the reply to `result.md`.

## Data flow and billing

Prompts, history, Memory sections, `SKILL.md` text, and web results go to Anthropic. They are billed to the Console organization that owns the key. Web search is billed per search. The key never reaches `process.env`, SQLite, Events, logs, Discord, or UI data.

## Consequences

- An owner can run an agent on pay-as-you-go API billing without a CLI install.
- The API runtime cannot edit files, run commands, or use MCP servers. Task runs return text only.
- Long threads eventually need `/inoai reset`.
- Changing `ANTHROPIC_API_MODEL` keeps existing threads. The API drops thinking blocks the new model cannot read, unbilled.
