import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { sqliteStore } from "../test/sqlite-store.js";

import { RuntimeFailure } from "../agent-runtime.js";
import type { AgentRuntime, RuntimeEvent } from "../agent-runtime.js";
import { ConversationWorker, splitFinalAnswer } from "../conversation/conversation-worker.js";
import { archiveMessage, claimNextMessage, createSession, listMessages, markRuntimeStarted, openDatabase, upsertUser } from "../database.js";
import { bootstrapRuntimeHome } from "../runtime-home.js";
import { KnownDeliveryFailure } from "../transport.js";

function runtime(events: RuntimeEvent[] | RuntimeFailure): AgentRuntime {
  return {
    displayName: "Codex", loginHint: "codex login",
    async createSession() { throw new Error("Unexpected create"); }, async resumeSession() {},
    async *runTurn() {
      if (events instanceof RuntimeFailure) throw events;
      for (const event of events) yield event;
    },
    async cancel() {}, health() { return { state: "ready" }; }, async close() {},
  };
}

async function fixture(name: string) {
  const directory = await mkdtemp(join(tmpdir(), name));
  const home = await bootstrapRuntimeHome(directory);
  const database = openDatabase(home);
  const owner = upsertUser(database, { transport: "discord", workspace_id: "guild", external_user_id: "owner",
    display_name: null, role: "owner", state: "active" })!;
  const session = createSession(database, { user_id: owner.id, transport: "discord", workspace_id: "guild",
    parent_conversation_id: "channel", conversation_id: "thread", initiating_external_message_id: "input",
    agent_provider: "codex", agent_session_id: "codex-thread", project_path: directory });
  const input = archiveMessage(database, { session_id: session.id, transport: "discord", workspace_id: "guild",
    external_message_id: "input", external_author_id: "owner", user_id: owner.id, direction: "user", body: "hello",
    reply_to_external_message_id: null, in_reply_to_message_id: null }).message!;
  return { directory, home, database, session, input };
}

test("completed Unicode answer is archived before ordered Discord delivery; progress is typing only", async () => {
  const f = await fixture("inoai-delivery-success-");
  const answer = `First line\n${"😀 alphabet ".repeat(300)}last`;
  const sent: string[] = [];
  const typing: string[] = [];
  const transport = {
    async sendMessage(_thread: string, text: string) {
      const archived = listMessages(f.database, f.session.id).filter((row) => row.direction === "agent");
      assert.equal(archived.find((row) => row.body === text)?.delivery_state, "uncertain");
      sent.push(text);
      return `discord-${sent.length}`;
    },
    async showWorking(thread: string) { typing.push(thread); },
  };
  const worker = new ConversationWorker(sqliteStore(f.database), f.home,
    runtime([{ type: "progress", text: "secret raw tool trace" }, { type: "answer", text: answer }]), "codex", () => {}, transport);
  try {
    worker.wake();
    await worker.idle();
    const rows = listMessages(f.database, f.session.id).filter((row) => row.direction === "agent");
    assert(rows.length > 1);
    assert.equal(rows.map((row) => row.body).join(""), answer);
    assert.deepEqual(sent, rows.map((row) => row.body));
    assert(rows.every((row, index) => row.body.length <= 2000 && row.external_message_id === `discord-${index + 1}`
      && row.delivery_state === "confirmed" && row.in_reply_to_message_id === f.input.id));
    assert(typing.includes("thread"));
    assert(!sent.join("").includes("secret raw tool trace"));
  } finally { await worker.stop(); f.database.close(); await rm(f.directory, { recursive: true, force: true }); }
});

