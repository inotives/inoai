import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { AgentRuntime, RuntimeEvent } from "../../agent-runtime/ports.js";
import { bootstrapRuntimeHome } from "../../agent-instance/runtime-home.js";
import { start } from "../../app.js";
import { ConversationWorker, type ChatTaskOptions } from "../../conversation/conversation-worker.js";
import { TaskRunExecutor } from "../../conversation/task-run-executor.js";
import type { TaskOperationsStore } from "../../connectors/persistence/sqlite/operational-store.js";
import type { MessageRecord, OperationalStore } from "../../persistence/operational-store.js";
import type { SessionRecord, TaskProposalRecord } from "../../connectors/persistence/sqlite/legacy-database.js";

const env = ["DISCORD_BOT_TOKEN=unused", "DISCORD_GUILD_ID=guild", "DISCORD_OWNER_USER_ID=owner",
  "DISCORD_STATUS_CHANNEL_ID=status", "CHAT_PROVIDER=discord", "AGENT_PROVIDER=codex",
  "MEMORY_REVIEW_TIME=06:00", "MEMORY_REVIEW_MAX_CHARS=20000", "AGENT_INSTANCE_ID=agent-test"].join("\n");
const now = Date.parse("2026-10-23T00:00:00Z") / 1000;
const block = (value: unknown) => "```inoai-task\n" + JSON.stringify(value) + "\n```";
const create = { action: "create", title: "CI report", instruction: "Summarize failing CI", schedule: { kind: "daily", time: "09:00" } };

async function until(check: () => Promise<boolean>, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
  if (await check()) return;
  throw new Error("Condition did not become true");
}

type Fixture = {
  store: OperationalStore & TaskOperationsStore;
  ownerId: number;
  friendId: number;
  conversation: SessionRecord;
  taskSession: SessionRecord;
  taskId: number;
  prompts: Map<string, string>;
  sent: string[];
  proposals: Array<{ proposal: TaskProposalRecord; message: MessageRecord }>;
  /** Archives one user turn, runs it, and returns the agent replies, the inbound state, and the new events. */
  turn(body: string, answer: string, options?: { userId?: number; session?: SessionRecord }): Promise<{ replies: string[]; state: string; events: Array<{ event_type: string; detail: string | null }> }>;
};

async function withFixture(run: (fixture: Fixture) => Promise<void>, overrides: Partial<ChatTaskOptions> = {}): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "inoai-chat-task-"));
  try {
    await writeFile((await bootstrapRuntimeHome(directory)).envFile, env);
    const instance = await start(directory);
    try {
      const store = instance.store as OperationalStore & TaskOperationsStore;
      const friend = (await store.upsertUser({ transport: "discord", workspace_id: "guild", external_user_id: "friend",
        display_name: null, role: "family", state: "active" }))!;
      const session = (conversation: string, agentSessionId: string) => store.createSession({ user_id: instance.owner.id,
        transport: "discord", workspace_id: "guild", parent_conversation_id: "channel", conversation_id: conversation,
        initiating_external_message_id: `start-${conversation}`, agent_provider: "codex", agent_session_id: agentSessionId, project_path: directory });
      const conversation = await session("thread-a", "codex-a");
      const taskSession = await session("task-thread", "codex-task");
      const task = await store.createTask({ goal: "Old goal", title: "Weekly digest", task_type: "recurring", interval_seconds: 7200,
        conversation_id: "task-thread", session_id: taskSession.id });
      const answers = new Map<string, string>();
      const prompts = new Map<string, string>();
      const runtime: AgentRuntime = {
        displayName: "Codex", loginHint: "codex login",
        async createSession() { return "codex-new"; }, async resumeSession() {},
        async *runTurn(_id, prompt): AsyncGenerator<RuntimeEvent> {
          const key = [...answers.keys()].find((body) => prompt.includes(body))!;
          prompts.set(key, prompt);
          yield { type: "answer", text: answers.get(key)! };
        },
        async cancel() {}, health() { return { state: "ready" }; }, async close() {},
      };
      const sent: string[] = [];
      const transport = { async sendMessage(_id: string, text: string) { sent.push(text); return `sent-${sent.length}`; } };
      const proposals: Fixture["proposals"] = [];
      const worker = new ConversationWorker(store, instance.runtimeHome, runtime, "codex", () => {}, transport, {
        store, ownerUserId: instance.owner.id, ownerTimeZone: "Asia/Singapore", now: () => now,
        onProposal: (proposal, message) => { proposals.push({ proposal, message }); }, ...overrides });
      let counter = 0;
      const fixture: Fixture = {
        store, ownerId: instance.owner.id, friendId: friend.id, conversation, taskSession, taskId: task.id, prompts, sent, proposals,
        async turn(body, answer, options = {}) {
          const target = options.session ?? conversation;
          const before = (await store.listEvents()).length;
          answers.set(body, answer);
          const archived = await store.archiveMessage({ session_id: target.id, transport: "discord", workspace_id: "guild",
            external_message_id: `m-${++counter}`, external_author_id: "x", user_id: options.userId ?? instance.owner.id,
            direction: "user", body, reply_to_external_message_id: null, in_reply_to_message_id: null });
          const id = archived.message!.id;
          await worker.wake();
          await until(async () => (await store.listMessages(target.id)).find((row) => row.id === id)?.state !== "pending"
            && (await store.listMessages(target.id)).find((row) => row.id === id)?.state !== "processing");
          await worker.idle();
          const rows = await store.listMessages(target.id);
          return { replies: rows.filter((row) => row.in_reply_to_message_id === id).map((row) => row.body),
            state: rows.find((row) => row.id === id)!.state, events: (await store.listEvents()).slice(before).filter((event) => event.event_type.startsWith("task_proposal") || event.event_type === "turn_failed") };
        },
      };
      try { await run(fixture); } finally { await worker.stop(); }
    } finally { await instance.release(); }
  } finally { await rm(directory, { recursive: true, force: true }); }
}

