<p align="center">
  <img src="logo.svg" alt="inoai logo" width="160">
</p>

<h1 align="center">inoai</h1>

<p align="center">
  A local Discord bridge to your own signed-in coding-agent CLI: Codex, Claude Code, or OpenCode.
</p>

<p align="center">
  <img alt="Status: V1 in progress" src="https://img.shields.io/badge/status-V1%20in%20progress-white?style=for-the-badge&labelColor=000000">
  <img alt="Runtime: Node.js 22" src="https://img.shields.io/badge/runtime-node.js%2022-white?style=for-the-badge&labelColor=000000">
  <img alt="Language: TypeScript" src="https://img.shields.io/badge/language-typescript-white?style=for-the-badge&labelColor=000000">
  <img alt="Platform: macOS" src="https://img.shields.io/badge/platform-macOS-white?style=for-the-badge&labelColor=000000">
</p>

<p align="center">
  <a href="docs/discord-codex-cli-harness-proposal.md">Proposal</a>
  ·
  <a href="docs/implementation-phases.md">Implementation Phases</a>
  ·
  <a href="docs/postgres-local.md">Advanced PostgreSQL Tools</a>
  ·
  <a href="docs/adr/">ADRs</a>
  ·
  <a href="CONTEXT.md">Domain Language</a>
</p>

---

## What It Is

inoai is a local personal-agent bridge. It connects a Discord bot to a coding-agent CLI that is already installed and signed in on your machine, and it keeps operational conversation history and durable agent Memory in local SQLite.

It drives the CLI you already use instead of calling a model API. Codex runs on your ChatGPT sign-in, Claude Code on your Claude subscription, and OpenCode on whatever provider it is configured with. inoai itself never calls the OpenAI or Anthropic API, and it never loosens the CLI's own permission policy.

- An `@inoai` mention starts a dedicated Discord thread, and follow-ups in that thread continue the same Agent Session.
- SQLite records users, sessions, messages, events, approvals, daily Recaps, and shared Memory, with audit fields and soft deletion in each runtime home.
- Permission requests fail closed with a fixed notice. Discord **Approve** / **Reject** buttons are deferred.
- A silent Daily Memory Review turns each Agent Session's new Messages into a Recap and, when warranted, shared Memory.
- Owner-only Tasks run once on command or recur on a whole-hour or whole-day interval. Each Task has its own Discord thread and Agent Session.
- A separate macOS Electron app (Phase 7) reads the selected local SQLite database; SQLite is the core runtime's source of truth.

Status: Conversation workers, Codex, Claude CLI, OpenCode, Daily Memory Review (Claude homes only in V1), and Tasks are implemented. The runtime uses SQLite. PostgreSQL tools remain available for advanced testing; the later central reporting sink, Electron app, and V1 hardening remain.

## Core Model

Deploy inoai into the folder it should assist. Each hidden runtime directory is one independent Agent Instance with its own configuration, Discord identity, and SQLite database:

```text
my-project/
├── inoai                      # portable core executable
├── inoai-ui.app/              # sibling Electron analytics app
├── .inoai-connect/            # general Codex agent (default runtime home)
│   ├── .env
│   ├── agent.md
│   ├── inoai.sqlite
│   ├── backups/
│   └── results/               # Task files by Task ID and Run ID
├── .robin-xai-test/           # Robin-XAI test instance (with its own results/)
├── .inoai-connect-claude/     # Claude CLI adapter (Phase 5a)
├── .inoai-connect-opencode/   # OpenCode CLI adapter (Phase 5b)
```

On first start, the core creates the runtime home from bundled templates and never overwrites an existing one. It opens the runtime home's `inoai.sqlite`, creates a missing database through the existing schema path, and reuses existing SQLite data. There is no automatic PostgreSQL-to-SQLite migration. One core process writes each runtime-home database; the UI and read-only tools may inspect it. The UI may also create, edit, and control Tasks through short-lived writes (ADR 0026). Stop the core before using local commands that write Memory or the allowlist. Runtime homes are git-ignored and must never be committed. Do not share one runtime home between machines.

The local `inoai.lock` is a `0600` JSON record containing the owning process
PID, its macOS process start time, and a release token. If startup finds an
existing lock, it reclaims it only when that exact process is gone or its
start time no longer matches (protecting against PID reuse). Recovery runs
only during startup; there is no lock refresher. Legacy UUID-only and malformed
locks cannot be verified safely and remain locked until removed deliberately.
Normal startup does not acquire a PostgreSQL lease.

`agent.md` defines that instance's role and personality. Project guidance comes from each CLI's own loading: `AGENTS.md` for Codex and OpenCode, `CLAUDE.md` for Claude.

