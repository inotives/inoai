import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { AgentRuntime, RuntimeEvent } from "../../agent-runtime/ports.js";
import { bootstrapRuntimeHome } from "../../agent-instance/runtime-home.js";
import { start, startTransport } from "../../app.js";
import { MemoryProposalCards, type MemoryCardStore } from "../../conversation/memory-proposal-cards.js";
import { archiveMessage, createMemory, createMemoryProposal, createMemoryReview, completeMemoryReview, createSession, openDatabase } from "../../connectors/persistence/sqlite/legacy-database.js";
import type { MemoryProposalRecord, MemoryRecord, MessageRecord } from "../../connectors/persistence/sqlite/legacy-database.js";
import { createSqliteOperationalStore } from "../../connectors/persistence/sqlite/operational-store.js";
import { MemoryReviewScheduler } from "../../memory/memory-review-scheduler.js";
import type { SchedulerClock } from "../../memory/memory-review-scheduler.js";
import { FakeTransport } from "./fake-transport.js";

const env = ["DISCORD_BOT_TOKEN=unused", "DISCORD_GUILD_ID=guild", "DISCORD_OWNER_USER_ID=owner",
  "DISCORD_STATUS_CHANNEL_ID=status", "CHAT_PROVIDER=discord", "AGENT_PROVIDER=claude",
  "MEMORY_REVIEW_TIME=06:00", "MEMORY_REVIEW_MAX_CHARS=20000", "AGENT_INSTANCE_ID=agent-test"].join("\n");
const day = 24 * 3600;

async function until(check: () => boolean | Promise<boolean>, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
  if (await check()) return;
  throw new Error("Condition did not become true");
}

type Harness = Awaited<ReturnType<typeof openHarness>>;

async function openHarness(directory: string) {
  const database = openDatabase(await bootstrapRuntimeHome(directory));
  const store = createSqliteOperationalStore(database);
  const instance = await start(directory, undefined, () => store);
  const transport = new FakeTransport();
  const clock: SchedulerClock & { time: number } = {
    time: new Date(2026, 9, 3, 6, 0).getTime(),
    now: () => new Date(clock.time),
    setInterval: () => 0,
    clearInterval: () => undefined,
  };
  const seconds = () => Math.floor(clock.time / 1000);
  const cards = new MemoryProposalCards(store as MemoryCardStore, transport, { statusChannelId: "status", now: seconds });
  await startTransport(instance, undefined, transport, undefined, undefined, undefined, undefined, undefined, undefined, cards);
  const session = createSession(database, { user_id: instance.owner.id, transport: "discord", workspace_id: "guild",
    parent_conversation_id: "channel", conversation_id: "thread-a", initiating_external_message_id: "start",
    agent_provider: "claude", agent_session_id: "claude-1", project_path: directory });
  let count = 0;
  const add = (direction: "user" | "agent", body: string): MessageRecord => archiveMessage(database, {
    session_id: session.id, transport: "discord", workspace_id: "guild", external_message_id: `message-${++count}`,
    external_author_id: direction === "user" ? "owner" : null, user_id: direction === "user" ? instance.owner.id : null,
    direction, body, reply_to_external_message_id: null, in_reply_to_message_id: null, state: "completed",
  }).message!;
  /** Runs one daily review cycle whose aggregation answer has these actions. */
  const review = async (actions: () => unknown[]) => {
    const runtime: AgentRuntime = {
      displayName: "Claude", loginHint: "claude /login",
      async createSession() { return "claude-new"; }, async resumeSession() {},
      async *runTurn(): AsyncGenerator<RuntimeEvent> { yield { type: "answer", text: "ok" }; },
      async cancel() {}, health: () => ({ state: "ready" as const }), async close() {},
      async review(prompt) {
        return prompt.includes("combine the window notes")
          ? JSON.stringify({ recap: "A recap.", actions: actions() }) : '{"notes": "window notes"}';
      },
    };
    const scheduler = new MemoryReviewScheduler(store, runtime, { reviewTime: "06:00", maxChars: 20_000, clock,
      onReviewCompleted: (result) => { void cards.publishReview(result); } });
    scheduler.start();
    await scheduler.idle();
    await scheduler.stop();
  };
  const proposals = () => database.prepare("SELECT * FROM memory_proposals ORDER BY id").all() as unknown as Array<MemoryProposalRecord & { card_message_id: string | null }>;
  const memories = () => database.prepare("SELECT * FROM memories WHERE state = 'active' AND deleted_at IS NULL ORDER BY id").all() as unknown as MemoryRecord[];
  const click = (messageId: string, customId: string, overrides: Parameters<FakeTransport["click"]>[2] = {}) =>
    transport.click(messageId, customId, { conversationId: "status", ...overrides });
  return {
    instance, database, store, transport, clock, cards, session, add, review, proposals, memories, click,
    async close() { await cards.stop(); await instance.release(); },
  };
}