function pendingProposals(fixture: Fixture): Promise<TaskProposalRecord[]> {
  return Promise.all([1, 2, 3, 4, 5, 6, 7, 8].map((id) => fixture.store.getTaskProposal(id)))
    .then((rows) => rows.filter((row): row is TaskProposalRecord => row?.state === "pending"));
}

test("owner turns get the Task instruction and list; a valid block creates one proposal and calls the callback", async () => {
  await withFixture(async (fixture) => {
    const result = await fixture.turn("remind me daily", `Sure, I can do that.\n${block(create)}`);
    const prompt = fixture.prompts.get("remind me daily")!;
    assert.match(prompt, /inoai-task/);
    assert.match(prompt, new RegExp(`- #${fixture.taskId} Weekly digest: every 2 hours`));
    assert.match(prompt, /Default time zone: Asia\/Singapore/);
    assert.deepEqual(result.replies, ["Sure, I can do that."]);
    assert.equal(result.state, "completed");
    await until(async () => fixture.sent.length === 1);
    assert.deepEqual(fixture.sent, ["Sure, I can do that."]);
    const pending = await pendingProposals(fixture);
    assert.equal(pending.length, 1);
    const [proposal] = pending;
    assert.deepEqual([proposal.kind, proposal.task_id, proposal.session_id, proposal.conversation_id, proposal.expires_at, proposal.created_by],
      ["create", null, fixture.conversation.id, "thread-a", now + 86400, "discord:owner"]);
    const spec = JSON.parse(proposal.spec_json!);
    assert.deepEqual([spec.title, spec.timezone, spec.schedule], ["CI report", "Asia/Singapore", { kind: "daily", time: "09:00" }]);
    assert.equal(fixture.proposals.length, 1);
    assert.equal(fixture.proposals[0].proposal.id, proposal.id);
    assert.equal(fixture.proposals[0].message.body, "remind me daily");
    assert.deepEqual(result.events.map((event) => [event.event_type, event.detail]),
      [["task_proposal_created", `proposal=${proposal.id}; kind=create; task=new`]]);
  });
});