Discord rules:

- Multiple agent bots may share a channel. Each reacts only to its own top-level `@label` mention and owns only the threads it created.
- A mention of another bot inside an existing thread is not a handoff; start that agent from a new top-level message instead. A top-level message mentioning several agent bots creates nothing.
- Bots ignore bot-authored messages, which prevents agent-to-agent loops.
- V1 admits the configured owner and explicitly allowlisted family users.
- An owner mention starts a conversation in any accessible channel of the configured server except the status-only channel. Ordinary top-level messages do nothing; follow-ups in a bound thread need no mention.

## Dependencies

```text
Node.js 22 or newer
macOS (V1 release target)
A Discord bot per concurrently running Agent Instance
One signed-in agent CLI per runtime home: codex, claude, or opencode
```

## Installation

```bash
npm install
npm run build
```

### Local database

Normal setup needs no PostgreSQL service or Docker. SQLite is the local source
of truth for startup, queue state, conversations, Memory, and recovery.
Normal validation and startup ignore `POSTGRES_*` settings; leftover keys are tolerated.

A later phase will send an asynchronous, one-way, redacted SQLite-to-PostgreSQL
copy for central reporting and backup. PostgreSQL will not own live work or
block local startup. This phase adds no sync queue, exporter, or dual writes.
See [ADR 0020](docs/adr/0020-local-sqlite-source-of-truth.md).

Existing `postgres:migrate`, `postgres:provision`, `postgres:test`, and
`postgres:integration` commands are explicit advanced/future tooling.
See [the PostgreSQL tooling guide](docs/postgres-local.md) for opt-in setup.

## Setup

### Codex (default runtime home)

```bash
# The first validation creates .inoai-connect/ with a blank .env and reports missing settings.
npm run validate
cp .env.sample .inoai-connect/.env
# Edit .inoai-connect/.env with your local Discord values.
npm run validate
npm start
```

Set `DISCORD_STATUS_CHANNEL_ID` to the channel for the startup online notice; it never starts conversations. The older `DISCORD_ALLOWED_CHANNEL_ID` key is no longer accepted; update existing local runtime-home `.env` files before starting this version. The bot needs access to the status channel and to every channel where you start conversations, including permission to create threads.

`npm run validate` is offline. It checks the required settings, `CHAT_PROVIDER=discord`, `AGENT_PROVIDER` (`codex`, `claude`, or `opencode`), a well-formed optional `CLAUDE_MODEL`, a digits-only optional `DISCORD_TASK_CHANNEL_ID`, a local `HH:MM` `MEMORY_REVIEW_TIME`, and a positive `MEMORY_REVIEW_MAX_CHARS`. It does not contact Discord or any agent CLI.

The runtime-home profile is provider-neutral Markdown. It must contain the
required identity, mission and scope, personality and communication, operating
rules, safety and authority, and enabled skills sections. Validate it without
starting the app or contacting a provider:

```bash
npm start -- profile validate --connect-dir .robin-xai-test
```

inoai reads and validates `agent.md` at the start of each new Turn. A valid
edit applies to the next Turn without a restart. An active Turn keeps the
profile snapshot that it started with. Invalid profiles fail closed before
runtime work starts.

Skills are managed per Agent Instance by the owner. The public CLI uses
`--agent <name>` and resolves it to `.inoai-connect-<name>` in the deployment
folder. Acquisition does not enable a package. The owner must review the
manifest and run a separate approval command.
See the [skill-management phase plan](docs/archived/skill-management-phase-plan.md) and
[ADR 0023](docs/adr/0023-skill-acquisition-and-approval.md) for the workflow
boundary and approval rules.

```bash
# Add one skill from a skills.sh page. --skill is required for selection.
npm start -- skills add https://skills.sh/<owner>/<repo>/<skill-id> --skill <skill-id> --agent robin
# Add one skill from an upstream repository.
npm start -- skills add https://github.com/<owner>/<repo> --skill <skill-id> --agent robin
# Add one skill from a local custom repository or package tree.
npm start -- skills add ../anyhow-skills --skill <skill-id> --agent robin
npm start -- skills list --agent robin
npm start -- skills enable <skill-id> --agent robin
npm start -- skills update <skill-id> --agent robin
npm start -- skills disable <skill-id> --agent robin
npm start -- skills remove <skill-id> --agent robin --yes
```

The source must contain `SKILL.md`. A source with multiple skills must include
the required `--skill <skill-id>` selection. A package without `skill.yaml`
gets a generated manifest with version `0.0.0`, all capabilities set to
`none`, and non-secret source provenance (`locator`, `skill`, and `revision`).
An existing valid manifest keeps its identity, version, and capabilities; inoai
updates only its provenance block. Invalid manifests, symlinks, and unsupported
package entries fail before the selected runtime home changes.

