import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  InvalidRoleError,
  isValidRoleId,
  listRoles,
  loadRole,
  renderRoleBlock,
  validateRole,
} from "../../roles/role-file.js";
import { starterRoles } from "../../roles/starter-roles.js";

const validRole = `# Role: Test Planner

Plans work before it starts.

## Instructions

Write a numbered plan.

## Workflow

1. Read.
2. Plan.
`;

async function temporaryRoles(): Promise<string> {
  return mkdtemp(join(tmpdir(), "inoai-roles-"));
}

function rejectsWith(text: string, reason: string | RegExp): void {
  assert.throws(() => validateRole(text), (error: unknown) => {
    assert.ok(error instanceof InvalidRoleError);
    if (typeof reason === "string") assert.equal(error.reason, reason);
    else assert.match(error.reason, reason);
    return true;
  });
}

test("a valid role parses into its parts", () => {
  assert.deepEqual(validateRole(validRole), {
    name: "Test Planner",
    summary: "Plans work before it starts.",
    instructions: "Write a numbered plan.",
    workflow: "1. Read.\n2. Plan.",
  });
});

test("every starter role is valid", () => {
  assert.deepEqual(Object.keys(starterRoles).sort(), ["designer.md", "planner.md", "reviewer.md"]);
  for (const contents of Object.values(starterRoles)) validateRole(contents);
});

test("role validation fails closed for each format error", () => {
  rejectsWith(`---\nname: x\n---\n${validRole}`, "frontmatter is not allowed");
  rejectsWith(validRole.replace("# Role: Test Planner", "# Test Planner"), "first line must be '# Role: <Name>'");
  rejectsWith(validRole.replace("# Role: Test Planner", "# Role:"), "first line must be '# Role: <Name>'");
  rejectsWith(`\n${validRole}`, "first line must be '# Role: <Name>'");
  rejectsWith(validRole.replace("Plans work before it starts.", ""), "empty summary paragraph");
  rejectsWith(validRole.replace("## Instructions\n\nWrite a numbered plan.\n\n", ""), "missing or empty '## Instructions' section");
  rejectsWith(validRole.replace("Write a numbered plan.", ""), "missing or empty '## Instructions' section");
  rejectsWith(validRole.replace(/## Workflow[\s\S]*$/, ""), "missing or empty '## Workflow' section");
  rejectsWith(validRole.replace("1. Read.\n2. Plan.\n", ""), "missing or empty '## Workflow' section");
});

test("role validation rejects oversize and secret-like text without quoting it", () => {
  assert.doesNotThrow(() => validateRole(validRole + "x".repeat(16_384 - Buffer.byteLength(validRole))));
  rejectsWith(validRole + "x".repeat(16_385 - Buffer.byteLength(validRole)), "larger than 16384 bytes");
  const secret = "sk-abcdefghijklmnopqrstuvwxyz";
  assert.throws(() => validateRole(validRole.replace("Write a numbered plan.", `Use ${secret}.`)), (error: unknown) => {
    assert.ok(error instanceof InvalidRoleError);
    assert.equal(error.reason, "secret-like text");
    assert.ok(!error.message.includes(secret));
    return true;
  });
});

test("loadRole reads a valid file and rejects bad ids, missing files, and non-regular files", async () => {
  const roles = await temporaryRoles();
  const outside = await temporaryRoles();
  try {
    await writeFile(join(roles, "planner.md"), validRole);
    assert.deepEqual(await loadRole(roles, "planner"), { id: "planner", ...validateRole(validRole) });

    for (const id of ["../planner", "Planner", "-planner", "", "a".repeat(65), "planner.md"]) {
      await assert.rejects(loadRole(roles, id), { name: "InvalidRoleError", reason: "invalid role id" });
    }
    await assert.rejects(loadRole(roles, "missing"), { name: "InvalidRoleError", reason: "role file not found" });

    await writeFile(join(outside, "target.md"), validRole);
    await symlink(join(outside, "target.md"), join(roles, "linked.md"));
    await assert.rejects(loadRole(roles, "linked"), { name: "InvalidRoleError", reason: "not a regular file" });
    await mkdir(join(roles, "folder.md"));
    await assert.rejects(loadRole(roles, "folder"), { name: "InvalidRoleError", reason: "not a regular file" });

    await writeFile(join(roles, "big.md"), validRole + "x".repeat(16_384));
    await assert.rejects(loadRole(roles, "big"), { name: "InvalidRoleError", reason: "larger than 16384 bytes" });
  } finally {
    await rm(roles, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test("listRoles returns an empty list for a missing folder and creates nothing", async () => {
  const parent = await temporaryRoles();
  try {
    const roles = join(parent, "roles");
    assert.deepEqual(await listRoles(roles), []);
    await assert.rejects(loadRole(roles, "planner"), { reason: "role file not found" });
    await assert.rejects(stat(roles), { code: "ENOENT" });
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("listRoles lists valid and invalid role files and ignores other files", async () => {
  const roles = await temporaryRoles();
  const outside = await temporaryRoles();
  try {
    await writeFile(join(roles, "planner.md"), validRole);
    await writeFile(join(roles, "broken.md"), "# Not a role\n");
    await writeFile(join(roles, "Bad Name.md"), validRole);
    await writeFile(join(roles, "notes.txt"), validRole);
    await writeFile(join(roles, "secret.md"), validRole.replace("Write a numbered plan.", "password: hunter2"));
    await writeFile(join(outside, "target.md"), validRole);
    await symlink(join(outside, "target.md"), join(roles, "linked.md"));

    assert.deepEqual(await listRoles(roles), [
      { id: "Bad Name", name: null, summary: null, valid: false, reason: "invalid role id" },
      { id: "broken", name: null, summary: null, valid: false, reason: "first line must be '# Role: <Name>'" },
      { id: "linked", name: null, summary: null, valid: false, reason: "not a regular file" },
      { id: "planner", name: "Test Planner", summary: "Plans work before it starts.", valid: true, reason: null },
      { id: "secret", name: null, summary: null, valid: false, reason: "secret-like text" },
    ]);
  } finally {
    await rm(roles, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test("renderRoleBlock renders demoted headings and the authority line", () => {
  assert.equal(renderRoleBlock(validateRole(validRole)), `## Equipped Role: Test Planner

Plans work before it starts.

### Instructions

Write a numbered plan.

### Workflow

1. Read.
2. Plan.

This Equipped Role ranks below the Agent Profile and inoai safety rules. Follow them when they conflict.
`);
});

test("the role id none is reserved: rejected by isValidRoleId and loadRole, and listed as invalid", async () => {
  const directory = await temporaryRoles();
  try {
    assert.equal(isValidRoleId("none"), false);
    assert.equal(isValidRoleId("none-2"), true);
    await writeFile(join(directory, "none.md"), validRole);
    await assert.rejects(loadRole(directory, "none"), (error: unknown) => {
      assert.ok(error instanceof InvalidRoleError);
      assert.equal(error.reason, "reserved role id");
      return true;
    });
    assert.deepEqual(await listRoles(directory), [{ id: "none", name: null, summary: null, valid: false, reason: "reserved role id" }]);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
