# inoai instructions

This guide covers setup, commands, and operations for inoai. For an overview,
see [README.md](README.md). For the architecture and folder layout, see
[docs/repository-structure.md](docs/repository-structure.md).

## Contents

- [Standalone macOS CLI](#standalone-macos-cli)
- [Dependencies](#dependencies)
- [Installation](#installation)
  - [Local database](#local-database)
- [Setup](#setup)
  - [Codex (default runtime home)](#codex-default-runtime-home)
  - [Agent profile](#agent-profile)
  - [Skills](#skills)
  - [Claude](#claude)
  - [OpenCode](#opencode)
- [Common Commands](#common-commands)
- [Tasks](#tasks)
  - [Tasks from chat](#tasks-from-chat)
  - [Tasks in the UI](#tasks-in-the-ui)
- [Heartbeat Supervisor](#heartbeat-supervisor)
  - [Prepare and test in the foreground](#prepare-and-test-in-the-foreground)
  - [Active setup: one-command service deployment](#active-setup-one-command-service-deployment)
  - [Logs and failure behavior](#logs-and-failure-behavior)
  - [Low-level LaunchAgent controls](#low-level-launchagent-controls)
  - [Service controls](#service-controls)
  - [Isolated acceptance checks](#isolated-acceptance-checks)
- [Runtime Behavior](#runtime-behavior)
- [Daily Memory Review](#daily-memory-review)
- [Upgrading agent CLIs](#upgrading-agent-clis)
- [Development](#development)

## Dependencies

```text
Node.js 22.23.4+, 24.22.1+, or 26.12.1+ for source builds (not needed for the standalone CLI)
macOS (V1 release target)
A Discord bot per concurrently running Agent Instance
One signed-in agent CLI per runtime home: codex, claude, or opencode
```

## Standalone macOS CLI

The standalone executable targets Apple Silicon Macs. It includes the inoai
runtime, web UI and skills installer; it does not need Node, npm, or a source
checkout at runtime. Install and sign in to the provider CLI you want to use
(Codex, Claude, or OpenCode) before setup. Create a Discord bot and obtain its
token, server ID, owner user ID and status channel ID. Use a different bot
for each concurrently running agent.

Build the executable on an Apple Silicon Mac with Node.js 22.23.4+, 24.22.1+,
or 26.12.1+. The executable embeds the Node that builds it, so the build
refuses an unpatched Node. `npm install` also refuses it (`.npmrc` sets
`engine-strict=true`):

```bash
npm install
npm run build:standalone
```

The executable is `dist/standalone/inoai`. Copy it to a directory on your
`PATH`, or invoke it by its full path. The build uses an ad-hoc signature, not
an Apple Developer signature or notarization. A downloaded copy may require
you to allow it in macOS Privacy & Security settings.

Third-party license notices are embedded in the executable. Run
`inoai --licenses` to view them; the build also writes
`dist/standalone/THIRD_PARTY_NOTICES.txt`. If the Node installation does not
include its `LICENSE` file beside the installation root, set
`INOAI_NODE_LICENSE` to that version's full Node license file when building.

Create an agent and follow the prompts:

```bash
inoai setup
inoai start --dir /path/to/agent --port 1133
```

Setup asks for a new agent data folder and a separate existing working folder.
It checks that the chosen provider executable exists, but does not check its
login state. The bot token is hidden as you type and stored in the agent's
private `.env` file. Edit `agent.md` in the agent folder to customize the
starter profile. Setup never overwrites an existing agent folder.

The start command runs the agent and its UI in the foreground. It prints the UI
address; press Ctrl+C to stop both. The default UI port is 8989 and access is
limited to the Mac. To allow the UI on a private network, specify an address:

```bash
inoai start --dir /path/to/agent --port 1133 --host 192.168.1.10
```

LAN mode has no password: devices that can reach the UI can read its data and
change Tasks. Use a private LAN address assigned to this Mac.

New agents have no installed skills. Add and enable skills separately:

```bash
inoai skills add https://github.com/owner/repository --skill skill-name --dir /path/to/agent
inoai skills list --dir /path/to/agent
inoai skills enable skill-name --dir /path/to/agent
inoai memory list --dir /path/to/agent
```

Remote Git repository skills require Git on `PATH`. If it is missing, install
the macOS Command Line Tools with `xcode-select --install`. You do not need
Node or npm for skill installation. Review each skill before enabling it.

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

Give each concurrently running Agent Instance its own Discord bot and token. Reusing one token across runtime homes is only safe when just one of them runs at a time.

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

### Agent profile

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

### Skills

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
| `npm start -- ui` | Serve the UI for the selected runtime home on `127.0.0.1`, port 8989 by default. `--port` selects another port; `--host` can select one private LAN IPv4 address. |
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
never print credentials. They can run while the core is running (ADR 0025). A
write waits up to 5 seconds for SQLite; if it reports a retryable busy error,
run the command again. Changes apply to later authorization checks.
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

The UI server listens on `127.0.0.1` by default. Every request needs a `Host` header of `127.0.0.1:<port>` or `localhost:<port>`, with the port included; any other Host gets 403 on every path. To serve one private LAN interface, run `npm start -- ui --connect-dir .inoai-connect-robin --port 1133 --host 192.168.50.120` and open `http://192.168.50.120:1133` from a device on that LAN. Replace the address if this machine's LAN address changes. `--host` rejects wildcard, public, and hostname values. On a LAN bind, only `<selected-address>:<port>` is accepted as `Host`. The page `/` accepts GET and HEAD, and `/api/ui-data` accepts GET; other methods get 405. Unknown paths get 404. Task writes pass further checks (ADR 0026).

LAN mode has no password or TLS. Any device that can reach the selected address and port can read UI data and use the page's Task write token to change Tasks. Use it only on a trusted LAN. The token and same-origin checks block cross-site writes, not another LAN visitor.

The UI writes only Tasks. It never reads `.env`, and it hides credential-shaped text. If a field shows hidden values, re-enter that text before you save an edit; the form refuses to save the hidden placeholder. Changes made while the agent is stopped take effect when it next starts. The UI does not create or upgrade the database; start the agent once first.

A UI-created Task has no Discord thread unless you set the optional `DISCORD_TASK_CHANNEL_ID` in the runtime home's `.env` to a channel ID (digits only). When it is set, the first run creates a thread named after the Task title in that channel and later run reports go there. The bot needs permission to post and create threads in it. Do not use the `DISCORD_STATUS_CHANNEL_ID` channel: inoai ignores messages in threads of the status channel, so Task thread guidance would be dropped.

A UI-created Task keeps the agent provider it copied when it was created. After any `AGENT_PROVIDER` change, its runs fail with "Task Agent Session unavailable"; talking to the agent does not fix that Task. A Task created after the change but before a new owner session exists also copies the old provider and fails the same way. To fix both cases, talk to the agent in Discord under the new provider, then create the Task again.

## Heartbeat Supervisor

The supervisor is optional. It starts one inoai child and checks its process,
local lock, and a bounded read-only SQLite query every 60 minutes. It applies
the policy in [ADR 0019](docs/adr/0019-external-heartbeat-supervisor.md).
Normal core startup stays unchanged. The primary test runtime is
`.robin-xai-test`. Foreground execution accepts `--connect-dir`; without it, it
selects `.inoai-connect`. LaunchAgent commands default to `.robin-xai-test`.

### Prepare and test in the foreground

Run commands from the selected checkout. Use Node.js 22.23.4+, 24.22.1+,
or 26.12.1+ on macOS.
Build the checkout and configure the selected runtime home with a valid `.env`
and `agent.md`. The child opens or creates its local `inoai.sqlite`; no PostgreSQL
service, provisioning, or Docker step is required. The child also
needs its configured Discord bot and authenticated agent CLI.

Stop any existing core or supervisor for this runtime home before starting
another. Unload an existing LaunchAgent before foreground testing. The local
runtime-home lock rejects a second core writer. Do not share a runtime home
between machines. UI and read-only tools may inspect SQLite. The UI writes only
Tasks (ADR 0026), and the live maintenance commands may write while the core
runs (ADR 0025); stop the core before running other local write commands. A
second supervisor can still start and retry rejected children, so use only one
supervisor.

```sh
npm run build
npm run validate -- --connect-dir .robin-xai-test
npm start -- heartbeat --connect-dir .robin-xai-test
```

The supervisor starts the compiled child directly with Node, without a shell.
The first health check runs 60 minutes after child launch. Checks do not send
Discord requests; the child sends its normal startup notice, also after a
successful restart. Use Ctrl-C or SIGTERM to stop the supervisor and child.
Stop waits for confirmed child exit.

### Active setup: one-command service deployment

The foreground workflow is useful for diagnostics but is not a suitable normal
deployment flow. An operator should not need to keep a terminal open, identify
stale locks, or manually coordinate a core process and a supervisor. A stale
lock is safe to reclaim only after the recorded owner is proven dead; database
files and WAL/SHM files must never be removed as part of this recovery.

Use the active setup command for normal background deployment:

```sh
npm start -- heartbeat setup --connect-dir .robin-xai-test
```

`--connect-dir` is required. Setup never selects a default runtime home. It
does not build source code or install dependencies, so run `npm run build`
before setup and ensure that `dist/index.js` exists.

Setup performs these actions in order:

1. Validate macOS, the compiled entrypoint, the selected runtime home, and its
   lock ownership before changing service state.
2. Render a target-specific plist with `RunAtLoad` and `KeepAlive` enabled. The
   plist captures the setup process's `PATH` so user-installed agent CLIs remain
   available when launchd starts the service.
3. Reuse an unchanged healthy service without a restart. For configuration
   drift, stop and unload only the known target service, then replace its plist
   atomically.
4. Load and kickstart the target service.
5. Verify the service, supervisor, child, and child-owned runtime lock within
   10 seconds. Setup does not wait for the hourly health check or Discord
   readiness.

The command is safe to repeat. It does not create duplicate services. If
activation or verification fails, setup restores the previous plist and loaded
service state, or removes the new service when no previous service existed. It
retains local diagnostics and does not leave a failed `KeepAlive` retry loop.

Lock safety remains strict. Setup may stop and unload only its exact target. It
must not kill an independently running core. Startup may reclaim only a lock
whose recorded owner is proven dead. Missing or proven stale locks follow
normal startup recovery. Live, malformed, foreign, or unverifiable locks fail
closed and are never deleted. Never remove the SQLite database or its WAL/SHM
files to recover from a lock or health failure.

Setup prints sanitized human-readable status. It does not print credentials,
lock contents, child output, environment values, or full local paths. The
existing `render`, `install`, `status`, `stop`, `unload`, and `uninstall`
commands remain available for advanced diagnostics and manual control.

### Logs and failure behavior

Supervisor events are recorded in `~/Library/Logs/inoai/heartbeat.log`;
failures are recorded in `~/Library/Logs/inoai/heartbeat-error.log`.

```sh
tail -f ~/Library/Logs/inoai/heartbeat.log ~/Library/Logs/inoai/heartbeat-error.log
```

Supervisor records contain timestamps and fixed event names. They exclude raw
driver errors, credentials, environment values, and child output. Child stdout
and stderr are discarded. The LaunchAgent uses these same files for supervisor
stdout and stderr. No log rotation is supplied.

| Condition | Behavior |
| --- | --- |
| Live child, matching local lock, successful read-only SQLite query | Record `healthy` and check again after 60 minutes. |
| One SQLite probe failure | Record `degraded` and keep the child. A healthy check resets the failure count. |
| Two consecutive SQLite probe failures | Record `restart`, stop the child, and start a replacement. Each database probe has a five-second deadline. |
| Proven stale local lock or dead child detected by a health check | Recover without waiting for a second failed check. Startup reclaims only a proven stale lock. |
| Child exit or spawn failure | Retry after ten seconds. Allow three replacement attempts in a rolling five-minute window, then record `retry-limit` and exit with code 1. |
| Missing, malformed, foreign, or unverifiable lock; unverifiable child | Record `health-blocked`, stop the child, and exit with code 1. Do not delete the lock. |
| Child does not exit after SIGTERM | Send SIGKILL after ten seconds. Wait for confirmed exit before any replacement. |

The hourly check cannot prove Discord or agent-provider readiness. The SQLite
probe opens the selected home's `inoai.sqlite` read-only in a worker and queries
`sqlite_schema`. It never creates, migrates, recovers, or writes the database.
Its five-second deadline cancels the worker. SQLite WAL/SHM files are normal
artifacts and are not stale-lock evidence. If SIGKILL produces no exit event,
the supervisor retains ownership and waits.

For `health-blocked`, inspect local lock ownership before any manual action.
For SQLite probe failures, check the selected home's database file, file
permissions, and disk availability. Do not delete the database or its WAL/SHM
files to clear a health failure. For repeated child exits,
unload the service, then run the normal core in the foreground to obtain its
safe startup diagnostics. Do not remove a lock while its owner can still run.

### Low-level LaunchAgent controls

These commands are explicit low-level controls. `heartbeat setup` is the
active deployment path above. Automated acceptance must not install or enable
the real service.

```sh
npm start -- heartbeat launchagent render --connect-dir .robin-xai-test
npm start -- heartbeat launchagent install --connect-dir .robin-xai-test
npm start -- heartbeat launchagent status --connect-dir .robin-xai-test
```

`render` prints XML without writing files or initializing runtime data.
`install` writes a user plist under `~/Library/LaunchAgents/`, creates the log
directory, and reports the resolved paths. It does not call `launchctl` or load
the service. `RunAtLoad` and `KeepAlive` both default to false. The plist uses
the current Node executable, checkout `dist/index.js`, checkout working
directory, runtime-home name, and user log paths. Its label has the form
`com.inoai.heartbeat.<hash>`; the hash identifies the absolute runtime-home path.
Reinstalling the same target replaces its plist.

To opt into login start or automatic supervisor recovery, pass `--run-at-load`
or `--keep-alive` to `render` or `install`. Unload an already loaded service
before reinstalling with changed options. Installation alone does not update a
loaded service. The supervisor bounds child retries; with KeepAlive enabled,
launchd can restart a failed supervisor under its own throttling.

For manual activation, copy the exact plist path and Label from the installed
plist. Set these shell variables to those values, then load and start it:

```sh
heartbeat_plist='<installed-plist-path>'
heartbeat_label='<Label-from-plist>'
launchctl bootstrap "gui/$(id -u)" "$heartbeat_plist"
launchctl kickstart "gui/$(id -u)/$heartbeat_label"
```

Do this only after the foreground test succeeds and its supervisor has stopped.
When the checkout or Node executable moves, unload and uninstall from the old
checkout first, then build and install from the new checkout. Commands compute
the target from the current checkout and runtime home.

### Service controls

```sh
npm start -- heartbeat launchagent status --connect-dir .robin-xai-test
npm start -- heartbeat launchagent stop --connect-dir .robin-xai-test
npm start -- heartbeat launchagent unload --connect-dir .robin-xai-test
npm start -- heartbeat launchagent uninstall --connect-dir .robin-xai-test
```

`status` reports whether the installed service is loaded; it does not prove
child health. `stop` sends SIGTERM to the supervisor and leaves the service
loaded. KeepAlive can restart it. Use `unload` to remove the service from the
launchd domain and prevent that restart. `uninstall` unloads a loaded service
and removes only its plist. Runtime data and logs remain. Missing plists and
installed but unloaded services are safe. A control failure preserves the plist.

### Isolated acceptance checks

Do not read or change repository-root `.inoai-connect*` data in automated tests.
Use temporary deployment and user-home directories. Tests inject clocks,
processes, and service controls; they do not write the real LaunchAgents folder.

```sh
npm run typecheck
npm run build
node --test dist/inoai/test/heartbeat/*.test.js dist/inoai/test/agent-instance/runtime-home.test.js dist/inoai/test/connectors/sqlite/sqlite-operational-store.test.js
npm test
git diff --check
```

A temporary rendered plist can be checked
with `plutil -lint`. A short isolated foreground smoke test can verify a real
child start and SIGTERM shutdown with an injected temporary logger and fixture
configuration. It does not establish live database, Discord, or hourly recovery
acceptance. Record those limits and any environment-gated skips in the handoff.

## Runtime Behavior

All three runtimes share the same queue, archive, and safety rules:

- Turns run FIFO per Agent Session. When a runtime proves cross-session concurrency at startup (Codex and Claude probes), different threads run in parallel; otherwise, and always for OpenCode, all Turns share one global FIFO queue.
- Only Turns proven never to have started are retried (at most three attempts in total). An uncertain outcome is recorded and you are asked for a fresh request ([ADR 0002](docs/adr/0002-retry-only-proven-safe-runtime-turns.md)).
- A supported Codex command request shows its complete command and working directory in an owner-only Discord card. **Approve** accepts that one live request; **Reject** declines it. The card expires after 15 minutes. Missing, unsafe, network-specific, or broader permission requests still fail closed with a fixed notice to use local Codex ([ADR 0003](docs/adr/0003-fail-closed-on-unsafe-approval-previews.md)). SQLite stores a fixed summary and outcome, not the command or working directory. Claude and OpenCode prompts still fail closed and record only a denial count ([ADR 0007](docs/adr/0007-claude-matches-codex-fail-closed-approvals.md)).
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

Reviews are silent: they never post to Discord. Inspect Memory in the local UI or with `npm start -- memory list`; Recaps (`memory_reviews`) and the non-secret `memory_review_cycle`, `memory_review_completed`, `memory_review_deferred`, and `memory_review_skipped` Events are in the runtime home's SQLite database.

Runtime support:

- **Claude** is the only runtime that reviews in V1. Each review is a throwaway, text-only `claude -p` run in a temporary folder with no tools, no MCP servers, no saved session, `--safe-mode`, and a fixed inoai system prompt, so your `CLAUDE.md`, skills, plugins, hooks, and Claude memory are not used. A run that still reports tools, MCP servers, or memory paths fails. Reviews count against your Claude subscription usage.
- **Codex** review code is present but disabled. The 2026-10-03 probe against `codex-cli 0.159.3` saw 11 MCP startup notifications (6 `starting`, 5 `ready`) in the authenticated throwaway app-server session, so it did not prove MCP-free execution. No tool request or disposable-project file change occurred, but a correct-looking answer is insufficient to enable reviews; see [ADR 0011](docs/adr/0011-codex-memory-reviews-need-tool-free-proof.md).
- **OpenCode** reviews are not supported.

Codex and OpenCode homes record a `memory_review_skipped` Event and keep their review cursors, so no Messages are marked reviewed without a review.

A review sends archived Message text, current Memory, and recent Recaps to the runtime's provider (Anthropic, for Claude homes), with secret-like lines replaced by `[redacted: secret-like text]`. inoai stores only the Recap and accepted Memory, never the prompt or the model's raw reply.

## Upgrading agent CLIs

Token and cost numbers depend on what each CLI reports. The adapters in `src/inoai/connectors/agent-runtime/` map them to one shared meaning. When a CLI version changes, recheck these points against a real Turn before you trust the numbers:

- **Claude** (`claude-runtime.ts`): the `result` event's `usage`. Input must still be `input_tokens` + `cache_creation_input_tokens`, with `cache_read_input_tokens` reported apart as cached input. `total_cost_usd` must still be cumulative for a resumed session; inoai keeps it only for a Turn that starts a new session.
- **Codex** (`codex-runtime.ts`): the `thread/tokenUsage/updated` notice. `total` must still be the thread's running total and `last` the last model call, so each new total equals the previous total plus `last`. `inputTokens` must still include `cachedInputTokens`, and `outputTokens` must include `reasoningOutputTokens`.
- **OpenCode** (`opencode-runtime.ts`): undocumented internals. Each `step_finish` event of `opencode run --format json --standalone` must still carry that step's own `tokens` and `cost`, with input excluding cache reads and writes and output excluding reasoning. Also recheck `--standalone` and the `opencode api --standalone GET /api/session/<id>` session check.

After a check, run `npm test` and update the versions below. Usage mapping last verified with:

| CLI | Usage mapping verified | Installed on 2026-10-24 |
| --- | --- | --- |
| Claude Code | 2.1.309 | 2.1.310 (not rechecked) |
| Codex CLI | 0.163.0 | 0.163.0 |
| OpenCode | 2.0.26 | 2.0.26 |

## Development

During development, use the ignored repository-root `.inoai-connect/` as the local runtime home. Tests must use disposable runtime homes in the system temporary directory and never touch real development data.

```bash
npm test
npm run typecheck
npm run build
```

For each phase, follow the workflow in [AGENTS.md](AGENTS.md): start a feature branch, approve the plan, split it into Trinary tasks, and use an independent worker and reviewer before integrated acceptance.

For the source layout and module boundaries, see
[docs/repository-structure.md](docs/repository-structure.md).
