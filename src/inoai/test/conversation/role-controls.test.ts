import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { bootstrapRuntimeHome } from "../../agent-instance/runtime-home.js";
import { start, startTransport } from "../../app.js";
import { openDatabase } from "../../connectors/persistence/sqlite/legacy-database.js";
import type { ChatTransport, IncomingMessage, ThreadControl, TransportHealth } from "../../transport/ports.js";
import { useFixtureRoles } from "../roles/role-fixtures.js";

const env = ["DISCORD_BOT_TOKEN=unused", "DISCORD_GUILD_ID=guild", "DISCORD_OWNER_USER_ID=owner",
  "DISCORD_STATUS_CHANNEL_ID=status", "CHAT_PROVIDER=discord", "AGENT_PROVIDER=claude",
  "MEMORY_REVIEW_TIME=06:00", "MEMORY_REVIEW_MAX_CHARS=20000", "AGENT_INSTANCE_ID=agent-test"].join("\n");

class ControlTransport implements ChatTransport {
  private onControl?: (control: ThreadControl) => Promise<void>;
  async start(_onIncoming: (message: IncomingMessage) => void, onReady?: () => void | Promise<void>, _onFailure?: (error: Error) => void,
    onControl?: (control: ThreadControl) => Promise<void>): Promise<void> {
    this.onControl = onControl;
    await onReady?.();
  }
  async control(command: ThreadControl["command"], overrides: Partial<ThreadControl> = {}): Promise<string> {
    let answer = "";
    await this.onControl?.({ command, workspaceId: "guild", conversationId: "status", parentConversationId: null,
      guildTextChannelId: "status", externalUserId: "owner", conversationOwnedByBot: false,
      respond: async (text) => { answer = text; }, ...overrides });
    return answer;
  }
  async stop(): Promise<void> {}
  async createConversation(): Promise<string> { return "thread"; }
  async deleteConversation(): Promise<void> {}
  async sendMessage(): Promise<string> { return "sent"; }
  async publishHealth(): Promise<string> { return "online"; }
  health(): TransportHealth { return { state: "ready", botUserId: "inoai" }; }
}

async function withInstance(fn: (instance: Awaited<ReturnType<typeof start>>, directory: string) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "inoai-role-controls-"));
  try {
    const home = await bootstrapRuntimeHome(directory);
    await writeFile(home.envFile, env);
    await useFixtureRoles(home.rolesDirectory);
    const instance = await start(directory);
    try { await fn(instance, directory); } finally { await instance.release(); }
  } finally { await rm(directory, { recursive: true, force: true }); }
}

function equipRows(instance: Awaited<ReturnType<typeof start>>): Array<Record<string, unknown>> {
  const database = openDatabase(instance.runtimeHome);
  try {
    return database.prepare("SELECT role_id, equipped_by, unequipped_by, unequipped_at FROM role_equips ORDER BY id").all() as Array<Record<string, unknown>>;
  } finally { database.close(); }
}

