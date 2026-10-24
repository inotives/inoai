import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { AgentRuntime, RuntimeEvent } from "../../agent-runtime/ports.js";
import { bootstrapRuntimeHome } from "../../agent-instance/runtime-home.js";
import { run, start, startTransport } from "../../app.js";
import { stat } from "node:fs/promises";
import { ConversationWorker } from "../../conversation/conversation-worker.js";
import { TaskProposalCards, type TaskCardStore } from "../../conversation/task-proposal-cards.js";
import { TaskRunExecutor } from "../../conversation/task-run-executor.js";
import { TaskScheduler } from "../../conversation/task-scheduler.js";
import type { TaskOperationsStore } from "../../connectors/persistence/sqlite/operational-store.js";
import type { SchedulerClock } from "../../memory/memory-review-scheduler.js";
import type { OperationalStore } from "../../persistence/operational-store.js";
import type { IncomingMessage, MessageButton } from "../../transport/ports.js";
import { FakeTransport } from "./fake-transport.js";

const env = ["DISCORD_BOT_TOKEN=unused", "DISCORD_GUILD_ID=guild", "DISCORD_OWNER_USER_ID=owner",
  "DISCORD_STATUS_CHANNEL_ID=status", "CHAT_PROVIDER=discord", "AGENT_PROVIDER=codex",
  "MEMORY_REVIEW_TIME=06:00", "MEMORY_REVIEW_MAX_CHARS=20000", "AGENT_INSTANCE_ID=agent-test"].join("\n");
const block = (value: unknown) => "```inoai-task\n" + JSON.stringify(value) + "\n```";
const create = { action: "create", title: "CI report", instruction: "Summarize failing CI", expectedOutput: "Short list",
  schedule: { kind: "daily", time: "09:00" } };

async function until(check: () => boolean | Promise<boolean>, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
  if (await check()) return;
  throw new Error("Condition did not become true");
}

type Card = { id: string; conversationId: string; proposalId: number; text: string; buttons: MessageButton[] };
type Harness = {
  directory: string;
  store: OperationalStore & TaskOperationsStore;
  transport: FakeTransport;
  cards: TaskProposalCards;
  runner: TaskRunExecutor;
  ownerId: number;
  clock: SchedulerClock & { seconds: number; intervals: Array<() => void> };
  /** Sends an owner message (top level when no conversation is given); the fake agent replies with `answer`. */
  send(body: string, answer: string, conversationId?: string): void;
  /** Sends an owner message and waits for the new card. */
  ask(body: string, answer: string, conversationId?: string): Promise<Card>;
  click(card: Card, action: "create" | "cancel", overrides?: Parameters<FakeTransport["click"]>[2]): ReturnType<FakeTransport["click"]>;
  lastEdit(messageId: string): { text: string; buttons: MessageButton[] } | undefined;
  close(): Promise<void>;
};

type HarnessOptions = { taskChannelId?: string; cardStore?: (store: TaskCardStore, cards: () => TaskProposalCards) => TaskCardStore };