async function withHarness(run: (harness: Harness) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "inoai-memory-cards-"));
  try {
    await writeFile((await bootstrapRuntimeHome(directory)).envFile, env);
    const harness = await openHarness(directory);
    try { await run(harness); } finally { await harness.close(); }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test("a review with changes and proposals posts one summary and one card per proposal to the status channel", async () => {
  await withHarness(async (h) => {
    const old = createMemory(h.database, { body: "Owner uses npm.", source_message_id: null, created_by_user_id: null, review_id: null, origin: "review" });
    const secret = createMemory(h.database, { body: "Old note: password: hunter2", source_message_id: null, created_by_user_id: null, review_id: null, origin: "review" });
    const request = h.add("user", "Please remember that I like tabs and that I now use pnpm.");
    h.add("agent", "Noted.");
    const short = h.add("user", "I prefer short answers.");
    const english = h.add("user", "We decided the reports are in English.");
    await h.review(() => [
      { op: "add", body: "Owner likes tabs.", source_message_ids: [request.id], source_recap_ids: [] },
      { op: "update", memory_id: old.id, body: "Owner uses pnpm.", source_message_ids: [request.id], source_recap_ids: [] },
      { op: "delete", memory_id: secret.id, source_message_ids: [request.id], source_recap_ids: [] },
      { op: "propose", body: "Owner prefers short answers.", kind: "core", source_message_ids: [short.id] },
      { op: "propose", body: "Reports are written in English.", kind: "topic", source_message_ids: [english.id] },
    ]);
    await until(() => h.transport.messages.length === 3);
    assert.ok(h.transport.messages.every((message) => message.conversationId === "status"));
    const [summary, first, second] = h.transport.messages;
    assert.equal(summary!.text, [
      "**Memory Review**",
      "Added 1, updated 1, deleted 1. New proposals: 2.",
      "- Added: Owner likes tabs.",
      "- Updated: Owner uses pnpm.",
      "- Deleted: [redacted: secret-like text]",
      "Confirm or reject each proposal below.",
    ].join("\n"));
    assert.doesNotMatch(summary!.text, /hunter2/);
    assert.deepEqual(h.transport.buttons.get(summary!.id), undefined);
    const [core, topic] = h.proposals();
    assert.equal(first!.text, `**Memory proposal** (core, used in every conversation)\n> Owner prefers short answers.\nThis card expires <t:${core!.expires_at}:R>.`);
    assert.equal(second!.text, `**Memory proposal** (topic, used when relevant)\n> Reports are written in English.\nThis card expires <t:${topic!.expires_at}:R>.`);
    assert.deepEqual(h.transport.buttons.get(first!.id), [
      { label: "Confirm", style: "success", customId: `inoai:memory:${core!.id}:confirm` },
      { label: "Reject", style: "secondary", customId: `inoai:memory:${core!.id}:reject` },
    ]);
    assert.deepEqual(h.proposals().map((row) => [row.state, row.card_message_id]), [["pending", first!.id], ["pending", second!.id]]);
  });
});

test("a quiet review posts nothing", async () => {
  await withHarness(async (h) => {
    h.add("user", "What time is it?");
    h.add("agent", "Noon.");
    await h.review(() => [{ op: "ignore" }]);
    await h.cards.stop();
    assert.equal((await h.store.listEvents()).filter((event) => event.event_type === "memory_review_completed").length, 1);
    assert.deepEqual(h.transport.messages, []);
  });
});

test("owner Confirm creates the Memory with the proposed kind; Reject records it; other clicks change nothing", async () => {
  await withHarness(async (h) => {
    const short = h.add("user", "I prefer short answers.");
    const english = h.add("user", "We decided the reports are in English.");
    const dark = h.add("user", "I like dark mode.");
    await h.review(() => [
      { op: "propose", body: "Owner prefers short answers.", kind: "core", source_message_ids: [short.id] },
      { op: "propose", body: "Reports are written in English.", kind: "topic", source_message_ids: [english.id] },
      { op: "propose", body: "Owner likes dark mode.", kind: "topic", source_message_ids: [dark.id] },
    ]);
    await until(() => h.transport.messages.length === 4);
    const [, coreCard, rejectCard, expireCard] = h.transport.messages;
    const [core, rejected, expiring] = h.proposals();
    const id = (proposal: MemoryProposalRecord, action: string) => `inoai:memory:${proposal.id}:${action}`;

    // Non-owners are refused privately and write nothing.
    for (const overrides of [{ externalUserId: "friend" }, { workspaceId: "other-guild" }]) {
      assert.deepEqual(await h.click(coreCard!.id, id(core!, "confirm"), overrides), { reply: "Only the owner can use this Memory card." });
    }
    assert.equal(h.proposals()[0]!.state, "pending");
    assert.deepEqual(h.memories(), []);

    // Unknown proposals and clicks on another message change nothing and say so on the card.
    const unavailable = { update: { text: "This Memory proposal is no longer available. Nothing was changed.", buttons: [] } };
    assert.deepEqual(await h.click(coreCard!.id, "inoai:memory:999:confirm"), unavailable);
    assert.deepEqual(await h.click(rejectCard!.id, id(core!, "confirm")), unavailable);
    assert.deepEqual(await h.click(coreCard!.id, id(core!, "confirm"), { conversationId: "thread-a" }), unavailable);
    assert.equal(h.proposals()[0]!.state, "pending");

    // Confirm creates one core Memory and edits the card; a second click changes nothing.
    const confirmed = await h.click(coreCard!.id, id(core!, "confirm"));
    const memory = h.memories().find((row) => row.body === "Owner prefers short answers.")!;
    assert.deepEqual([memory.kind, memory.origin, memory.review_id, memory.source_message_id], ["core", "review", core!.review_id, short.id]);
    const confirmedText = `Confirmed. Saved as core Memory #${memory.id}.\n> Owner prefers short answers.`;
    assert.deepEqual(confirmed, { update: { text: confirmedText, buttons: [] } });
    assert.deepEqual(await h.click(coreCard!.id, id(core!, "confirm")), { update: { text: confirmedText, buttons: [] } });
    assert.deepEqual(await h.click(coreCard!.id, id(core!, "reject")), { update: { text: confirmedText, buttons: [] } });
    assert.equal(h.memories().length, 1);
    assert.equal(h.proposals()[0]!.state, "confirmed");

    // Reject records the rejection; a later Confirm does not create a Memory.
    const rejectedText = "Rejected. This text will not be proposed again.\n> Reports are written in English.";
    assert.deepEqual(await h.click(rejectCard!.id, id(rejected!, "reject")), { update: { text: rejectedText, buttons: [] } });
    assert.deepEqual(await h.click(rejectCard!.id, id(rejected!, "confirm")), { update: { text: rejectedText, buttons: [] } });
    assert.deepEqual(h.proposals().map((row) => [row.state, row.updated_by]).slice(1, 2), [["rejected", "discord:owner"]]);

    // An expired proposal changes nothing.
    h.clock.time += 8 * day * 1000;
    const expiredText = "Expired. Nothing was changed.\n> Owner likes dark mode.";
    assert.deepEqual(await h.click(expireCard!.id, id(expiring!, "confirm")), { update: { text: expiredText, buttons: [] } });
    assert.equal(h.proposals()[2]!.state, "expired");
    assert.equal(h.memories().length, 1);
  });
});

test("a card that cannot be posted keeps its proposal pending", async () => {
  await withHarness(async (h) => {
    const message = h.add("user", "I prefer short answers.");
    const review = createMemoryReview(h.database, { session_id: h.session.id, from_message_id: message.id, through_message_id: message.id });
    completeMemoryReview(h.database, review.id, "A recap.");
    const proposal = createMemoryProposal(h.database, { body: "Owner prefers short answers.", kind: "core", review_id: review.id,
      source_message_ids: [message.id], expires_at: Math.floor(h.clock.time / 1000) + 7 * day }, Math.floor(h.clock.time / 1000));
    h.transport.failButtons = true;
    await h.cards.publishReview({ state: "completed", reviewId: review.id, throughMessageId: message.id, added: 0, updated: 0, deleted: 0,
      ignored: [], proposalIds: [proposal.id], changes: [] });
    assert.deepEqual(h.transport.messages.map((sent) => sent.text), ["**Memory Review**\nAdded 0, updated 0, deleted 0. New proposals: 1.\nConfirm or reject each proposal below."]);
    assert.deepEqual(h.proposals().map((row) => [row.state, row.card_message_id]), [["pending", null]]);
  });
});