The package is copied into the runtime home's `skills/` directory and hashed.
`skills-enabled.json` records the package ID, version, full hash, capability
snapshot, approver, and approval time. `enable` creates that approval; a
changed source, manifest, or package hash is not enabled until it is approved
again. `update` repeats the remembered source, swaps the replacement only
after staging and validation, and revokes the old approval. A failed update
keeps the old package and approval. `disable` removes approval but keeps the
package. `remove` requires the package to be disabled and `--yes`, then removes
the package.

These are local owner operations for one runtime home. Discord turns and the
Agent Runtime cannot install, enable, update, disable, or remove skills.
Credentials never enter manifests or provenance. Provider
sandbox, network, and approval policy remain authoritative; inoai does not
spawn skill scripts or pass runtime-home credentials as script input.

For a legacy or test home, use `--connect-dir` instead of `--agent`; do not
pass both. The explicit package command remains available for a pre-staged
legacy/test package:

```bash
npm start -- skills install --package-dir ./<skill-directory> --connect-dir .robin-xai-test
npm start -- skills list --connect-dir .robin-xai-test
npm run validate -- --connect-dir .robin-xai-test
cp .env.sample .robin-xai-test/.env
npm run validate -- --connect-dir .robin-xai-test
npm start -- --connect-dir .robin-xai-test
```

Give each concurrently running Agent Instance its own Discord bot and token. Reusing one token across runtime homes is only safe when just one of them runs at a time.

### Claude

inoai runs the owner's installed `claude -p` headlessly for each Turn ([ADR 0008](docs/adr/0008-drive-claude-through-headless-cli.md)). Install Claude Code and sign in with your Claude subscription (`claude`, then `/login`), then:

```bash
npm run validate -- --connect-dir .inoai-connect-claude
cp .env.sample .inoai-connect-claude/.env
# Edit .inoai-connect-claude/.env: set AGENT_PROVIDER=claude and your local Discord values.
npm run validate -- --connect-dir .inoai-connect-claude
npm start -- --connect-dir .inoai-connect-claude
```

`CLAUDE_MODEL` is optional. Leave it blank for the CLI default, or set a model name or alias such as `sonnet`. It must start with a letter or digit and contain only letters, digits, and `. _ : - [ ]`. Other runtimes ignore it.

**Credential guard.** inoai accepts only the interactive Claude subscription login. At `npm start` it asks the CLI which credential it will use (`claude auth status`) and refuses to start, naming the source, if any of these would take over:

- an API key, such as `ANTHROPIC_API_KEY` or a Console key;
- an auth token or Anthropic profile, such as `ANTHROPIC_AUTH_TOKEN` or a token in Claude settings;
- `CLAUDE_CODE_OAUTH_TOKEN` in the environment;
- an `apiKeyHelper`;
- a cloud provider or gateway.

Each Turn checks again, and a non-subscription credential fails the Turn with a notice to run `claude /login`. inoai never reads credential files or edits your shell, settings, or credentials. To fix a refusal, unset the variable or remove the setting, run `claude /login` if needed, and restart.

**Subscription login policy.** Anthropic's [Agent SDK documentation](https://code.claude.com/docs/en/agent-sdk/overview) says that, unless previously approved, third-party developers may not offer claude.ai login or rate limits for their products. inoai offers no login: each owner runs it on their own machine against their own locally signed-in CLI, and inoai never handles a Claude credential.

### OpenCode

inoai runs the owner's installed `opencode run --format json --standalone` for each Turn and uses whatever provider and model OpenCode is configured with ([ADR 0009](docs/adr/0009-opencode-uses-its-configured-provider.md)). `opencode` must be on the PATH of the shell that runs `npm start`; the default installer puts it in `~/.opencode/bin`, which a non-interactive shell may not include.

```bash
npm run validate -- --connect-dir .inoai-connect-opencode
cp .env.sample .inoai-connect-opencode/.env
# Edit .inoai-connect-opencode/.env: set AGENT_PROVIDER=opencode and your local Discord values.
npm run validate -- --connect-dir .inoai-connect-opencode
npm start -- --connect-dir .inoai-connect-opencode
```

At `npm start`, inoai runs `opencode --version` and refuses to start with `OpenCode CLI is unavailable` if it cannot run.

- Each Turn is a standalone `opencode run` in the deployment folder. The first Turn creates the OpenCode session and later Turns resume it with `--session`; these sessions appear in OpenCode's own session list for the deployment folder.
- OpenCode (2.0.22) ignores the `instructions` config setting, so `agent.md` is sent as a delimited block at the start of every Turn's prompt.
- inoai never edits OpenCode configuration.

