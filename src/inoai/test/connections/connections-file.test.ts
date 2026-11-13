import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { mkdir, mkdtemp, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import {
  InvalidConnectionsError,
  loadConnections,
  loadResolvedConnections,
  parseConnections,
  resolveConnections,
} from "../../connections/connections-file.js";
import { bootstrapRuntimeHome, resolveRuntimeHome } from "../../agent-instance/runtime-home.js";

const execFile = promisify(execFileCallback);
const file = "/home/connections.json";
const token = "SENTINEL-TOKEN-VALUE-42";
const docsKey = "SENTINEL-DOCS-KEY-77";

const validDocument = {
  version: 1,
  connections: {
    github: {
      type: "stdio",
      command: "SENTINEL-COMMAND",
      args: ["-y", "SENTINEL-ARG", "--token=${GITHUB_TOKEN}"],
      env: { GITHUB_PERSONAL_ACCESS_TOKEN: "${GITHUB_TOKEN}" },
      allow: ["search_issues", "get_issue"],
    },
    "kg-demo": {
      type: "http",
      url: "https://sentinel-url.example/mcp",
      headers: { Authorization: "Bearer ${DOCS_API_KEY}" },
      allow: "all",
    },
  },
};

const env = { GITHUB_TOKEN: token, DOCS_API_KEY: docsKey };

function withConnection(connection: unknown, name = "app"): string {
  return JSON.stringify({ version: 1, connections: { [name]: connection } });
}

function rejects(action: () => unknown, reason: RegExp): void {
  assert.throws(action, (error: unknown) => {
    assert.ok(error instanceof InvalidConnectionsError);
    assert.match(error.reason, reason);
    assert.ok(error.message.includes(file));
    for (const value of [token, docsKey, "SENTINEL-LITERAL", "ghp_"]) assert.equal(error.message.includes(value), false, error.message);
    return true;
  });
}

function rejectsResolved(connection: unknown, reason: RegExp, values: Record<string, string> = env): void {
  rejects(() => resolveConnections(file, parseConnections(file, withConnection(connection)), values), reason);
}

test("valid stdio and http connections resolve to filled-in servers and allowed tools", () => {
  const connections = parseConnections(file, JSON.stringify(validDocument));
  const resolved = resolveConnections(file, connections, env);
  assert.deepEqual(resolved.mcpServers, {
    github: {
      type: "stdio",
      command: "SENTINEL-COMMAND",
      args: ["-y", "SENTINEL-ARG", `--token=${token}`],
      env: { GITHUB_PERSONAL_ACCESS_TOKEN: token },
    },
    "kg-demo": { type: "http", url: "https://sentinel-url.example/mcp", headers: { Authorization: `Bearer ${docsKey}` } },
  });
  assert.deepEqual(resolved.allowedTools, ["mcp__github__search_issues", "mcp__github__get_issue", "mcp__kg-demo"]);
});

test("a connection with no allow list starts with no allowed tools, and an empty file has no connections", () => {
  const resolved = resolveConnections(file, parseConnections(file, withConnection({ type: "stdio", command: "node" })), {});
  assert.deepEqual(resolved, { mcpServers: { app: { type: "stdio", command: "node" } }, allowedTools: [] });
  assert.deepEqual(parseConnections(file, JSON.stringify({ version: 1, connections: {} })), []);
});

test("schema problems are rejected with value-free reasons", () => {
  rejects(() => parseConnections(file, "{ not json SENTINEL-LITERAL"), /not valid JSON/);
  rejects(() => parseConnections(file, "[]"), /top level/);
  rejects(() => parseConnections(file, JSON.stringify({ version: 2, connections: {} })), /version must be 1/);
  rejects(() => parseConnections(file, JSON.stringify({ version: 1, connections: {}, extra: true })), /unknown key "extra"/);
  rejects(() => parseConnections(file, JSON.stringify({ version: 1, connections: {}, "ghp_SENTINEL-LITERAL": 1 })), /an unknown key$/);
  for (const name of ["GitHub", "a__b", "-lead", "", "x".repeat(33), "has space", "SENTINEL-LITERAL"]) {
    rejects(() => parseConnections(file, withConnection({ type: "stdio", command: "node" }, name)), /connection name is invalid/);
  }
  rejects(() => parseConnections(file, withConnection({ type: "sse", url: "https://x" })), /type must be "stdio" or "http"/);
  rejects(() => parseConnections(file, withConnection({ type: "stdio", command: "node", url: "x" })), /unknown key "url"/);
  rejects(() => parseConnections(file, withConnection({ type: "http", url: "https://x", command: "node" })), /unknown key "command"/);
  rejects(() => parseConnections(file, withConnection({ type: "stdio", command: "" })), /command must be/);
  rejects(() => parseConnections(file, withConnection({ type: "stdio", command: "node", args: [1] })), /args must be a list of strings/);
  rejects(() => parseConnections(file, withConnection({ type: "stdio", command: "node", env: { "BAD-NAME": "x" } })), /invalid key name/);
  rejects(() => parseConnections(file, withConnection({ type: "stdio", command: "node", env: { A: 1 } })), /values must be strings/);
  rejects(() => parseConnections(file, withConnection({ type: "http", url: "https://x", headers: { "Bad Header": "x" } })), /invalid key name/);
  rejects(() => parseConnections(file, withConnection({ type: "stdio", command: "node", allow: ["mcp:tool"] })), /invalid tool name/);
  rejects(() => parseConnections(file, withConnection({ type: "stdio", command: "node", allow: "some" })), /allow must be/);
});

test("references must exist, be non-empty, be safe to share, and leave no ${ behind", () => {
  rejectsResolved({ type: "stdio", command: "node", env: { A: "${MISSING}" } }, /refers to MISSING, which is missing or empty/);
  rejectsResolved({ type: "stdio", command: "node", env: { A: "${EMPTY}" } }, /refers to EMPTY, which is missing or empty/, { EMPTY: "" });
  for (const key of ["DISCORD_BOT_TOKEN", "ANTHROPIC_API_KEY", "POSTGRES_URL"]) {
    rejectsResolved({ type: "http", url: "https://x", headers: { "X-Key": `\${${key}}` } }, new RegExp(`refers to ${key}, an inoai key`), { [key]: "SENTINEL-LITERAL" });
  }
  rejectsResolved({ type: "stdio", command: "node", args: ["${NESTED}"] }, /NESTED, whose .env value contains/, { NESTED: "${SENTINEL-LITERAL}" });
  rejectsResolved({ type: "stdio", command: "node", env: { A: "${X:-y}" } }, /unsupported reference form/, { X: "v" });
  rejectsResolved({ type: "http", url: "https://x/${X", allow: [] }, /still contains "\$\{"/);
  rejectsResolved({ type: "stdio", command: "${HOME}" }, /still contains "\$\{"/);
  rejectsResolved({ type: "stdio", command: "node", args: ["$${X}"] }, /missing or empty/);
  assert.deepEqual(resolveConnections(file, parseConnections(file, withConnection({ type: "stdio", command: "node", args: ["$${X}"] })), { X: "v" }).mcpServers.app,
    { type: "stdio", command: "node", args: ["$v"] });
});

test("literal secret-like values are rejected, and references after a key or Bearer are accepted", () => {
  rejectsResolved({ type: "http", url: "https://x", headers: { Authorization: "Bearer SENTINEL-LITERAL" } }, /secret-like literal/);
  rejectsResolved({ type: "http", url: "https://x?api_key=SENTINEL-LITERAL" }, /secret-like literal/);
  rejectsResolved({ type: "stdio", command: "node", env: { TOKEN: "ghp_abcdefghijklmnopqrstuvwx" } }, /secret-like literal/);
  rejectsResolved({ type: "stdio", command: "node", args: ["--password=SENTINEL-LITERAL"] }, /secret-like literal/);
  rejectsResolved({ type: "http", url: "https://x", headers: { Authorization: "Bearer SENTINEL-LITERAL${DOCS_API_KEY}" } }, /secret-like literal/);
  const resolved = resolveConnections(file, parseConnections(file, withConnection({
    type: "http", url: "https://x/mcp?api_key=${DOCS_API_KEY}", headers: { Authorization: "Bearer ${DOCS_API_KEY}" },
  })), env);
  assert.deepEqual(resolved.mcpServers.app, { type: "http", url: `https://x/mcp?api_key=${docsKey}`, headers: { Authorization: `Bearer ${docsKey}` } });
});

test("secret-like key and reference names are rejected without echoing them", () => {
  const sentinel = "ghp_SENTINELabcdefghijklmnop";
  const check = (action: () => unknown, reason: RegExp) => assert.throws(action, (error: unknown) => {
    assert.ok(error instanceof InvalidConnectionsError);
    assert.match(error.reason, reason);
    assert.equal(error.message.includes(sentinel), false, error.message);
    assert.equal(error.message.includes("SENTINEL"), false, error.message);
    return true;
  });
  check(() => parseConnections(file, withConnection({ type: "http", url: "https://x", headers: { [sentinel]: "Bearer x" } })), /headers has a secret-like key name/);
  check(() => parseConnections(file, withConnection({ type: "stdio", command: "node", env: { [sentinel]: "${MISSING}" } })), /env has a secret-like key name/);
  check(() => resolveConnections(file, parseConnections(file, withConnection({ type: "stdio", command: "node", env: { A: `\${${sentinel}}` } })), { [sentinel]: "v" }),
    /secret-like reference name/);
});

test("a secret-named key needs exactly one reference, optionally after one auth scheme word", () => {
  rejectsResolved({ type: "http", url: "https://x", headers: { Authorization: "rawTokenValue123" } }, /Authorization has a secret-like literal value/);
  rejectsResolved({ type: "http", url: "https://x", headers: { "X-Api-Key": "rawKeyValue" } }, /X-Api-Key has a secret-like literal value/);
  rejectsResolved({ type: "stdio", command: "node", env: { GITHUB_TOKEN: "rawTokenValue" } }, /GITHUB_TOKEN has a secret-like literal value/);
  rejectsResolved({ type: "http", url: "https://x", headers: { Authorization: "Bearer ${DOCS_API_KEY} extra" } }, /secret-like literal value/);
  const resolved = resolveConnections(file, parseConnections(file, JSON.stringify({ version: 1, connections: {
    gh: { type: "stdio", command: "node", env: { GITHUB_PERSONAL_ACCESS_TOKEN: "${GITHUB_TOKEN}" } },
    docs: { type: "http", url: "https://x", headers: { Authorization: "Bearer ${DOCS_API_KEY}", "X-Api-Key": "token ${DOCS_API_KEY}" } },
  } })), env);
  assert.deepEqual(resolved.mcpServers.gh, { type: "stdio", command: "node", env: { GITHUB_PERSONAL_ACCESS_TOKEN: token } });
  assert.deepEqual(resolved.mcpServers.docs, { type: "http", url: "https://x", headers: { Authorization: `Bearer ${docsKey}`, "X-Api-Key": `token ${docsKey}` } });
});

test("the loader refuses symlinks and non-regular files, and an absent file means no connections", async () => {
  const root = await mkdtemp(join(tmpdir(), "inoai-connections-"));
  try {
    const target = join(root, "target.json");
    await writeFile(target, JSON.stringify(validDocument));
    assert.deepEqual(await loadConnections(join(root, "connections.json")), []);
    assert.deepEqual(await loadResolvedConnections({ connectionsFile: join(root, "connections.json"), envFile: join(root, ".env") }),
      { connections: [], mcpServers: {}, allowedTools: [] });
    await symlink(target, join(root, "connections.json"));
    await assert.rejects(loadConnections(join(root, "connections.json")), (error: unknown) =>
      error instanceof InvalidConnectionsError && error.reason === "not a regular file");
    await rm(join(root, "connections.json"));
    await mkdir(join(root, "connections.json"));
    await assert.rejects(loadConnections(join(root, "connections.json")), /not a regular file/);
    await rm(join(root, "connections.json"), { recursive: true });
    await writeFile(join(root, "connections.json"), JSON.stringify(validDocument));
    await writeFile(join(root, ".env"), `# comment\nGITHUB_TOKEN=${token}\nDOCS_API_KEY = ${docsKey}\n`);
    const loaded = await loadResolvedConnections({ connectionsFile: join(root, "connections.json"), envFile: join(root, ".env") });
    assert.deepEqual(loaded.allowedTools, ["mcp__github__search_issues", "mcp__github__get_issue", "mcp__kg-demo"]);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("bootstrap does not create connections.json", async () => {
  const root = await mkdtemp(join(tmpdir(), "inoai-connections-bootstrap-"));
  try {
    const home = await bootstrapRuntimeHome(root, ".inoai-connect-test");
    assert.equal(home.connectionsFile, join(root, ".inoai-connect-test", "connections.json"));
    await assert.rejects(stat(home.connectionsFile), { code: "ENOENT" });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("connections validate and list work offline, print no values, and never open SQLite", async () => {
  const root = await mkdtemp(join(tmpdir(), "inoai-connections-cli-"));
  const entrypoint = join(process.cwd(), "dist", "index.js");
  const forbidden = [token, docsKey, "SENTINEL-COMMAND", "SENTINEL-ARG", "sentinel-url", "Bearer", "GITHUB_PERSONAL_ACCESS_TOKEN", "OTHER-ENV-VALUE"];
  const invoke = (...args: string[]) => execFile(process.execPath, [entrypoint, "connections", ...args], { cwd: root });
  try {
    const home = resolveRuntimeHome(root, ".inoai-connect-test");
    await mkdir(home.directory);
    for (const name of ["agent.md", "skills-enabled.json"]) await writeFile(join(home.directory, name), "");
    await writeFile(home.envFile, `GITHUB_TOKEN=${token}\nDOCS_API_KEY=${docsKey}\nDISCORD_BOT_TOKEN=OTHER-ENV-VALUE\n`);

    const none = await invoke("validate", "--connect-dir", ".inoai-connect-test");
    assert.match(none.stdout, /none/);
    assert.deepEqual(JSON.parse((await invoke("list", "--connect-dir", ".inoai-connect-test")).stdout), []);

    await writeFile(home.connectionsFile, JSON.stringify(validDocument));
    const validated = await invoke("validate", "--connect-dir", ".inoai-connect-test");
    assert.match(validated.stdout, /connections file is valid: .*connections\.json \(2 connections\)/);
    assert.match(validated.stderr, /Warning: connection "kg-demo" allows all of its tools/);
    assert.doesNotMatch(validated.stderr, /allows no tools/);
    const listed = await invoke("list", "--dir", home.directory);
    assert.deepEqual(JSON.parse(listed.stdout), [
      { name: "github", type: "stdio", allow: ["search_issues", "get_issue"] },
      { name: "kg-demo", type: "http", allow: "all" },
    ]);
    for (const output of [validated.stdout, validated.stderr, listed.stdout, listed.stderr]) {
      for (const value of forbidden) assert.equal(output.includes(value), false, `output leaked ${value}`);
    }

    await writeFile(home.connectionsFile, JSON.stringify({ version: 1, connections: { quiet: { type: "stdio", command: "node" }, empty: { type: "stdio", command: "node", allow: [] } } }));
    const noTools = await invoke("validate", "--connect-dir", ".inoai-connect-test");
    assert.match(noTools.stderr, /Warning: connection "quiet" allows no tools/);
    assert.match(noTools.stderr, /Warning: connection "empty" allows no tools/);

    await writeFile(home.connectionsFile, JSON.stringify({ version: 1, connections: { app: { type: "stdio", command: "node", env: { A: "${DISCORD_BOT_TOKEN}" } } } }));
    for (const operation of ["validate", "list"]) {
      await assert.rejects(invoke(operation, "--connect-dir", ".inoai-connect-test"), (error: Error & { stderr: string; code: number }) => {
        assert.equal(error.code, 1);
        assert.match(error.stderr, /Invalid connections file .*connections\.json: connection "app" env A refers to DISCORD_BOT_TOKEN, an inoai key/);
        assert.equal(error.stderr.includes("OTHER-ENV-VALUE"), false);
        return true;
      });
    }
    await assert.rejects(invoke("check", "--connect-dir", ".inoai-connect-test"), /Usage: inoai connections <validate\|list>/);
    await assert.rejects(execFile(process.execPath, [entrypoint, "connections", "list", "--connect-dir", ".inoai-connect-missing"], { cwd: root }), /Runtime home not found/);

    assert.deepEqual((await readdir(home.directory)).sort(), [".env", "agent.md", "connections.json", "skills-enabled.json"]);
    assert.deepEqual((await readdir(root)).sort(), [".inoai-connect-test"]);
  } finally { await rm(root, { recursive: true, force: true }); }
});