test("owner role list, show, equip, and unequip use discord:owner and never echo role text", async () => {
  await withInstance(async (instance) => {
    const roles = instance.runtimeHome.rolesDirectory;
    await writeFile(join(roles, "broken.md"), "no heading here\nsecret plan text");
    const transport = new ControlTransport();
    await startTransport(instance, undefined, transport);

    const list = await transport.control("role-list");
    const lines = list.split("\n");
    assert.equal(lines.length, 4);
    assert.equal(lines[0], "broken: invalid: first line must be '# Role: <Name>'");
    assert.match(lines[1]!, /^designer: Designer — /);
    assert.match(lines[2]!, /^planner: Planner — /);
    assert.ok(lines.every((line) => line.length < 200));
    assert.doesNotMatch(list, /secret plan text|## Instructions|## Workflow/);

    assert.equal(await transport.control("role-show"), "No role is equipped. The base Agent Profile applies.");
    assert.match(await transport.control("role-equip", { roleId: "planner" }),
      /^Role equipped: Planner \(planner\)\. Previous: none\. It applies from the next Turn\.$/);
    assert.match(await transport.control("role-list"), /^planner \[equipped\]: Planner — /m);
    const shown = await transport.control("role-show");
    assert.match(shown, /^Equipped role: Planner \(planner\)\n\S/);
    assert.doesNotMatch(shown, /## Instructions|## Workflow/);
    assert.equal(await transport.control("role-equip", { roleId: "planner" }), "Role Planner (planner) is already equipped.");
    assert.match(await transport.control("role-equip", { roleId: "reviewer" }), /^Role equipped: Reviewer \(reviewer\)\. Previous: planner\./);
    assert.equal(await transport.control("role-unequip"), "Role reviewer unequipped. The base Agent Profile applies from the next Turn.");
    assert.equal(await transport.control("role-unequip"), "No role is equipped.");
    assert.deepEqual(equipRows(instance).map((row) => [row.role_id, row.equipped_by, row.unequipped_by, row.unequipped_at !== null]), [
      ["planner", "discord:owner", "discord:owner", true],
      ["reviewer", "discord:owner", "discord:owner", true],
    ]);
  });
});

test("equip refuses unknown, invalid, and reserved roles with no row written", async () => {
  await withInstance(async (instance) => {
    const roles = instance.runtimeHome.rolesDirectory;
    await writeFile(join(roles, "broken.md"), "# Role: Broken\n\nSummary only, no sections.");
    await writeFile(join(roles, "none.md"), "# Role: None\n\nSummary.\n\n## Instructions\n\nDo.\n\n## Workflow\n\nStep.");
    const transport = new ControlTransport();
    await startTransport(instance, undefined, transport);
    assert.equal(await transport.control("role-equip", { roleId: "missing" }),
      "Cannot equip role: role file not found. Use /inoai role list to see valid roles.");
    assert.match(await transport.control("role-equip", { roleId: "broken" }), /^Cannot equip role: missing or empty '## Instructions' section\./);
    assert.match(await transport.control("role-equip", { roleId: "none" }), /^Cannot equip role: reserved role id\./);
    assert.match(await transport.control("role-equip", { roleId: "../etc/passwd" }), /^Cannot equip role: invalid role id\./);
    assert.match(await transport.control("role-equip"), /^Cannot equip role: invalid role id\./);
    assert.deepEqual(equipRows(instance), []);
  });
});

test("role commands refuse non-owners and other workspaces", async () => {
  await withInstance(async (instance) => {
    await instance.store.equipRole!("planner", "cli:owner");
    const transport = new ControlTransport();
    await startTransport(instance, undefined, transport);
    for (const overrides of [{ externalUserId: "stranger" }, { workspaceId: "other-guild" }, { workspaceId: null }]) {
      for (const command of ["role-list", "role-show", "role-equip", "role-unequip"] as const) {
        assert.equal(await transport.control(command, { ...overrides, roleId: "reviewer" }), "Role control unavailable in this channel.");
      }
    }
    assert.deepEqual(equipRows(instance).map((row) => [row.role_id, row.unequipped_at]), [["planner", null]]);
  });
});

test("a long role list is truncated within the Discord reply limit", async () => {
  await withInstance(async (instance) => {
    const roles = instance.runtimeHome.rolesDirectory;
    const summary = "A long summary sentence that keeps going. ".repeat(10);
    for (let index = 0; index < 60; index++) {
      await writeFile(join(roles, `role-${String(index).padStart(2, "0")}.md`),
        `# Role: Role ${index} ${"x".repeat(80)}\n\n${summary}\n\n## Instructions\n\nDo.\n\n## Workflow\n\nStep.`);
    }
    const transport = new ControlTransport();
    await startTransport(instance, undefined, transport);
    const list = await transport.control("role-list");
    assert.ok(list.length <= 1900, `length ${list.length}`);
    assert.match(list, /\n…and \d+ more\.$/);
    const shown = list.split("\n").length - 1;
    assert.equal(Number(/…and (\d+) more\./.exec(list)![1]), 63 - shown);
  });
});

test("status shows the equipped role, and a store without role methods reports roles unsupported", async () => {
  await withInstance(async (instance, directory) => {
    await instance.store.createSession({ user_id: instance.owner.id, transport: "discord", workspace_id: "guild",
      parent_conversation_id: "channel", conversation_id: "thread-1", initiating_external_message_id: "start-1",
      agent_provider: "claude", agent_session_id: "claude-1", project_path: directory });
    const transport = new ControlTransport();
    await startTransport(instance, undefined, transport);
    const status = () => transport.control("status", { conversationId: "thread-1", parentConversationId: "channel", guildTextChannelId: "channel" });
    assert.match(await status(), /\nRole: none$/);
    await transport.control("role-equip", { roleId: "designer" });
    assert.match(await status(), /\nRole: Designer \(designer\)$/);

    const store = new Proxy(instance.store, { get(target, property, receiver) {
      if (property === "getEquippedRole" || property === "equipRole" || property === "unequipRole") return undefined;
      const value = Reflect.get(target, property, receiver) as unknown;
      return typeof value === "function" ? value.bind(target) : value;
    } });
    const plain = new ControlTransport();
    await startTransport(instance, undefined, plain, undefined, undefined, store);
    for (const command of ["role-list", "role-show", "role-equip", "role-unequip"] as const) {
      assert.equal(await plain.control(command, { roleId: "planner" }), "Roles are not supported with this store.");
    }
    assert.match(await plain.control("status", { conversationId: "thread-1", parentConversationId: "channel", guildTextChannelId: "channel" }), /\nRole: none$/);
  });
});