test("block-only answers do not fail the turn and archive nothing or only the note", async () => {
  await withFixture(async (fixture) => {
    const valid = await fixture.turn("pause the digest", block({ action: "pause", task: fixture.taskId }));
    assert.deepEqual([valid.state, valid.replies], ["completed", []]);
    assert.ok(!valid.events.some((event) => event.event_type === "turn_failed"));
    assert.equal(fixture.proposals.length, 1);
    assert.deepEqual([fixture.proposals[0].proposal.kind, fixture.proposals[0].proposal.task_id, fixture.proposals[0].proposal.spec_json],
      ["pause", fixture.taskId, null]);

    const invalid = await fixture.turn("run task 99", block({ action: "run", task: 99 }));
    assert.deepEqual([invalid.state, invalid.replies], ["completed", ["Task card not created: Task #99 was not found."]]);
    assert.deepEqual(invalid.events.map((event) => [event.event_type, event.detail]),
      [["task_proposal_rejected", "reason=task_not_found; fields=task"]]);
    assert.equal(fixture.proposals.length, 1);
    await until(async () => fixture.sent.length === 1);
    assert.deepEqual(fixture.sent, ["Task card not created: Task #99 was not found."]);

    const blank = await fixture.turn("say nothing", "   ");
    assert.equal(blank.state, "failed");
    assert.ok(blank.events.some((event) => event.event_type === "turn_failed" && event.detail === "reason=empty_answer"));
  });
});