**Data and billing.** inoai passes no model or provider and adds no credential guard.

- With the free OpenCode Zen default, nobody is billed, but Discord prompts and project context are sent to opencode.ai.
- A provider or API key you later configure in OpenCode is used and billed as configured.
- The free tier allows use only "from within OpenCode". inoai works today because it runs the stock CLI; a future OpenCode change could refuse these runs, which shows up as the OpenCode authentication notice.

**Permissive defaults.** OpenCode's built-in rules allow shell commands and file edits, and only a few actions ask (such as file tools outside the project or reading `.env` files). With default settings a Discord message can make OpenCode run commands and change files in the deployment folder; only the asking cases are rejected. inoai keeps your configured policy and never passes `--auto`, `--yolo`, or `--dangerously-skip-permissions`. For Codex-like behavior, set shell and edit to `ask` in your own OpenCode configuration.

## Common Commands

| Command | Purpose |
|---|---|
| `npm run validate` | Create the runtime home if needed and validate its `.env` offline. |
| `npm start -- profile validate --connect-dir <home>` | Validate a runtime-home `agent.md` without starting Discord. |
| `npm start` | Start the core for the default runtime home. |
| `npm start -- --connect-dir <home>` | Start a named runtime home. `npm run validate`, `ui`, and `memory` accept the same option. |
| `npm start -- heartbeat --connect-dir .robin-xai-test` | Run the optional supervisor in the foreground with one inoai child. |
| `npm start -- heartbeat launchagent render --connect-dir .robin-xai-test` | Print the optional macOS LaunchAgent plist without installing it. |
| `npm start -- memory add "<text>"` | Add a Manual Memory Entry to local SQLite without starting an Agent Runtime. |
| `npm start -- memory list` | List active Memory with `origin` (`manual` or `review`); review-made entries also show `review_id` and `source_message_id`. |
| `npm start -- memory delete <id>` | Soft-delete a Memory entry of either origin. |
| `npm run allowlist:add -- --connect-dir .robin-xai-test --user-id <discord-user-id> --display-name "Ada"` | Add or reactivate a Discord family user for the configured guild. |
| `npm run allowlist:disable -- --connect-dir .robin-xai-test --user-id <discord-user-id>` | Disable a Discord family user without deleting its audit history. |
| `npm start -- ui` | Launch the sibling Electron UI for the selected runtime home (Phase 7 reads local SQLite). |
| `npm run postgres:migrate -- --url <url>` | Advanced: apply PostgreSQL administrator migrations. |
| `npm run postgres:provision -- <options>` | Advanced: generate PostgreSQL provisioning SQL. |
| `npm run postgres:test -- --connect-dir <home>` | Advanced: check an explicitly configured PostgreSQL connection without starting Discord. |
| `npm run postgres:integration` | Advanced: run the opt-in Docker PostgreSQL acceptance suite. |
| `npm test` | Build and run the test suite. |
| `npm run typecheck` | Type-check without emitting. |
| `/inoai status` | Show the thread's session, queue, and failure counts. |
| `/inoai cancel` | Stop the active Turn. |
| `/inoai reset` | End the session, cancel queued work, keep the archive, and start a fresh session with the next message. |
| `/inoai task create` | Create a one-time or recurring Task in a guild text channel or an existing Task thread. |
| `/inoai task list` | Show Task IDs, states, next due times, and thread links. |
| `/inoai task run`, `pause`, `resume`, `cancel` | Manage a Task by ID, or omit `id` inside its Task thread. |

The `/inoai` slash commands are owner-only and reply privately. Conversation controls work in a thread the bot owns. Task controls work in an accessible guild text channel or an existing Task thread. Creating from a Task thread places the new thread in its parent channel.

Allowlist commands use the selected runtime home's SQLite database and
never print credentials. Stop the core before running these write commands.
The configured owner cannot be changed by these commands. Inspect changes in the local SQLite `users` table with:

```sql
SELECT external_user_id, display_name, role, state
FROM users
WHERE transport = 'discord'
ORDER BY id;
```

## Tasks

