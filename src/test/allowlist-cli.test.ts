import assert from "node:assert/strict";
import test from "node:test";

import { manageAllowlistWithStore } from "../index.js";

function fixture() {
  let nextId = 1;
  const users: any[] = [];
  return {
    users,
    async findUser(_transport: string, workspaceId: string, externalUserId: string) {
      return users.find((user) => user.workspace_id === workspaceId && user.external_user_id === externalUserId && user.state === "active");
    },
    async upsertUser(user: any, actor?: string) {
      const current = users.find((row) => row.workspace_id === user.workspace_id && row.external_user_id === user.external_user_id);
      const row = { ...(current ?? { id: nextId++, created_by: actor, created_at: 1 }), ...user, updated_by: actor, updated_at: 2, deleted_at: null, deleted_by: null };
      if (current) Object.assign(current, row);
      else users.push(row);
      return row;
    },
  };
}

test("allowlist add is idempotent and defaults to active family", async () => {
  const store = fixture();
  const first = await manageAllowlistWithStore(store, "add", "guild", "1556235492373045338", "Ada");
  const second = await manageAllowlistWithStore(store, "add", "guild", "1556235492373045338", "Ada Updated");
  assert.equal(first.role, "family");
  assert.equal(first.state, "active");
  assert.equal(second.display_name, "Ada Updated");
  assert.equal(store.users.length, 1);
});

test("allowlist disable keeps the row and add reactivates it", async () => {
  const store = fixture();
  await manageAllowlistWithStore(store, "add", "guild", "123", "Ada");
  const disabled = await manageAllowlistWithStore(store, "disable", "guild", "123");
  assert.equal(disabled.state, "disabled");
  assert.equal(store.users.length, 1);
  const enabled = await manageAllowlistWithStore(store, "add", "guild", "123", "Ada");
  assert.equal(enabled.state, "active");
});

test("allowlist cannot modify an active owner", async () => {
  const store = fixture();
  store.users.push({ id: 1, workspace_id: "guild", external_user_id: "1", role: "owner", state: "active" });
  await assert.rejects(manageAllowlistWithStore(store, "disable", "guild", "1"), /configured Discord owner/);
});
