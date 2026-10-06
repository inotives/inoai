import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import test from "node:test";
import type { ChildProcessWithoutNullStreams } from "node:child_process";

import { CodexAppServer } from "../codex-app-server.js";

class FakeProcess extends EventEmitter {
  stdin = new PassThrough();
  stdout = new PassThrough();
  stderr = new PassThrough();
  exitCode: number | null = null;
  killCalls = 0;
  sent: Array<Record<string, unknown>> = [];
  constructor(private account: unknown = { account: { type: "chatgpt" } }) {
    super();
    let buffered = "";
    this.stdin.on("data", (chunk: Buffer) => {
      buffered += chunk.toString();
      while (buffered.includes("\n")) {
        const at = buffered.indexOf("\n");
        const message = JSON.parse(buffered.slice(0, at)) as Record<string, unknown>;
        buffered = buffered.slice(at + 1);
        this.sent.push(message);
        if (message.method === "initialize") this.reply({ id: message.id, result: {} });
        if (message.method === "account/read") this.reply(this.account instanceof Error
          ? { id: message.id, error: { message: this.account.message } }
          : { id: message.id, result: this.account });
      }
    });
  }
  reply(message: unknown): void { this.stdout.write(`${JSON.stringify(message)}\n`); }
  kill(): boolean { this.killCalls++; this.exitCode = 0; this.emit("exit", 0); return true; }
  child(): ChildProcessWithoutNullStreams { return this as unknown as ChildProcessWithoutNullStreams; }
}

test("app-server initializes, checks ChatGPT auth, correlates replies, and closes", async () => {
  const fake = new FakeProcess();
  const client = await CodexAppServer.connect({ spawnProcess: () => fake.child() });
  assert.deepEqual(fake.sent.slice(0, 3).map((entry) => entry.method), ["initialize", "initialized", "account/read"]);
  assert.deepEqual(fake.sent[2].params, { refreshToken: true });
  assert.deepEqual(client.health(), { state: "ready" });

  const first = client.request("one", {});
  const second = client.request("two", {});
  const [one, two] = fake.sent.slice(-2);
  fake.reply({ id: two.id, result: "two" });
  fake.reply({ id: one.id, result: "one" });
  assert.deepEqual(await Promise.all([first, second]), ["one", "two"]);

  let requestId: number | string | undefined;
  client.onRequest = (_method, _params, id) => { requestId = id; };
  const sentBeforeApproval = fake.sent.length;
  fake.reply({ id: "approval-1", method: "item/commandExecution/requestApproval", params: {} });
  assert.equal(requestId, "approval-1");
  assert.equal(fake.sent.length, sentBeforeApproval);
  client.respond("approval-1", { decision: "decline" });
  assert.deepEqual(fake.sent.at(-1), { id: "approval-1", result: { decision: "decline" } });
  assert.throws(() => client.respond("approval-1", {}), /no longer live/);

  const pending = client.request("wait", {});
  fake.kill();
  await assert.rejects(pending, /exited/);
  assert.deepEqual(client.health(), { state: "error" });
  assert.throws(() => client.respond("approval-1", {}), /no longer live/);
  await client.close();
});

test("missing, expired, or non-ChatGPT auth fails before runtime readiness", async () => {
  for (const account of [{ account: null }, { account: { type: "apiKey" } }, new Error("secret expired-token detail")]) {
    const fake = new FakeProcess(account);
    await assert.rejects(CodexAppServer.connect({ spawnProcess: () => fake.child() }), /Codex ChatGPT sign-in/);
    assert.equal(fake.exitCode, 0);
    assert.equal(fake.sent.some((entry) => entry.method === "thread/start"), false);
  }
});

test("server errors do not leak raw protocol details and timed-out calls are cleared", async () => {
  const fake = new FakeProcess();
  const client = await CodexAppServer.connect({ spawnProcess: () => fake.child() });
  const denied = client.request("secret", {});
  fake.reply({ id: fake.sent.at(-1)?.id, error: { message: "private token value" } });
  await assert.rejects(denied, /Codex request failed/);
  await assert.rejects(client.request("never", {}, 5), /timed out/);
  await client.close();
  assert.deepEqual(client.health(), { state: "stopped" });
});

test("resolved server requests cannot be answered after the server clears them", async () => {
  const fake = new FakeProcess();
  const client = await CodexAppServer.connect({ spawnProcess: () => fake.child() });
  fake.reply({ id: "approval-2", method: "item/commandExecution/requestApproval", params: {} });
  fake.reply({ method: "serverRequest/resolved", params: { threadId: "thread-1", requestId: "approval-2" } });
  const sentBefore = fake.sent.length;
  assert.throws(() => client.respond("approval-2", { decision: "accept" }), /no longer live/);
  assert.equal(fake.sent.length, sentBefore);
  await client.close();
});

test("close terminates the child after a stdin error", async () => {
  const fake = new FakeProcess();
  const client = await CodexAppServer.connect({ spawnProcess: () => fake.child() });
  fake.stdin.emit("error", new Error("private detail"));
  assert.deepEqual(client.health(), { state: "error" });
  await client.close();
  assert.equal(fake.killCalls, 1);
  assert.deepEqual(client.health(), { state: "stopped" });
});