The owner creates and manages Tasks with `/inoai task` commands, by asking in chat ([Tasks from chat](#tasks-from-chat)), or in the local UI ([Tasks in the UI](#tasks-in-the-ui)).

The configured owner can create a Task in any accessible guild text channel or an existing Task thread. The bot creates a dedicated thread, Conversation, and Agent Session for it. A one-time Task waits for `/inoai task run`; a recurring Task first becomes due one interval after creation. Use the slash command options shown by Discord, for example:

```text
/inoai task create goal:"Write a Markdown project summary" type:One time
/inoai task create goal:"Write a daily HTML report" type:Recurring interval:1 unit:Days
/inoai task list
/inoai task run id:1
/inoai task pause id:2
/inoai task resume id:2
/inoai task cancel id:2
```

`goal` and `type` are required. Recurring Tasks also require a positive whole-number `interval` and `unit` of Hours or Days. For `run`, `pause`, `resume`, and `cancel`, omit `id` only when using the command inside that Task's thread. `list` shows the IDs and next due times. A completed one-time Task cannot run again; create another Task for a new run.

Messages you send in a Task thread are saved as guidance for its next run. They do not start ordinary chat Turns or change a run already in progress. Each run makes one Agent Runtime iteration. Only one Task Run starts at a time per Agent Instance, and queued chat takes priority. If chat arrives during a Task Run, that run finishes before chat; chat then runs before another Task Run. A Task Run also waits for an active Memory Review to settle.

The in-process scheduler checks for due Tasks at startup and about once per minute; the external Heartbeat Supervisor remains health-only. After downtime it runs an overdue Task once, without replaying missed intervals. A failed or restart-interrupted run is recorded as failed and never retried automatically; use `run` for a manual retry. Pausing prevents new runs while letting an active run finish. For a Task created with `/inoai task create`, the next due time is one interval after a run completes or fails, and resuming restores its existing due time. A Task with a UI schedule follows the rules in [Tasks in the UI](#tasks-in-the-ui); resuming it, also with `/inoai task resume`, recalculates its next run from now. `/inoai task cancel` ends the Task and stops its active run.

For requested files, the agent is directed to write under the selected runtime home's `results/<task-id>/<run-id>/`. Each run gets a new directory, so earlier output remains. inoai posts the run summary and relative file paths in the Task thread and uploads a copy of each produced file to Discord. If an upload fails, the local file remains and the thread receives its relative path. Keep these files in your runtime-home backup plan; SQLite stores the paths and run history, not the file contents.

A completed or failed run also gets `results/<task-id>/<run-id>/result.md`, written by inoai, once its run folder exists. It holds the run times and state, the instruction, the expected output, the full answer or a safe failure reason, and the list of other files in the run folder. It stays local: inoai does not upload it to Discord. A run that fails before its run folder exists, a run failed by restart recovery, and a cancelled run have no `result.md`.

### Tasks from chat

You can also ask for a Task in an ordinary conversation with the agent, for example "every weekday at 9, check the failing CI jobs and give me a short summary". The agent replies and inoai posts a task card in the thread. Nothing is saved until you click the card (ADR 0027).

- A new-task card shows the title, instruction, expected output, schedule, next three runs, time zone, where reports go, and when the card expires. Long text is cut on the card; the full text is saved.
- **Create** saves the Task. **Cancel** discards the card. A later click creates nothing; it shows the card's state.
- To change a proposal, reply in chat. The agent posts a revised card, and the old card says "Replaced by a newer card."
- You can also ask to edit, run now, pause, resume, or cancel an existing Task, for example "pause the CI summary". The card shows the action and the Task; click **Confirm** to apply it. These follow the same rules as the UI and `/inoai task …`. Cancel ends the Task and stops a run in progress, as `/inoai task cancel` does.
- Ask "what tasks do I have". The agent answers from the list of up to 20 active and paused Tasks that inoai gives it on your turns. No card is posted.
- A card expires after 24 hours, when a newer card replaces it, when you run `/inoai reset`, or at startup if it is overdue. An expired or resolved card loses its buttons and shows its state.
- Only the owner can use these. The agent gets task instructions only on your turns in normal conversations started by a mention; messages in Task threads stay guidance notes. Other users' clicks get a private refusal and change nothing.
- Discord-created Tasks use the optional `OWNER_TIMEZONE` from the runtime home's `.env`, for example `OWNER_TIMEZONE=Asia/Singapore`. When it is blank or unset, the host time zone is used. An unknown zone fails configuration. The card always shows the zone.

Where reports go:

- **`DISCORD_TASK_CHANNEL_ID` unset:** Create opens a thread named after the title in the conversation's parent channel. The card links to it, and every run report goes there.
- **`DISCORD_TASK_CHANNEL_ID` set:** the first run opens a thread named after the title in the task channel, as for UI-created Tasks. Later reports go there.

Known limits: a card waiting to be posted is lost if inoai restarts, and its proposal waits until it expires or is replaced. A crash during Create can leave a thread without a Task; the card says the creation failed. A failed card edit is not retried, so a later click on a replaced card may say "Expired" instead of "Replaced by a newer card." A task block that the agent shows as an example inside another code block becomes a real card. `/inoai task …` remains available as a fallback.

### Tasks in the UI

Talk to the agent in Discord once before creating tasks from the UI. A UI-created Task copies its user, workspace, and agent provider from the most recent owner session; without one, the UI refuses to create a Task.

Open the local UI with `npm start -- ui` (add `--connect-dir .inoai-connect-<name>` for another runtime home), then open the Tasks drawer:

- **New task** opens a form with a title (required, up to 100 characters), an instruction (required), an optional expected output, a schedule, and a time zone. The time zone defaults to the browser's zone. A preview shows the next three runs; the server checks the schedule again when you save.
- **Edit** changes the title, instruction, expected output, and schedule of an active or paused Task. It is not available while a run is in progress.
- **Run now** makes an active Task due now; the scheduler starts it within about a minute. It counts toward the run limit. For a daily, selected-days, or weekly Task it is an extra run: the next scheduled time still runs, even a few minutes later. For an every-N-hours Task, the next run is N hours after the Run now run ends. For a once-at-a-time Task, Run now replaces the scheduled time: it is the Task's one run, and the Task then completes.
- **Pause** stops new runs; a run in progress finishes. **Resume** recalculates the next run from now. A Task created with `/inoai task create` keeps its existing due time.
- **Cancel** asks for confirmation, then stops all future runs. A run in progress finishes. Unlike `/inoai task cancel`, the UI does not stop the active run.
- Completed and cancelled Tasks are read-only. Nothing is deleted.
- Each Task shows its newest 20 runs. Select a run to read its `result.md`.

Schedule kinds, all in the Task's time zone:

| Kind | Runs |
| --- | --- |
| Once, now | At the next scheduler check. |
| Once, at a time | At the chosen time. |
| Every N hours | N whole hours (at least 1) after creation, then N hours after each run ends. |
| Daily | Every day at `HH:MM`. |
| Selected days | At `HH:MM` on the chosen weekdays. |
| Weekly | At `HH:MM` on one weekday. |

Repeating kinds accept an optional stop date ("Until") and an optional run limit. When either is reached, the Task becomes completed. Failed runs count toward the run limit, and the Task moves to its next scheduled time; a failed one-time Task ends completed. On a daylight saving change, a skipped local time runs at the first valid time after the gap, and a repeated local time runs once.

The UI writes only Tasks. It never reads `.env`, and it hides credential-shaped text. If a field shows hidden values, re-enter that text before you save an edit; the form refuses to save the hidden placeholder. Changes made while the agent is stopped take effect when it next starts. The UI does not create or upgrade the database; start the agent once first.

A UI-created Task has no Discord thread unless you set the optional `DISCORD_TASK_CHANNEL_ID` in the runtime home's `.env` to a channel ID (digits only). When it is set, the first run creates a thread named after the Task title in that channel and later run reports go there. The bot needs permission to post and create threads in it. Do not use the `DISCORD_STATUS_CHANNEL_ID` channel: inoai ignores messages in threads of the status channel, so Task thread guidance would be dropped.

A UI-created Task keeps the agent provider it copied when it was created. After any `AGENT_PROVIDER` change, its runs fail with "Task Agent Session unavailable"; talking to the agent does not fix that Task. A Task created after the change but before a new owner session exists also copies the old provider and fails the same way. To fix both cases, talk to the agent in Discord under the new provider, then create the Task again.

## Heartbeat Supervisor

The optional external supervisor starts one inoai child and checks its process,
local lock, and a bounded read-only SQLite query every 60 minutes. Normal
`npm start` behavior is unchanged. `.robin-xai-test` is the primary test
runtime. Stop its existing core or supervisor before starting another owner.

Build first, then run the supervisor in the foreground:

```sh
npm run build
npm start -- heartbeat --connect-dir .robin-xai-test
```

Use Ctrl-C to stop the supervisor and its child. Supervisor events are recorded
in `~/Library/Logs/inoai/heartbeat.log`; failures are recorded in
`~/Library/Logs/inoai/heartbeat-error.log`. Child stdout and stderr are discarded.
The child emits the normal Discord startup notice after a successful restart.

An optional user-level macOS LaunchAgent supports explicit installation and
service controls. Installation does not load the service. Login start and
KeepAlive are disabled by default. See the
[Heartbeat operations guide](INSTRUCTIONS.md) for prerequisites,
installation, manual activation, stop/unload/uninstall, failure behavior, and
isolated acceptance checks.

## Runtime Behavior

All three runtimes share the same queue, archive, and safety rules:

- Turns run FIFO per Agent Session. When a runtime proves cross-session concurrency at startup (Codex and Claude probes), different threads run in parallel; otherwise, and always for OpenCode, all Turns share one global FIFO queue.
- Only Turns proven never to have started are retried (at most three attempts in total). An uncertain outcome is recorded and you are asked for a fresh request ([ADR 0002](docs/adr/0002-retry-only-proven-safe-runtime-turns.md)).
- Permission requests fail closed with a fixed notice to use the local CLI for the blocked action ([ADR 0003](docs/adr/0003-fail-closed-on-unsafe-approval-previews.md), [ADR 0007](docs/adr/0007-claude-matches-codex-fail-closed-approvals.md)). inoai never stores the requested action; Claude and OpenCode record only a denial count.
- Each CLI's own settings, MCP servers, skills, sandbox, and permission rules apply unchanged to Turns; Memory Reviews run without them. For Claude, the CLI denies any action your settings do not already allow.
- At startup, Codex and Claude run a concurrency probe; the Claude probe makes two short, tool-free `haiku` calls that count against your subscription usage. Startup logs which mode is active.
- Sign-in and usage failures post the runtime's own fixed notice, for example to run `codex login` or `claude /login`.
- `agent.md` is sent with every Turn, so edits apply from the next Turn, including in existing threads.
- A thread bound to a different provider is not resumed; its notice offers `/inoai reset` or a new thread. A session the CLI can no longer find fails closed with a notice to run `/inoai reset`, and is never silently recreated.

## Daily Memory Review

Once a day, inoai reviews each Agent Session's Messages since that Session's last review. A review writes one Recap and may add, update, or delete Memory ([ADR 0010](docs/adr/0010-memory-reviews-run-text-only-in-throwaway-sessions.md)).

What a review keeps:

- A new Memory needs an explicit request in one of your own Messages, such as "remember that…", "please note…", or "keep this in mind", or the same pattern in at least two earlier Recaps.
- Quoted, fenced, or inline-code text and agent replies never count as your request, and secret-like text is always dropped; the model is told to leave out one-off requests. Pasted text without quotes that contains a request like "Remember to…" cannot be told apart from your own request and may still count.
- Deleting a review-made Memory needs evidence: one of your Messages in the reviewed range or at least two earlier Recaps. Replacing one needs the same evidence as a new Memory.
- Reviews never change Manual Memory Entries. inoai checks every action the model proposes and drops the ones that fail.

When it runs:

- After `MEMORY_REVIEW_TIME` (local `HH:MM`, sample `06:00`), at most once per local date, caught up at startup or after the machine wakes.
- Chat comes first. A review starts only when no chat Message is waiting or being answered, and a new chat Message interrupts it without using a retry; after five interruptions in a day it waits for the next day's run.
- A failed review is retried after 1, 2, and 4 hours, then waits for the next day's run.
- `MEMORY_REVIEW_MAX_CHARS` sets how much text the model reads at a time; long ranges are split into chronological parts.

Reviews are silent: they never post to Discord. Until the Phase 7 UI, inspect Memory with `npm start -- memory list`; Recaps (`memory_reviews`) and the non-secret `memory_review_cycle`, `memory_review_completed`, `memory_review_deferred`, and `memory_review_skipped` Events are in the runtime home's SQLite database.

Runtime support:

- **Claude** is the only runtime that reviews in V1. Each review is a throwaway, text-only `claude -p` run in a temporary folder with no tools, no MCP servers, no saved session, `--safe-mode`, and a fixed inoai system prompt, so your `CLAUDE.md`, skills, plugins, hooks, and Claude memory are not used. A run that still reports tools, MCP servers, or memory paths fails. Reviews count against your Claude subscription usage.
- **Codex** review code is present but disabled. The 2026-10-03 probe against `codex-cli 0.159.3` saw 11 MCP startup notifications (6 `starting`, 5 `ready`) in the authenticated throwaway app-server session, so it did not prove MCP-free execution. No tool request or disposable-project file change occurred, but a correct-looking answer is insufficient to enable reviews; see [ADR 0011](docs/adr/0011-codex-memory-reviews-need-tool-free-proof.md).
- **OpenCode** reviews are not supported.

Codex and OpenCode homes record a `memory_review_skipped` Event and keep their review cursors, so no Messages are marked reviewed without a review.

A review sends archived Message text, current Memory, and recent Recaps to the runtime's provider (Anthropic, for Claude homes), with secret-like lines replaced by `[redacted: secret-like text]`. inoai stores only the Recap and accepted Memory, never the prompt or the model's raw reply.

## Implementation Phases

```text
1.  Scaffolding
2.  SQLite operational archive and queue
3.  Discord transport
4.  Codex runtime
5.  End-to-end conversation worker
5a. Claude runtime
5b. OpenCode runtime
6.  Daily Memory Review
6b. Codex Memory Review verification
6c. Future PostgreSQL central reporting/backup sink
7.  Separate Electron analytics UI        (next)
8.  V1 acceptance and operational hardening
```

See [docs/implementation-phases.md](docs/implementation-phases.md). Deferred after V1: Slack and Telegram adapters; remote UI access and cross-instance Memory sharing; multi-step Task loops and calendar schedules; cross-machine backups and Windows/Linux release packages.

## Development

During development, use the ignored repository-root `.inoai-connect/` as the local runtime home. Tests must use disposable runtime homes in the system temporary directory and never touch real development data.

```bash
npm test
npm run typecheck
npm run build
```

For each phase, follow the workflow in [AGENTS.md](AGENTS.md): start a feature branch, approve the plan, split it into Trinary tasks, and use an independent worker and reviewer before integrated acceptance.

The TypeScript source is organized by capability boundary. `app/` is the
composition root; `conversation/`, `memory/`, `persistence/`, `runtime/`, and
`transport/` contain the corresponding application capabilities. Dependencies
point inward through the existing narrow seams, while the root-level modules
listed as compatibility entry points preserve existing imports during the
incremental refactor. This restructuring does not change CLI, Discord,
provider, persistence, or Memory Review behavior.

## Repository Layout

```text
inoai/
├── docs/
│   ├── adr/                                  # architecture decisions 0001–0016
│   ├── discord-codex-cli-harness-proposal.md
│   ├── implementation-phases.md
│   ├── postgres-local.md
│   ├── sqlite-schema.md                     # runtime SQLite schema reference
│   ├── archived/
│   │   └── plan-review.md
│   ├── repository-structure.md               # initial planned layout
│   └── phase-*-spike.md                      # verified CLI contracts
├── src/
│   ├── index.ts                              # thin executable launcher delegating to app/application.ts
│   ├── app/application.ts                    # CLI wiring, provider switch, Memory commands, composition root
│   ├── config.ts, runtime-home.ts            # .env validation, runtime-home bootstrap and lock
│   ├── transport/                            # Discord adapter and inbound policy
│   │   ├── discord.ts                         # Discord transport seam
│   │   ├── inbound-policy.ts                  # message authorization and routing
│   │   └── approval-relay.ts                  # fail-closed approval notices
│   ├── conversation/                         # Session, Turn, FIFO worker, prompt context
│   │   ├── conversation-worker.ts            # per-Session FIFO worker
│   │   ├── runtime-turn.ts, agent-session.ts # Turn retries, notices, session binding
│   │   └── prompt-context.ts                 # Memory context and secret filter
│   ├── runtime/                              # provider-neutral seam and adapters
│   │   ├── agent-runtime.ts                  # provider-neutral runtime seam
│   │   ├── codex-runtime.ts, codex-app-server.ts # Codex adapter
│   │   ├── claude-runtime.ts                 # Claude adapter
│   │   ├── concurrency-probe.ts              # startup concurrency probes
│   │   └── opencode-runtime.ts               # OpenCode adapter
│   ├── memory/                               # Memory Review policy, scheduling, and operations
│   │   ├── memory-review.ts                  # Daily Memory Review engine
│   │   ├── memory-review-scheduler.ts        # daily cycle and chat-first scheduling
│   │   └── memory-operations.ts              # memory persistence and query operations
│   ├── persistence/                          # SQLite operational store and advanced PostgreSQL tooling
│   │   ├── operational-store.ts, postgres.ts  # store contract and advanced PostgreSQL pool
│   │   ├── postgres-*.ts                      # lease, migration, provisioning, and connection tools
│   │   ├── sqlite-operational-store.ts        # runtime OperationalStore adapter
│   │   └── legacy-database.ts                 # SQLite schema, queries, and recovery
│   ├── memory-review.ts                      # compatibility entry point for memory-review.ts
│   ├── memory-review-scheduler.ts            # compatibility entry point for memory-review-scheduler.ts
│   ├── conversation-worker.ts, agent-session.ts,
│   │   runtime-turn.ts, prompt-context.ts     # compatibility entry points for conversation modules
│   ├── agent-runtime.ts, *-runtime.ts        # compatibility entry points for runtime modules
│   ├── transport.ts, inbound-policy.ts,
│   │   approval-relay.ts                      # compatibility entry points for transport modules
│   ├── postgres*.ts, operational-store.ts    # persistence compatibility entry points
│   ├── database.ts                           # SQLite compatibility entry point
│   ├── ui.ts                                 # Electron UI launcher
│   └── test/
├── .agents/skills/trinary-agents/            # Project-local Trinary workflow skill
├── AGENTS.md
├── CONTEXT.md
├── README.md
└── logo.svg
```