async function openHarness(directory: string, options: HarnessOptions = {}): Promise<Harness> {
  const instance = await start(directory);
  const store = instance.store as OperationalStore & TaskOperationsStore;
  const transport = new FakeTransport();
  const answers = new Map<string, string>();
  let agentSessions = 0;
  const runtime: AgentRuntime = {
    displayName: "Codex", loginHint: "codex login",
    async createSession() { return `codex-${++agentSessions}`; }, async resumeSession() {},
    async *runTurn(_id, prompt): AsyncGenerator<RuntimeEvent> {
      if (prompt.includes("This is one Task Run")) { yield { type: "answer", text: "Report ready" }; return; }
      const key = [...answers.keys()].find((body) => prompt.includes(body));
      yield { type: "answer", text: key ? answers.get(key)! : "ok" };
    },
    async cancel() {}, health() { return { state: "ready" }; }, async close() {},
  };
  const clock = {
    seconds: Math.floor(Date.now() / 1000),
    intervals: [] as Array<() => void>,
    now() { return new Date(clock.seconds * 1000); },
    setInterval(callback: () => void) { clock.intervals.push(callback); return clock.intervals.length; },
    clearInterval() {},
  };
  let cards: TaskProposalCards | undefined;
  const worker = new ConversationWorker(store, instance.runtimeHome, runtime, "codex", () => {}, transport, {
    store, ownerUserId: instance.owner.id, ownerTimeZone: "Asia/Singapore", now: () => clock.seconds,
    onProposal: (proposal) => cards?.deliver(proposal) });
  const runner = new TaskRunExecutor(store, runtime, instance.runtimeHome, transport, worker, "codex",
    { now: () => clock.seconds, taskChannelId: options.taskChannelId });
  cards = new TaskProposalCards(options.cardStore?.(store, () => cards!) ?? store, transport, { ownerUserId: instance.owner.id, agentProvider: "codex",
    projectPath: directory, taskChannelId: options.taskChannelId, taskRunner: runner, clock });
  await startTransport(instance, undefined, transport, undefined, worker, undefined, runner, cards);
  cards.start();
  let counter = 0;
  const harness: Harness = {
    directory, store, transport, cards, runner, ownerId: instance.owner.id, clock,
    send(body, answer, conversationId) {
      answers.set(body, answer);
      const message: IncomingMessage = { transport: "discord", workspaceId: "guild", conversationId: conversationId ?? "channel",
        parentConversationId: conversationId ? "channel" : null, externalMessageId: `m-${++counter}`, externalUserId: "owner", body,
        replyToExternalMessageId: null, mentionedUserIds: conversationId ? [] : ["inoai"], mentionedBotUserIds: conversationId ? [] : ["inoai"],
        botUserId: "inoai", authorIsBot: false };
      transport.emit(message);
    },
    async ask(body, answer, conversationId) {
      const before = transport.messages.length;
      harness.send(body, answer, conversationId);
      const card = () => transport.messages.slice(before).find((sent) => (transport.buttons.get(sent.id)?.length ?? 0) > 0);
      await until(() => card() !== undefined);
      const found = card()!;
      const buttons = transport.buttons.get(found.id)!;
      return { id: found.id, conversationId: found.conversationId, text: found.text, buttons,
        proposalId: Number(/^inoai:proposal:(\d+):create$/.exec(buttons[0]!.customId)![1]) };
    },
    click(card, action, overrides = {}) {
      return transport.click(card.id, `inoai:proposal:${card.proposalId}:${action}`, { conversationId: card.conversationId, ...overrides });
    },
    lastEdit(messageId) {
      const edit = transport.edits.filter((row) => row.messageId === messageId).at(-1);
      return edit && { text: edit.text, buttons: edit.buttons };
    },
    async close() {
      await cards!.stop();
      await runner.stop();
      await worker.stop();
      await instance.release();
    },
  };
  return harness;
}

