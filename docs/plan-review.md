# Plan review: first grilling pass

## Resolved in this pass

- **Provider-neutral vocabulary:** application code and SQLite use Chat Transport, Conversation, Agent Runtime, and Agent Session. Discord and Codex are v1 adapters, not core data-model terms.
- **Control namespace:** user controls are `inoai` controls, not `/codex` controls, because the agent runtime is selectable.
- **Task scope:** scheduled and multi-iteration Tasks are deferred to a later phase. The current provider-neutral Conversation and Agent Session model is retained so that phase does not require a model rewrite.

## Findings requiring a product decision

1. **Retention:** accepted. Message logs are retained indefinitely as a local archive. Memory Reviews run once daily over only Messages since the prior recap; archived Messages are not automatically treated as Memory.
   The review runs at 06:00 in the host machine's local time.
   Reviews are silent and create timestamped recap entries for later Electron UI inspection.
   Review input is bounded to 20,000-character chronological windows; no recap cursor advances until its entire range succeeds.
   Only explicit Memory Signals (remember/take note/important) or useful recurring patterns across Recaps promote information into shared Memory.
   Failed Recaps retry up to three times later that day with bounded backoff.
2. **UI access:** accepted. The Electron UI runs locally on the same machine and opens SQLite directly; remote access and UI authentication are deferred.
3. **Task-thread steering, later:** accepted. An ordinary user message in an active Task thread is Task input that changes the next Task Run; it does not create an independent Turn in that thread.
4. **Canonical personality:** accepted. Each deployment's `.inoai-connect/agent.md` is inoai's single personality document. The core supplies it explicitly to Codex; future adapters do the same. A deployment project's own `AGENTS.md` remains a separate project instruction. Global Codex instructions are never changed.
5. **V1 agent capabilities:** accepted. inoai exposes the skills, MCP servers, and tools already configured for the local Codex CLI, including local OpenKnowledge and installed connectors. It preserves Codex's configured permission and sandbox policies and never adds an approval bypass. Actions that require human approval are declined through the V1 Discord bridge; the owner must use local Codex for those actions.
6. **Agent Session lifetime:** accepted. A thread's Agent Session never expires automatically; only `/inoai reset` replaces it. The SQLite archive remains regardless.
7. **V1 identity:** accepted. inoai uses a SQLite-backed transport-scoped User allowlist, seeded with the owner from `.env`. V1 admits only that owner; later family access adds active User records. Memory remains shared agent Memory, with source-message provenance rather than per-User isolation.
8. **Startup health:** accepted. Post `inoai is online` once when each app process first becomes Discord-ready. Reconnects in that process remain silent; a restarted app posts again.
9. **Backups:** accepted. V1 retains three rotating, SQLite-consistent snapshots on the same machine after the daily recap. A later phase copies backups to a Linux machine on the local network.
10. **Manual Memory Entry:** accepted. The local management CLI and Electron UI can create/soft-delete important Memory directly. This writes SQLite only and never invokes an Agent Runtime.
11. **Audit model:** accepted. Every persisted table uses uniform create/update/soft-delete timestamps and actors. Memory origin is audit provenance only; no Memory tier changes behavior. Soft-deleted records are hidden; V1 has no restore action.
12. **Runtime failures:** accepted, with the retry safety boundary amended for Phase 4. Retry at most three times with bounded backoff only if the turn never started or the runtime proves it had no side effects. A timeout, process loss, or ambiguous outcome after execution may have begun fails closed after that attempt; do not automatically replay it. Record each attempt or uncertain outcome, post one concise failure notice when no safe attempt remains, and publish at most one final response. Phase 5 recovery must not requeue such ambiguous work automatically.
13. **Permission approvals:** accepted, amended for Phase 4/V1. inoai declines every Codex approval request through the live protocol, stores only a non-secret outcome, and tells the owner to use local Codex for the blocked action. It never posts actionable Discord approval buttons or stores raw request details. Codex CLI `0.157.1` has no complete safe preview for the current approval shapes; generic prompts would be blind consent, while copying arbitrary request text could leak credentials. This is a Discord relay limit, not a change to Codex's configured approval or sandbox policy. A legacy saved pending row cannot restore a lost live Codex request; fail it closed on restart and never replay the interrupted turn.
14. **Turn ordering:** accepted. Process Messages FIFO with one active Codex turn per Discord thread/Session. A later Message is persisted immediately and waits for its Session's current turn; separate Sessions may run independently after concurrent-session validation.
15. **Concurrency fallback:** accepted. If concurrent Codex Sessions cannot be validated or become unreliable, inoai automatically falls back to one global FIFO queue rather than refusing service or losing queued Messages.
16. **Portable core and separate UI:** accepted. Publish the core as a single executable that uses a `.inoai-connect/` runtime home in the launch folder. It creates that directory from a bundled template when absent; the directory owns `.env`, `agent.md`, SQLite, and local backups. The analytics UI is a separate application and is not served by the core.
17. **Memory retrieval:** accepted. Memory is one shared agent-wide namespace. For each turn, inoai ranks active Memory locally against the incoming message and supplies only the most relevant items within a fixed 6,000-character context budget.
18. **UI data path:** accepted. The separate Electron UI opens a user-selected local `.inoai-connect/inoai.sqlite` directly in its main process; the core does not host a dashboard API. The renderer receives only a narrow preload bridge. Development uses one ignored repository-root `.inoai-connect/`; tests use disposable temporary runtime homes.
19. **Deployment package:** accepted. Deploy the core executable and Electron UI bundle as siblings. `inoai ui` launches the sibling UI for the current deployment; `.inoai-connect/` contains state only and never application binaries.
20. **Runtime homes and locks:** accepted. Default to `.inoai-connect/`, with semantic alternatives such as `--connect-dir .inoai-connect-claude` for an independent agent configuration in the same deployment folder. Each home selects one provider and has separate credentials, sessions, archive, and agent-wide Memory. Allow one core process per runtime home through a local lock; different runtime homes may run separately.
21. **Role-based Agent Instances:** accepted. A named runtime home may distinguish agent role as well as provider, for example `.inoai-connect-planner` or `.inoai-connect-designer`. Its `agent.md` defines that role and its database keeps the instance's Memory and archive separate.
22. **UI Agent Instance switching:** accepted. The Electron UI provides a native **Load SQLite** action to choose and validate an `inoai.sqlite` file, then switches views to that Agent Instance. It never reads the selected runtime home's `.env`.
23. **Shared Discord channel:** accepted. Role-based Agent Instances may use the same Discord channel because each has a distinct bot mention label and owns only the threads it creates. A bot ignores another bot's threads.
24. **No agent-to-agent loops:** accepted. A cross-agent mention inside an existing thread is not a handoff and cannot create a Session for the mentioned agent. Every Agent Instance ignores bot-authored Messages. Users start another agent in a new top-level mention; explicit handoff is deferred.
25. **One agent per new request:** accepted. A top-level request mentioning multiple agent bots is unsupported in V1. No bot creates a Session or thread, selects a winner, or splits the request; the user sends separate top-level messages instead.
26. **Approval controls:** deferred beyond V1. No Discord **Approve**/**Reject** buttons are posted for Codex actions; every approval request is declined with a safe notice. Do not substitute a command allowlist or blind approval. Legacy pending rows/buttons from earlier local builds must be failed and made inert during recovery.
27. **Release platform:** accepted. V1 packages the core executable and Electron UI for macOS only. Windows and Linux artifacts are deferred until macOS deployment is proven.
28. **Claude runtime:** accepted for Phase 5a. Claude CLI becomes a second V1 Agent Runtime with Codex parity: headless `claude -p` per Turn (ADR 0008), fail-closed permission prompts (ADR 0007), subscription sign-in verified at startup, `agent.md` appended each Turn, per-thread provider-mismatch refusal, a tool-free concurrency probe, and the same three-layer acceptance bar as Phase 5.

## Checks before implementation

- Confirm the selected Codex app-server flow can start, continue, cancel, and stream an authenticated ChatGPT-backed local session.
- Run the DDL against the target Node/SQLite version and exercise duplicate inbound delivery and crash recovery.
- Confirm required Discord gateway intents and permissions for mentions, message content, thread creation, and thread replies.
