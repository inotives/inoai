# Future phase: guided Agent Instance deployment

## Intent

Reduce deployment of an Agent Instance such as Robin to a short, guided flow.
The current setup requires users to create a runtime home, copy and edit `.env`,
validate configuration, and start the process manually. A future deployment
wizard should keep the same safe runtime-home model while collecting the needed
choices interactively.

This is a discussion proposal, not an implementation commitment or a numbered
implementation phase yet.

## Proposed user experience

### 1. Install inoai

For a normal user:

```bash
npx inoai
```

For development:

```bash
git clone <inoai-repository>
cd ino-ai
npm install
```

The published package and repository checkout should expose the same deployment
commands where practical.

### 2. Run guided deployment

```bash
inoai deploy
```

The wizard should:

1. Ask for an Agent Instance name, for example `robin`.
2. Ask which Chat Transport to configure. Discord is the first supported choice.
3. Ask which Agent Runtime provider to use: Codex, Claude, OpenCode, or another
   provider only when its adapter is actually available.
4. Check that the selected local CLI is installed and authenticated.
5. Collect transport configuration and verify the required permissions.
6. Create the dedicated runtime home and initialize its local SQLite database.
7. Create or confirm the Agent Profile (`agent.md`).
8. Run offline validation and show the resulting paths and start command.

### 3. Start the Agent Instance

```bash
inoai start robin
```

The command must acquire the runtime-home lock and refuse to start a second core
against the same Agent Instance.

## Discord setup contract

The wizard should explain the difference between a Discord bot ID and a bot
token. The bot ID is useful for identification, but the token is required for
the gateway connection and must remain in the ignored runtime-home `.env`.

The minimum Discord setup is:

- bot token;
- guild/server ID;
- owner user ID;
- status channel ID; and
- permission checks for reading and sending messages, receiving messages, and
  creating threads in the intended conversation channels.

The wizard should not print the token, persist it in SQLite, or include it in
diagnostic output. A future browser-assisted Discord setup may help create or
inspect a bot, but the first wizard can require the user to bring an existing
bot token.

## Agent Runtime selection

Provider selection should be based on supported adapters and local capability
checks, not a free-form string alone.

- Codex: verify the local Codex CLI and the owner's ChatGPT sign-in.
- Claude: verify the local Claude CLI and the owner's Claude subscription login.
- OpenCode: verify the local OpenCode CLI and its configured provider.
- Pi or other runtimes: show them only after a corresponding Agent Runtime
  adapter, validation path, and safety behavior exist.

Each Agent Instance selects exactly one provider. Changing providers later
should require an explicit configuration change and normally a new Conversation
or reset, because persisted Agent Sessions are provider-specific.

## Generated deployment

For `robin`, the wizard should create a dedicated runtime home such as:

```text
.robin/
├── .env
├── agent.md
├── inoai.sqlite
└── inoai.lock             # present while running
```

The runtime home remains local and ignored by Git. SQLite is the operational
source of truth. PostgreSQL sync, if added later, remains an optional one-way
analytics/backup concern and is not part of the initial deployment wizard.

## Proposed command surface

```text
inoai deploy                 # interactive provisioning
inoai validate --agent robin # validate an existing deployment
inoai start robin            # start one Agent Instance
inoai stop robin             # stop it
inoai status robin           # inspect lock and health state
```

The exact command names are open for discussion. The important boundary is that
provisioning, validation, and process control are separate operations even when
the wizard invokes them in sequence.

## Safety and failure behavior

- Do not create a partially usable deployment after failed validation unless the
  wizard clearly marks it incomplete and supports safe retry.
- Never overwrite an existing runtime home or `.env` without an explicit choice.
- Never reuse one Discord bot identity for two concurrently running Agent
  Instances.
- Keep provider credentials in their existing local CLI stores; the wizard
  should verify them but not copy or modify them.
- Keep Discord tokens only in the ignored runtime-home environment.
- Keep one local SQLite database per Agent Instance.
- Make rerunning deployment idempotent: validate or repair an existing home
  without destroying its archive.

## Acceptance outline for the future phase

The phase is successful when a new user can:

1. install inoai;
2. run one interactive deployment command;
3. select Discord and an available Agent Runtime;
4. provide or confirm the required Discord values;
5. pass local CLI and configuration checks; and
6. start a working Agent Instance without manually editing generated files.

The wizard must also fail clearly for missing credentials, unsupported
providers, invalid Discord identifiers, insufficient permissions, an occupied
runtime home, and an unauthenticated local CLI.

## Questions to resolve during phase planning

- Should `npx inoai` start the wizard directly, or should it only install and
  expose `inoai deploy`?
- Should the wizard create a new Discord application/bot, or initially require
  a pre-created bot token?
- Should runtime homes use friendly names such as `.robin/`, generated IDs, or
  the existing `.inoai-connect*` naming convention?
- Should the wizard configure the Agent Profile interactively, or create a
  safe default and leave profile editing as a separate step?
- Should heartbeat supervision be offered as an optional post-deployment step?
- Which providers are supported in the first version of the wizard, and what
  exact authentication check is required for each one?