async function withHarness(run: (harness: Harness) => Promise<void>, options: HarnessOptions = {}): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "inoai-task-cards-"));
  try {
    await writeFile((await bootstrapRuntimeHome(directory)).envFile, env);
    const harness = await openHarness(directory, options);
    try { await run(harness); } finally { await harness.close(); }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function proposalEvents(store: OperationalStore): Promise<string[]> {
  return (await store.listEvents()).filter((event) => event.event_type.startsWith("task_proposal_"))
    .map((event) => `${event.event_type} ${event.detail}`);
}

test("an owner message yields a card after its answer; Create makes one task, session, and thread once", async () => {
  await withHarness(async (h) => {
    const card = await h.ask("check CI every morning", `Sure, I can do that.\n${block(create)}`);
    assert.equal(card.conversationId, "thread-1");
    const thread = h.transport.messages.filter((sent) => sent.conversationId === "thread-1").map((sent) => sent.text);
    assert.deepEqual(thread, ["Sure, I can do that.", card.text]);
    for (const line of ["**New task**", "Title: CI report", "Instruction: Summarize failing CI", "Expected output: Short list",
      "Schedule: daily at 09:00 (Asia/Singapore)", "Time zone: Asia/Singapore", "Reports: a new thread named after the title"]) {
      assert.ok(card.text.includes(line), `card is missing ${line}`);
    }
    assert.equal(/Next runs: (.+)/.exec(card.text)![1]!.split("; ").length, 3);
    assert.doesNotMatch(card.text, /inoai-task|"action"/);
    assert.deepEqual(card.buttons, [
      { label: "Create", style: "success", customId: `inoai:proposal:${card.proposalId}:create` },
      { label: "Cancel", style: "secondary", customId: `inoai:proposal:${card.proposalId}:cancel` },
    ]);
    assert.equal((await h.store.getTaskProposal(card.proposalId))!.card_message_id, card.id);

    // The click is answered with "Creating…" before the slow thread creation finishes.
    let release!: () => void;
    h.transport.threadGate = new Promise<void>((resolve) => { release = resolve; });
    let clicked = false;
    const first = h.click(card, "create").then((answer) => { clicked = true; return answer; });
    await until(() => h.transport.buttons.get(card.id)?.length === 0);
    assert.equal(clicked, false);
    assert.equal((await h.store.getTaskProposal(card.proposalId))!.state, "confirming");
    const second = await h.click(card, "create");
    assert.deepEqual(second, { reply: "This card is already being confirmed." });
    release();
    const answer = await first;
    assert.match(answer.update!.text, /^Creating… "CI report"$/);
    assert.deepEqual(answer.update!.buttons, []);

    const tasks = await h.store.listTasks();
    assert.equal(tasks.length, 1);
    const [task] = tasks;
    assert.deepEqual([task!.title, task!.goal, task!.output_spec, task!.schedule_kind, task!.schedule_time, task!.timezone, task!.created_by, task!.state],
      ["CI report", "Summarize failing CI", "Short list", "daily", "09:00", "Asia/Singapore", "discord:owner", "active"]);
    assert.deepEqual(h.transport.threads.slice(1).map(({ parentId, name, id }) => [parentId, name, id]), [["channel", "CI report", "thread-2"]]);
    const session = (await h.store.getSession(task!.session_id))!;
    assert.deepEqual([session.conversation_id, session.parent_conversation_id, session.agent_session_id, session.user_id, session.created_by],
      ["thread-2", "channel", "pending:task:thread-2", h.ownerId, "discord:owner"]);
    const proposal = (await h.store.getTaskProposal(card.proposalId))!;
    assert.deepEqual([proposal.state, proposal.result_task_id, proposal.created_by], ["confirmed", task!.id, "discord:owner"]);
    assert.ok(proposal.card_closed_at);
    assert.deepEqual(h.lastEdit(card.id), { text: `Created task #${task!.id} "CI report". Reports: https://discord.com/channels/guild/thread-2`, buttons: [] });

    const again = await h.click(card, "create");
    assert.match(again.update!.text, /^Created task #1 "CI report"/);
    assert.equal((await h.store.listTasks()).length, 1);
    assert.equal(h.transport.threads.length, 2);
    assert.equal((await h.store.listSessions()).length, 2);
    assert.deepEqual(await proposalEvents(h.store), [
      `task_proposal_created proposal=${card.proposalId}; kind=create; task=new`,
      `task_proposal_confirmed proposal=${card.proposalId}; kind=create; task=${task!.id}`,
    ]);

    // The created Task runs through the IP-0002 scheduler and executor and reports in its own thread.
    const schedulerClock = { now: () => new Date(task!.next_due_at! * 1000), setInterval: () => 0, clearInterval: () => {} };
    h.clock.seconds = task!.next_due_at!;
    const scheduler = new TaskScheduler(h.store, h.runner, schedulerClock);
    scheduler.start();
    await until(async () => (await h.store.listTaskRuns(task!.id))[0]?.state === "completed");
    await scheduler.stop();
    await until(() => h.transport.messages.some((sent) => sent.conversationId === "thread-2" && sent.text.startsWith(`Task #${task!.id} run #1 completed.`)));
    assert.ok((await h.store.getTask(task!.id))!.next_due_at! > task!.next_due_at!);
  });
});

test("Create cleans up and fails safely when the thread cannot be created", async () => {
  await withHarness(async (h) => {
    const card = await h.ask("make a report", `${block(create)}`);
    h.transport.failThread = true;
    await h.click(card, "create");
    assert.equal((await h.store.listTasks()).length, 0);
    assert.equal((await h.store.getTaskProposal(card.proposalId))!.state, "failed");
    assert.deepEqual(h.transport.deletedMessages.length, 1);
    assert.match(h.lastEdit(card.id)!.text, /^Failed: Task creation failed\. Check that inoai can create a thread here/);
    assert.deepEqual(h.lastEdit(card.id)!.buttons, []);
    assert.ok((await proposalEvents(h.store)).includes(`task_proposal_failed proposal=${card.proposalId}; kind=create; task=new; reason=thread_failed`));
  });
});

test("a sweep between finish and card close keeps the real failure text", async () => {
  let sweepsInWindow = 0;
  await withHarness(async (h) => {
    const card = await h.ask("make a report", block(create));
    h.transport.failThread = true;
    await h.click(card, "create");
    assert.equal(sweepsInWindow, 1);
    const text = 'Failed: Task creation failed. Check that inoai can create a thread here, then ask again. ("CI report")';
    assert.deepEqual(h.transport.edits.filter((edit) => edit.messageId === card.id).map((edit) => edit.text), [text]);
    // A later click on the failed card derives the same text from the stored reason.
    assert.deepEqual(await h.click(card, "create"), { update: { text, buttons: [] } });
  }, { cardStore: (store, cards) => ({ ...store,
    async finishTaskProposal(...args: Parameters<TaskCardStore["finishTaskProposal"]>) {
      const result = await store.finishTaskProposal(...args);
      sweepsInWindow += 1;
      await cards().sweep();
      return result;
    } }) });
});

test("with a task channel, Create saves a placeholder and the first run opens the thread there", async () => {
  await withHarness(async (h) => {
    const card = await h.ask("check CI every morning", block(create));
    assert.match(card.text, /Reports: a new thread in the task channel, opened on the first run/);
    await h.click(card, "create");
    await until(async () => (await h.store.getTaskProposal(card.proposalId))!.state === "confirmed");
    const [task] = await h.store.listTasks();
    assert.match(task!.conversation_id, /^pending:ui:/);
    const session = (await h.store.getSession(task!.session_id))!;
    assert.match(session.agent_session_id, /^pending:task:/);
    assert.equal(session.created_by, "discord:owner");
    assert.equal(h.transport.threads.length, 1);
    await until(() => /^Created task #1 "CI report"\. Its thread opens in the task channel on the first run\.$/.test(h.lastEdit(card.id)?.text ?? ""));

    assert.equal(await h.runner.start(task!.id), "started");
    await until(async () => (await h.store.listTaskRuns(task!.id))[0]?.state === "completed");
    const bound = (await h.store.getTask(task!.id))!;
    assert.deepEqual(h.transport.threads.at(-1), { parentId: "task-channel", starterId: h.transport.threads.at(-1)!.starterId, name: "CI report", id: bound.conversation_id });
    assert.equal((await h.store.listTasks()).length, 1);
  }, { taskChannelId: "task-channel" });
});

test("edit, run now, pause, resume, and cancel cards apply the existing rules; Cancel changes nothing", async () => {
  await withHarness(async (h) => {
    const first = await h.ask("set up the report", block(create));
    await h.click(first, "create");
    await until(async () => (await h.store.getTaskProposal(first.proposalId))!.state === "confirmed");
    const [task] = await h.store.listTasks();
    const id = task!.id;
    const conversation = first.conversationId;

    const edit = await h.ask("change it to 10am", block({ ...create, action: "edit", task: id, title: "CI digest", schedule: { kind: "daily", time: "10:00" } }), conversation);
    assert.match(edit.text, /^\*\*Edit task #1\*\*\nTitle: CI digest/);
    assert.equal(edit.buttons[0]!.label, "Confirm");
    await h.click(edit, "create");
    await until(async () => (await h.store.getTaskProposal(edit.proposalId))!.state === "confirmed");
    const edited = (await h.store.getTask(id))!;
    assert.deepEqual([edited.title, edited.schedule_time, edited.updated_by], ["CI digest", "10:00", "discord:owner"]);
    assert.notEqual(edited.next_due_at, task!.next_due_at);
    assert.equal(h.lastEdit(edit.id)!.text, 'Saved changes to task #1 "CI digest".');

    const dismissed = await h.ask("pause it", block({ action: "pause", task: id }), conversation);
    assert.match(dismissed.text, /^\*\*Pause task\*\*\nTask #1 "CI digest"/);
    const cancelled = await h.click(dismissed, "cancel");
    assert.equal(cancelled.update!.text, 'Cancelled. Nothing was changed. (task #1 "CI digest")');
    assert.deepEqual(cancelled.update!.buttons, []);
    const unchanged = (await h.store.getTask(id))!;
    assert.deepEqual([unchanged.state, unchanged.updated_at, unchanged.updated_by], [edited.state, edited.updated_at, edited.updated_by]);
    assert.equal((await h.store.getTaskProposal(dismissed.proposalId))!.state, "cancelled");

    for (const [action, state, text] of [["pause", "paused", "Paused"], ["resume", "active", "Resumed"]] as const) {
      const card = await h.ask(`${action} the digest`, block({ action, task: id }), conversation);
      await h.click(card, "create");
      await until(async () => (await h.store.getTaskProposal(card.proposalId))!.state === "confirmed");
      assert.equal((await h.store.getTask(id))!.state, state);
      assert.equal(h.lastEdit(card.id)!.text, `${text} task #1 "CI digest".`);
    }

    const run = await h.ask("run the digest now", block({ action: "run", task: id }), conversation);
    await h.click(run, "create");
    await until(async () => (await h.store.listTaskRuns(id))[0]?.state === "completed");
    assert.equal((await h.store.getTaskProposal(run.proposalId))!.state, "confirmed");
    assert.equal(h.lastEdit(run.id)!.text, 'Run started for task #1 "CI digest". Results will appear in its thread.');

    const cancel = await h.ask("cancel the digest", block({ action: "cancel", task: id }), conversation);
    assert.equal(cancel.buttons[0]!.style, "danger");
    await h.click(cancel, "create");
    await until(async () => (await h.store.getTask(id))!.state === "cancelled");

    // Confirm rechecks the Task state: a cancelled Task cannot be paused or edited.
    const late = await h.ask("pause the digest again", block({ action: "pause", task: id }), conversation);
    await h.click(late, "create");
    await until(async () => (await h.store.getTaskProposal(late.proposalId))!.state === "failed");
    assert.equal(h.lastEdit(late.id)!.text, 'Failed: Task #1 cannot be paused from its current state. (task #1 "CI digest")');
    const lateEdit = await h.ask("rename the digest", block({ ...create, action: "edit", task: id }), conversation);
    await h.click(lateEdit, "create");
    await until(async () => (await h.store.getTaskProposal(lateEdit.proposalId))!.state === "failed");
    assert.match(h.lastEdit(lateEdit.id)!.text, /^Failed: Only active or paused tasks can be edited\./);
    assert.equal((await h.store.getTask(id))!.state, "cancelled");
    assert.equal((await h.store.listTasks()).length, 1);
  });
});

test("non-owner clicks are refused privately and write nothing", async () => {
  await withHarness(async (h) => {
    await h.store.upsertUser({ transport: "discord", workspace_id: "guild", external_user_id: "friend", display_name: null, role: "family", state: "active" });
    const card = await h.ask("check CI every morning", block(create));
    const before = { proposal: await h.store.getTaskProposal(card.proposalId), events: await h.store.listEvents(), edits: h.transport.edits.length };
    for (const overrides of [{ externalUserId: "friend" }, { externalUserId: "stranger" }, { workspaceId: "other-guild" }]) {
      for (const action of ["create", "cancel"] as const) {
        assert.deepEqual(await h.click(card, action, overrides), { reply: "Only the owner can use this task card." });
      }
    }
    assert.deepEqual(await h.store.getTaskProposal(card.proposalId), before.proposal);
    assert.deepEqual(await h.store.listEvents(), before.events);
    assert.equal(h.transport.edits.length, before.edits);
    assert.equal(h.transport.buttons.get(card.id)!.length, 2);
    assert.equal((await h.store.listTasks()).length, 0);
    assert.deepEqual(await h.transport.click(card.id, "inoai:proposal:x:create", { conversationId: card.conversationId }),
      { reply: "This button is no longer available." });
    assert.deepEqual(await h.transport.click("other-message", `inoai:proposal:${card.proposalId}:create`, { conversationId: card.conversationId }),
      { reply: "This card is no longer active." });
    assert.equal((await h.store.getTaskProposal(card.proposalId))!.state, "pending");
  });
});

test("replacement, 24-hour expiry, and reset remove card buttons and set the proposal state", async () => {
  await withHarness(async (h) => {
    const older = await h.ask("check CI every morning", block(create));
    const newer = await h.ask("make it 8am instead", block({ ...create, schedule: { kind: "daily", time: "08:00" } }), older.conversationId);
    await until(() => h.lastEdit(older.id)?.text === 'Replaced by a newer card. ("CI report")');
    assert.deepEqual(h.lastEdit(older.id)!.buttons, []);
    assert.equal((await h.store.getTaskProposal(older.proposalId))!.state, "expired");
    assert.equal((await h.store.getTaskProposal(newer.proposalId))!.state, "pending");
    assert.equal(h.transport.buttons.get(newer.id)!.length, 2);

    h.clock.seconds += 86_400;
    for (const tick of h.clock.intervals) tick();
    await until(() => h.lastEdit(newer.id)?.text === 'Expired. Nothing was changed. ("CI report")');
    assert.equal((await h.store.getTaskProposal(newer.proposalId))!.state, "expired");
    assert.deepEqual(await h.click(newer, "create"), { update: { text: 'Expired. Nothing was changed. ("CI report")', buttons: [] } });
    assert.equal((await h.store.listTasks()).length, 0);

    const reset = await h.ask("weekly instead", block({ ...create, schedule: { kind: "weekly", time: "09:00", day: "mon" } }), older.conversationId);
    assert.match(await h.transport.control("reset", { conversationId: older.conversationId, parentConversationId: "channel" }), /Session reset/);
    assert.equal((await h.store.getTaskProposal(reset.proposalId))!.state, "expired");
    await until(() => h.lastEdit(reset.id)?.text === 'Expired. Nothing was changed. ("CI report")');
    assert.deepEqual((await h.click(reset, "create")).update!.buttons, []);
    assert.equal((await h.store.listTasks()).length, 0);
    const events = await proposalEvents(h.store);
    assert.ok(events.includes(`task_proposal_expired proposal=${older.proposalId}; kind=create; task=new; reason=replaced`));
    assert.ok(events.includes(`task_proposal_expired proposal=${newer.proposalId}; kind=create; task=new; reason=overdue`));
    assert.ok(events.includes(`task_proposal_expired proposal=${reset.proposalId}; kind=create; task=new; reason=reset`));
  });
});

test("a card send failure is not retried and fails the proposal", async () => {
  await withHarness(async (h) => {
    h.transport.failButtons = true;
    const before = h.transport.messages.length;
    h.send("card that fails", `Here you go.\n${block(create)}`);
    await until(async () => (await proposalEvents(h.store)).some((event) => event.startsWith("task_proposal_failed")));
    assert.deepEqual(await proposalEvents(h.store), [
      "task_proposal_created proposal=1; kind=create; task=new",
      "task_proposal_failed proposal=1; kind=create; task=new; reason=card_uncertain_after_send_attempt",
    ]);
    assert.equal(h.transport.messages.length, before + 1);
  });
});

test("startup fails a proposal left confirming and removes buttons from resolved cards", async () => {
  const directory = await mkdtemp(join(tmpdir(), "inoai-task-cards-restart-"));
  try {
    await writeFile((await bootstrapRuntimeHome(directory)).envFile, env);
    const first = await openHarness(directory);
    let stuck: Card;
    let overdueId: number;
    try {
      stuck = await first.ask("check CI every morning", block(create));
      assert.equal((await first.store.claimTaskProposal(stuck.proposalId, first.clock.seconds)).claimed, true);
      const conversation = (await first.store.getTaskProposal(stuck.proposalId))!;
      const other = await first.store.createSession({ user_id: first.ownerId, transport: "discord", workspace_id: "guild",
        parent_conversation_id: "channel", conversation_id: "thread-old", initiating_external_message_id: "start-old",
        agent_provider: "codex", agent_session_id: "codex-old", project_path: directory });
      const overdue = await first.store.createTaskProposal({ session_id: other.id, transport: "discord", workspace_id: "guild",
        conversation_id: "thread-old", kind: "create", task_id: null, spec_json: conversation.spec_json, expires_at: first.clock.seconds - 1 },
        first.clock.seconds - 100);
      await first.store.setTaskProposalCardMessage(overdue.id, "old-card", first.clock.seconds - 100);
      overdueId = overdue.id;
    } finally {
      await first.close();
    }
    const second = await openHarness(directory);
    try {
      const failed = (await second.store.getTaskProposal(stuck.proposalId))!;
      assert.deepEqual([failed.state, failed.updated_by], ["failed", "system"]);
      assert.equal((await second.store.getTaskProposal(overdueId))!.state, "expired");
      await until(() => second.transport.edits.length === 2);
      assert.deepEqual(second.lastEdit(stuck.id), { text: 'Failed: inoai stopped before this finished. Check your tasks before asking again. ("CI report")', buttons: [] });
      assert.deepEqual(second.lastEdit("old-card"), { text: 'Expired. Nothing was changed. ("CI report")', buttons: [] });
      assert.deepEqual(await second.store.listOpenTaskProposalCards(), []);
      assert.match((await second.click(stuck, "create")).update!.text, /^Failed: inoai stopped/);
      assert.equal((await second.store.listTasks()).length, 0);
    } finally {
      await second.close();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("the CLI run wires cards: a chat request becomes a confirmed task", async () => {
  const directory = await mkdtemp(join(tmpdir(), "inoai-task-cards-run-"));
  const previousDirectory = process.cwd();
  const previousExitCode = process.exitCode;
  try {
    const home = await bootstrapRuntimeHome(directory);
    await writeFile(home.envFile, env);
    process.chdir(directory);
    const transport = new FakeTransport();
    const runtime: AgentRuntime = {
      displayName: "Codex", loginHint: "codex login",
      async createSession() { return "codex-run"; }, async resumeSession() {},
      async *runTurn(): AsyncGenerator<RuntimeEvent> { yield { type: "answer", text: `On it.\n${block(create)}` }; },
      async cancel() {}, health() { return { state: "ready" }; }, async close() {},
    };
    const schedulerClock = { now: () => new Date(2026, 9, 3, 5, 0), setInterval: () => undefined, clearInterval: () => {} } satisfies SchedulerClock;
    await run([], transport, runtime, { schedulerClock });
    transport.emit({ transport: "discord", workspaceId: "guild", conversationId: "channel", parentConversationId: null,
      externalMessageId: "request", externalUserId: "owner", body: "check CI daily", replyToExternalMessageId: null,
      mentionedUserIds: ["inoai"], mentionedBotUserIds: ["inoai"], botUserId: "inoai", authorIsBot: false });
    await until(() => [...transport.buttons.values()].some((buttons) => buttons.length === 2));
    const [cardId, buttons] = [...transport.buttons.entries()].find(([, row]) => row.length === 2)!;
    assert.deepEqual(transport.messages.map((sent) => sent.text).slice(-2, -1), ["On it."]);
    await transport.click(cardId, buttons[0]!.customId, { conversationId: "thread-1" });
    await until(() => /^Created task #1 "CI report"/.test(transport.edits.at(-1)?.text ?? ""));
    process.emit("SIGTERM");
    await until(async () => stat(home.lockFile).then(() => false, () => true));
    const restarted = await start(directory);
    try {
      const [task] = await (restarted.store as OperationalStore & TaskOperationsStore).listTasks();
      assert.deepEqual([task!.title, task!.conversation_id, task!.created_by], ["CI report", "thread-2", "discord:owner"]);
    } finally {
      await restarted.release();
    }
  } finally {
    process.chdir(previousDirectory);
    process.exitCode = previousExitCode;
    await rm(directory, { recursive: true, force: true });
  }
});
