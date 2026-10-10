# inoai

inoai connects a personal chat conversation to a locally authenticated coding-agent runtime, with durable local history, memory, and bounded background work.

## Language

**Chat Transport**:
The external messaging system that carries incoming user input and outgoing inoai responses.
_Avoid_: Channel, platform

**Conversation**:
One isolated chat context owned by a Chat Transport. In Discord v1, a Conversation is a thread.
_Avoid_: Channel, session

**User**:
An authorized person identified by a Chat Transport and workspace. V1 seeds only the owner; future family access adds active User records.
_Avoid_: Account, author

**Agent Runtime**:
The local CLI-backed system that performs agent turns for inoai.
_Avoid_: Model, bot

**Agent Instance**:
One independently configured inoai identity represented by a `.inoai-connect*` runtime home. It selects one Agent Runtime provider, one Discord bot configuration, one role-specific `agent.md`, and one agent-wide Memory/archive database.
_Avoid_: User, session, profile

**Agent Account**:
An external runtime or service identity that an Agent Instance may use, such as a provider login, Discord bot identity, or later trading connection. Account credentials and policies are distinct from an instance's role, archive, and operational state.
_Avoid_: Agent Instance, User

**Agent Session**:
The Agent Runtime's persisted context for one Conversation or Task.
_Avoid_: Conversation, thread

**Turn**:
One persisted user instruction and the Agent Runtime response it produces.
_Avoid_: Message, task

**Task**:
A bounded, durable sequence of Agent Runtime iterations created from a short user goal.
_Avoid_: Job, workflow

**Task Run**:
One Agent Runtime iteration within a Task.
_Avoid_: Turn, schedule

**Memory**:
A reviewed, durable fact or preference supplied to relevant Agent Sessions.
_Avoid_: Transcript, message log

**Memory Review**:
A low-priority distillation of one Agent Session's newly archived Messages into a Recap and Memory actions.
_Avoid_: Summary, replay

**Recap**:
A timestamped summary of one Agent Session's archived Messages since that Session's prior Recap. After a reset, the ended Session and the new Session in the same Conversation are recapped separately.
_Avoid_: Memory, transcript

**Memory Signal**:
Either an explicit user request to remember something or a useful pattern repeated across Recaps. A Memory Signal may promote information into shared agent Memory.
_Avoid_: Every fact, summary

**Knowledge**:
External or shared information made available through indexing, retrieval, and provenance-aware sources. Knowledge is distinct from agent-maintained Memory and is not promoted automatically by retrieval alone.
_Avoid_: Memory, transcript

**Manual Memory Entry**:
An important Memory item created directly through inoai's local management CLI or Electron UI, without waiting for a Recap.
_Avoid_: Chat command, transcript item

**Analytics Sink**:
An optional external store that receives a one-way, redacted copy of an Agent Instance's local history for analysis. It is never the operational source of truth.
_Avoid_: Primary database, archive

**PostgreSQL Analytics Sink**:
The optional PostgreSQL destination for shared analytics across one or more Agent Instances. It may be local, containerized, or network-hosted, but it does not own live Conversations or Tasks.
_Avoid_: Operational database, scheduler store

**Operational Database**:
The durable coordination store that owns live Agent Instance state, Conversations, Tasks, scheduling state, and recoverable work.
_Avoid_: Analytics sink, archive copy

**Agent Schema**:
A database namespace containing one Agent Instance's operational records, identified by the shared coordination model.
_Avoid_: Runtime home, database

**Runtime Home Lock**:
A local, same-machine ownership marker for one Agent Instance runtime home. It
is a `0600` JSON record with the owning PID, macOS process start time, and a
release token. Startup may reclaim it only when process identity proves it is
stale; legacy or malformed records fail closed. It is a fast startup guard and
is not the cross-machine authority.
_Avoid_: PostgreSQL lease, heartbeat

**PostgreSQL Lease**:
A database-backed ownership record for an Agent Instance that prevents duplicate
ownership across machines and is refreshed while the process is healthy. It
remains authoritative even when the local runtime-home lock is reclaimed.
_Avoid_: Runtime Home Lock, file lock

**Heartbeat Supervisor**:
An external process manager that starts one Agent Instance process, checks its
health on a fixed interval, and restarts it when the process or its ownership
state is unhealthy.
_Avoid_: Agent Runtime, Runtime Home Lock

**Capability Boundary**:
A stable area of responsibility in the inoai system, such as Conversation,
Memory, Persistence, Runtime, Transport, or Platform. A Capability Boundary
groups behavior by the concept it serves and hides implementation details from
other boundaries.
_Avoid_: Utility bucket, service layer

**Platform**:
The capability that owns environment and process integration, including
configuration, runtime-home lifecycle, instance identity, and local application
launching. Platform concerns support capabilities but do not define their
business behavior.
_Avoid_: Infrastructure bucket, composition root

**Agent Profile**:
The canonical role and behavior description for one Agent Instance, stored as
`agent.md` in its deployed runtime home. It defines identity, personality,
operating rules, safety boundaries, and references to the instance's available
capabilities.
_Avoid_: Agent Account, runtime configuration, skill

**Skill Package**:
A provider-neutral, owner-installed capability package for one Agent Instance.
It contains human-readable instructions, a machine-readable manifest, and
optional local scripts or references. A Skill Package is trusted only after its
declared capabilities and content hash are approved in the runtime home.
_Avoid_: Agent Profile, provider plugin, arbitrary tool