test("an invalid block adds a field-error note, creates no proposal, and never archives raw JSON", async () => {
  await withFixture(async (fixture) => {
    const result = await fixture.turn("make a task", `Here it is.\n${block({ action: "create", title: "secret-title", schedule: { kind: "daily", time: "9am" } })}`);
    assert.equal(result.replies.length, 1);
    assert.match(result.replies[0], /^Here it is\.\n\nTask card not created: instruction: Instruction is required\. schedule\.time: Time must be HH:MM/);
    assert.doesNotMatch(result.replies.join(), /inoai-task|secret-title|"action"/);
    assert.equal((await pendingProposals(fixture)).length, 0);
    assert.equal(fixture.proposals.length, 0);
    assert.deepEqual(result.events.map((event) => [event.event_type, event.detail]),
      [["task_proposal_rejected", "reason=invalid_fields; fields=instruction,schedule.time"]]);
    const malformed = await fixture.turn("broken json", `Ok.\n\`\`\`inoai-task\n{"action":"create","title":"secret-title",\n\`\`\``);
    assert.deepEqual(malformed.replies, ["Ok.\n\nTask card not created: the task block was not a valid JSON object."]);
    assert.deepEqual(malformed.events.map((event) => event.detail), ["reason=invalid_json"]);
    for (const event of [...result.events, ...malformed.events]) assert.doesNotMatch(event.detail ?? "", /[{}"]|secret-title|inoai Tasks/);
  });
});

test("non-owner turns and Task sessions get no instruction, and their blocks are dropped", async () => {
  await withFixture(async (fixture) => {
    const friend = await fixture.turn("friend asks", `Hello.\n${block(create)}`, { userId: fixture.friendId });
    assert.doesNotMatch(fixture.prompts.get("friend asks")!, /inoai-task|Current Tasks/);
    assert.deepEqual(friend.replies, ["Hello."]);
    assert.deepEqual(friend.events, []);
    const friendOnly = await fixture.turn("friend block only", block(create), { userId: fixture.friendId });
    assert.deepEqual([friendOnly.state, friendOnly.replies], ["completed", []]);
    const taskThread = await fixture.turn("owner in task session", `Noted.\n${block(create)}`, { session: fixture.taskSession });
    assert.doesNotMatch(fixture.prompts.get("owner in task session")!, /inoai-task|Current Tasks/);
    assert.deepEqual(taskThread.replies, ["Noted."]);
    assert.equal((await pendingProposals(fixture)).length, 0);
    assert.equal(fixture.proposals.length, 0);
  });
});

test("a proposal store failure adds a note and keeps the answer", async () => {
  await withFixture(async (fixture) => {
    const result = await fixture.turn("store fails", `Planned.\n${block(create)}`);
    assert.deepEqual([result.state, result.replies], ["completed", ["Planned.\n\nTask card not created: the proposal could not be saved. Please ask again."]]);
    assert.deepEqual(result.events.map((event) => event.detail), ["reason=store_failed"]);
    assert.equal(fixture.proposals.length, 0);
  }, { store: { listTasks: async () => [], createTaskProposal: async () => { throw new Error("disk full"); } } });
});

test("Task Run prompts do not include the chat Task instruction", async () => {
  const directory = await mkdtemp(join(tmpdir(), "inoai-chat-task-run-"));
  try {
    await writeFile((await bootstrapRuntimeHome(directory)).envFile, env);
    const instance = await start(directory);
    try {
      const store = instance.store as OperationalStore & TaskOperationsStore;
      const session = await store.createSession({ user_id: instance.owner.id, transport: "discord", workspace_id: "guild",
        parent_conversation_id: "channel", conversation_id: "thread", initiating_external_message_id: "starter",
        agent_provider: "codex", agent_session_id: "pending:task:thread", project_path: directory });
      const task = await store.createTask({ goal: "Make a report", task_type: "one_time", conversation_id: "thread", session_id: session.id });
      const prompts: string[] = [];
      const runtime: AgentRuntime = {
        displayName: "fake", loginHint: "none", createSession: async () => "runtime-session",
        resumeSession: async () => {}, cancel: async () => {}, health: () => ({ state: "ready" }), close: async () => {},
        async *runTurn(_id: string, prompt: string): AsyncIterable<RuntimeEvent> { prompts.push(prompt); yield { type: "answer", text: "Done" }; },
      };
      const runner = new TaskRunExecutor(store, runtime, instance.runtimeHome, { sendMessage: async () => "sent" },
        { reserveTaskRun: async () => () => {} }, "codex");
      assert.equal(await runner.start(task.id), "started");
      await until(async () => ["completed", "failed"].includes((await store.listTaskRuns(task.id))[0]?.state ?? ""));
      await runner.stop();
      assert.equal(prompts.length, 1);
      assert.doesNotMatch(prompts[0], /inoai-task|inoai Tasks/);
    } finally { await instance.release(); }
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("fence variants never reach the archive or delivered chunks", async () => {
  await withFixture(async (fixture) => {
    const quoted = `Queued.\n> ~~~~json inoai-task\n> ${JSON.stringify({ action: "pause", task: fixture.taskId })}\n> ~~~~\nThanks.`;
    const result = await fixture.turn("quoted tilde block", quoted);
    assert.deepEqual([result.state, result.replies], ["completed", ["Queued.\nThanks."]]);
    const leftover = await fixture.turn("inline block", `Will do ~~~inoai-task {"action":"run","task":${fixture.taskId}}~~~ soon.`);
    assert.deepEqual(leftover.replies, ["Task card not created: the task block was not a valid JSON object."]);
    await until(async () => fixture.sent.length === 2);
    for (const text of [...result.replies, ...leftover.replies, ...fixture.sent]) assert.doesNotMatch(text, /inoai-task|"action"|~~~/);
    assert.equal(fixture.proposals.length, 1);
    assert.equal(fixture.proposals[0].proposal.kind, "pause");
  });
});

test("a reset after the proposal is stored expires it and posts no card", async () => {
  let current: Fixture | undefined;
  const expiredSessions: number[] = [];
  await withFixture(async (fixture) => {
    current = fixture;
    const result = await fixture.turn("reset race", `Planned.\n${block(create)}`);
    assert.equal(result.state, "failed");
    assert.deepEqual(result.replies, []);
    assert.equal(fixture.proposals.length, 0);
    assert.equal((await fixture.store.getTaskProposal(1))!.state, "expired");
    assert.deepEqual(expiredSessions, [fixture.conversation.id]);
  }, { store: {
    listTasks: () => current!.store.listTasks(),
    async createTaskProposal(proposal, at, actor) {
      const created = await current!.store.createTaskProposal(proposal, at, actor);
      await current!.store.resetSession(proposal.session_id, "user:owner");
      return created;
    },
    async expireSessionTaskProposals(sessionId, at, actor) {
      expiredSessions.push(sessionId);
      return current!.store.expireSessionTaskProposals(sessionId, at, actor);
    },
  } });
});