test("known pre-send failure is distinct from ambiguous acceptance, and neither is retried", async () => {
  for (const known of [true, false]) {
    const f = await fixture(`inoai-delivery-${known ? "known" : "uncertain"}-`);
    const accepted: string[] = [];
    const transport = {
      async sendMessage(_thread: string, text: string) {
        if (known) throw new KnownDeliveryFailure("not sendable");
        accepted.push(text);
        throw new Error("Connection lost after acceptance");
      },
    };
    const worker = new ConversationWorker(sqliteStore(f.database), f.home, runtime([{ type: "answer", text: "😀".repeat(1200) }]), "codex", () => {}, transport);
    try {
      worker.wake();
      await worker.idle();
      const chunks = listMessages(f.database, f.session.id).filter((row) => row.direction === "agent");
      assert(chunks.length > 1);
      assert.equal(chunks[0]?.delivery_state, known ? "failed" : "uncertain");
      assert(chunks.slice(1).every((row) => row.delivery_state === "failed"));
      assert.equal(accepted.length, known ? 0 : 1);
      assert.equal(chunks.map((row) => row.body).join(""), "😀".repeat(1200));
      await worker.stop();
      f.database.close();
      const reopened = openDatabase(f.home);
      const restarted = new ConversationWorker(sqliteStore(reopened), f.home, runtime([]), "codex", () => {}, transport);
      restarted.wake();
      await restarted.idle();
      assert.equal(accepted.length, known ? 0 : 1);
      await restarted.stop();
      reopened.close();
    } finally { await rm(f.directory, { recursive: true, force: true }); }
  }
});

test("partial send stops later chunks while retaining the full archived answer", async () => {
  const f = await fixture("inoai-delivery-partial-");
  let attempts = 0;
  const answer = "😀".repeat(2500);
  const transport = { async sendMessage() {
    attempts++;
    if (attempts === 2) throw new KnownDeliveryFailure("blocked before send");
    return "first-id";
  } };
  const worker = new ConversationWorker(sqliteStore(f.database), f.home, runtime([{ type: "answer", text: answer }]), "codex", () => {}, transport);
  try {
    worker.wake();
    await worker.idle();
    const chunks = listMessages(f.database, f.session.id).filter((row) => row.direction === "agent");
    assert.deepEqual(chunks.map((row) => row.delivery_state), ["confirmed", "failed", "failed"]);
    assert.equal(chunks.map((row) => row.body).join(""), answer);
    assert.equal(attempts, 2);
  } finally { await worker.stop(); f.database.close(); await rm(f.directory, { recursive: true, force: true }); }
});

test("terminal failure sends one generic archived notice without exposing runtime details", async () => {
  const f = await fixture("inoai-delivery-failure-");
  const sent: string[] = [];
  const transport = { async sendMessage(_thread: string, text: string) { sent.push(text); return "notice-id"; } };
  const worker = new ConversationWorker(sqliteStore(f.database), f.home, runtime(new RuntimeFailure("uncertain")), "codex", () => {}, transport);
  try {
    worker.wake();
    await worker.idle();
    worker.wake();
    await worker.idle();
    const notices = listMessages(f.database, f.session.id).filter((row) => row.direction === "agent");
    assert.equal(notices.length, 1);
    assert.equal(notices[0]?.delivery_state, "confirmed");
    assert.equal(sent.length, 1);
    assert.match(sent[0]!, /won't replay/);
    assert(!sent[0]!.includes("RuntimeFailure"));
  } finally { await worker.stop(); f.database.close(); await rm(f.directory, { recursive: true, force: true }); }
});

test("restart reports a stale post-start turn once without replaying Codex", async () => {
  const f = await fixture("inoai-delivery-recovery-");
  assert.equal(claimNextMessage(f.database, "global")?.id, f.input.id);
  assert(markRuntimeStarted(f.database, f.input.id));
  f.database.close();
  const database = openDatabase(f.home);
  const sent: string[] = [];
  const transport = { async sendMessage(_thread: string, text: string) { sent.push(text); return "recovered-notice"; } };
  const worker = new ConversationWorker(sqliteStore(database), f.home, runtime([]), "codex", () => {}, transport);
  try {
    worker.wake();
    await worker.idle();
    worker.wake();
    await worker.idle();
    assert.equal(sent.length, 1);
    assert.match(sent[0]!, /won't replay/);
    assert.equal(listMessages(database, f.session.id).find((row) => row.direction === "user")?.state, "failed");
  } finally { await worker.stop(); database.close(); await rm(f.directory, { recursive: true, force: true }); }
});

test("splitFinalAnswer preserves exact text and never splits a surrogate pair", () => {
  const answer = "😀".repeat(1200);
  const chunks = splitFinalAnswer(answer);
  assert.equal(chunks.join(""), answer);
  assert(chunks.every((chunk) => chunk.length <= 2000 && !/[\uD800-\uDBFF]$/.test(chunk)));
});
