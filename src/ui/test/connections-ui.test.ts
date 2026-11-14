import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { bootstrapRuntimeHome, type RuntimeHome } from "../../inoai/agent-instance/runtime-home.js";
import { createEvent, createSession, openDatabase, upsertUser } from "../../inoai/connectors/persistence/sqlite/legacy-database.js";
import { loadUiData, type UiConnections } from "../api/read-model.js";
import { renderAppShell } from "../pages/app-shell.js";

const token = "ab".repeat(32);
const envSecret = "s3cr3t-env-value-never-shown";
const literalUrl = "https://mcp.example.com/literal/mcp";
const connectionsText = JSON.stringify({ version: 1, connections: {
  github: { type: "stdio", command: "npx-github-server", args: ["--flag-arg"], env: { GITHUB_ENV_KEY: "${GITHUB_TOKEN}" }, allow: ["search_issues", "get_issue"] },
  docs: { type: "http", url: literalUrl, headers: { "X-Docs-Header": "Bearer ${DOCS_KEY}" }, allow: "all" },
  jira: { type: "http", url: "https://${JIRA_HOST}/mcp", allow: [] },
  notes: { type: "stdio", command: "notes-server", allow: ["read_note"] },
} });

// A temporary home with one Session for `provider`, a connections file, and an .env with real values.
async function tempHome(t: TestContext, provider: string | null, file: string | undefined, statuses: string[] = []): Promise<RuntimeHome> {
  const deploymentDirectory = await mkdtemp(join(tmpdir(), "inoai-ui-connections-"));
  t.after(async () => { await chmod(join(deploymentDirectory, ".inoai-connect-test", ".env"), 0o600).catch(() => {}); await rm(deploymentDirectory, { recursive: true, force: true }); });
  const home = await bootstrapRuntimeHome(deploymentDirectory, ".inoai-connect-test");
  if (file !== undefined) await writeFile(home.connectionsFile, file);
  await writeFile(home.envFile, `GITHUB_TOKEN=${envSecret}\nDOCS_KEY=${envSecret}\nJIRA_HOST=jira.example.com\n`);
  const database = openDatabase(home);
  try {
    if (provider !== null) {
      const owner = upsertUser(database, { transport: "discord", workspace_id: "guild", external_user_id: "owner", display_name: null, role: "owner", state: "active" })!;
      const session = createSession(database, { user_id: owner.id, transport: "discord", workspace_id: "guild", parent_conversation_id: "channel",
        conversation_id: "thread", initiating_external_message_id: "start", agent_provider: provider, agent_session_id: "session-1", project_path: deploymentDirectory });
      for (const detail of statuses) createEvent(database, { session_id: session.id, message_id: null, event_type: "connection_status", detail });
    }
  } finally { database.close(); }
  // The UI must never read .env: an unreadable .env must not change UI data.
  await chmod(home.envFile, 0o000);
  return home;
}

test("UI data holds only name, type, allow, and status, and no URL, command, header, env key, or .env value", async (t) => {
  const home = await tempHome(t, "claude", connectionsText, ["name=github status=failed", "name=github status=connected", "name=docs status=needs_auth", "name=jira status=weird"]);
  const data = await loadUiData(home);
  assert.deepEqual(data.connections, { state: "valid", list: [
    { name: "github", type: "stdio", allow: ["search_issues", "get_issue"], status: "connected" },
    { name: "docs", type: "http", allow: "all", status: "needs_auth" },
    { name: "jira", type: "http", allow: [], status: "unknown" },
    { name: "notes", type: "stdio", allow: ["read_note"], status: null },
  ] });
  for (const connection of data.connections.list) assert.deepEqual(Object.keys(connection).sort(), ["allow", "name", "status", "type"]);
  const json = JSON.stringify(data);
  for (const leak of [literalUrl, "mcp.example.com", "jira.example.com", "JIRA_HOST", "npx-github-server", "notes-server", "--flag-arg", "X-Docs-Header",
    "GITHUB_ENV_KEY", "GITHUB_TOKEN", "DOCS_KEY", "Bearer", envSecret]) {
    assert.equal(json.includes(leak), false, `UI data must not contain ${leak}`);
  }
});

test("a connection that has not been used yet has status null", async (t) => {
  const home = await tempHome(t, "claude", connectionsText);
  const { connections } = await loadUiData(home);
  assert.equal(connections.state, "valid");
  assert.deepEqual(connections.list.map((c) => c.status), [null, null, null, null]);
});

test("the connections state is absent, valid, invalid, or ignored", async (t) => {
  assert.deepEqual((await loadUiData(await tempHome(t, "claude", undefined))).connections, { state: "absent", list: [] });
  assert.deepEqual((await loadUiData(await tempHome(t, "claude", JSON.stringify({ version: 1, connections: {} })))).connections, { state: "valid", list: [] });
  // An invalid file gives no list and no error text from the file.
  const leakyInvalid = JSON.stringify({ version: 1, connections: { bad: { type: "stdio", command: "leaky-command", url: literalUrl, allow: "some" } } });
  for (const file of ["{ not json", leakyInvalid]) {
    const data = await loadUiData(await tempHome(t, "claude", file));
    assert.deepEqual(data.connections, { state: "invalid", list: [] });
    assert.doesNotMatch(JSON.stringify(data), /leaky-command|mcp\.example|not valid JSON/);
  }
  // A non-Claude home only checks that the file exists, even when it is invalid.
  for (const provider of ["codex", "opencode", "anthropic-api"]) {
    assert.deepEqual((await loadUiData(await tempHome(t, provider, "{ not json"))).connections, { state: "ignored", list: [] }, provider);
    assert.deepEqual((await loadUiData(await tempHome(t, provider, undefined))).connections, { state: "absent", list: [] }, provider);
  }
  // A home with no Session yet has an unknown provider and is read like a Claude home.
  assert.equal((await loadUiData(await tempHome(t, null, connectionsText))).connections.state, "valid");
});

// ---------- page ----------
const pageScript = (html: string) => html.split('<script type="module">')[1]?.split("</script>")[0] ?? "";
const connectionsSectionSource = () => {
  const script = pageScript(renderAppShell(token));
  const start = script.indexOf("// ---------- connections ----------");
  const end = script.indexOf("// ---------- end connections ----------");
  assert.ok(start > 0 && end > start, "page has a connections section");
  return script.slice(start, end);
};

// A tiny stand-in for DOM nodes. Strings stay strings, so a test can tell text from markup.
type Node = { tag: string; props: Record<string, any>; kids: Array<Node | string> };
const h = (tag: string, props: Record<string, any> = {}, ...kids: any[]): Node =>
  ({ tag, props, kids: kids.flat(Infinity).filter((kid) => kid != null && kid !== false).map((kid) => typeof kid === "object" ? kid : String(kid)) });
const rawText = (node: Node | string): string => typeof node === "string" ? node : node.kids.map(rawText).join(" ");
const text = (node: Node | string): string => rawText(node).replace(/\s+/g, " ").trim();
const all = (node: Node | string, match: (n: Node) => boolean): Node[] =>
  typeof node === "string" ? [] : [...(match(node) ? [node] : []), ...node.kids.flatMap((kid) => all(kid, match))];
const one = (node: Node, match: (n: Node) => boolean): Node | undefined => all(node, match)[0];
const row = (node: Node, name: string) => one(node, (n) => n.props["data-connection"] === name)!;
const rowNames = (node: Node) => all(node, (n) => n.props["data-connection"] !== undefined).map((n) => n.props["data-connection"] as string);
const pillOf = (node: Node) => one(node, (n) => n.props.class === "pill")!;
const body = (block: Node) => one(block, (n) => n.props["data-connections-body"] !== undefined)!;
const summary = (block: Node) => one(block, (n) => n.props["data-connections-summary"] !== undefined);
const toggle = (block: Node) => one(block, (n) => n.props["data-action"] === "toggle-connections")!;

// Runs the page's own connections section with stub helpers. A fetch call would throw.
function connectionsClient() {
  const state = { draws: 0 };
  const pageBody = { scrollTop: 0 };
  const document = { getElementById: (id: string) => id === "d-body" ? pageBody : null };
  const pill = (pillState: string, label = pillState) => h("span", { class: "pill", "data-state": pillState }, label);
  const empty = (label: string) => h("div", { class: "empty" }, label);
  const openDrawer = (key: string) => { assert.equal(key, "profile"); state.draws += 1; pageBody.scrollTop = 0; };
  const fetch = () => { throw new Error("the Connections block must not call the network"); };
  const client = new Function("h", "pill", "empty", "openDrawer", "openSection", "document", "fetch",
    `${connectionsSectionSource()}\nreturn { block: connectionsBlock, open: (value) => { connectionsOpen = value; } };`)(
    h, pill, empty, openDrawer, "profile", document, fetch) as { block: (v: { data: { connections: UiConnections } }) => Node; open: (value: boolean) => void };
  const view = (connections: UiConnections, open: boolean) => { client.open(open); return client.block({ data: { connections } }); };
  return { ...client, view, state, pageBody };
}

test("the live page renders the Connections block from view data, with no fixture code", () => {
  const script = pageScript(renderAppShell(token));
  assert.doesNotThrow(() => new Function(`return async () => {${script}}`), "page script must parse");
  assert.match(script, /\n {4}roleBlock\(v\),\n {4}connectionsBlock\(v\),\n {4}markdown\(v\.data\.agentMarkdown\)\] \}\),/, "the block sits below the Role block");
  assert.match(script, /connections: \{ state: 'absent', list: \[\] \}/, "an older server without connections reads as an empty list");
  assert.equal(/CONNECTION_FIXTURES|connections-fixture|data-scenario|fixture|prototype|Fixture scenario/i.test(script), false, "no fixture or prototype code remains");
  const section = connectionsSectionSource();
  assert.equal(/fetch\(|\/api\//.test(section), false, "the section makes no network calls");
  assert.equal(/innerHTML|outerHTML|insertAdjacentHTML|document\.write/.test(section), false, "the section never parses HTML");
  assert.equal(/\.(command|args|url|headers|env)\b/.test(section), false, "the section reads no command, args, url, headers, or env");
});

test("the block renders live connections from the read model of a temporary home", async (t) => {
  const home = await tempHome(t, "claude", connectionsText, ["name=github status=connected", "name=docs status=failed", "name=jira status=needs_auth"]);
  const { connections } = await loadUiData(home);
  const client = connectionsClient();
  const collapsed = client.view(connections, false);
  assert.equal(collapsed.props["data-connections-block"], "valid");
  assert.equal(toggle(collapsed).props["aria-expanded"], "false");
  assert.match(text(toggle(collapsed)), /^› Connections 4 connections$/);
  assert.equal(text(summary(collapsed)!), "1 connected, 1 failed, 1 needs auth, 1 not used yet");
  assert.equal(body(collapsed).props.hidden, "");

  const block = client.view(connections, true);
  assert.equal(summary(block), undefined);
  assert.equal(body(block).props.hidden, undefined);
  assert.deepEqual(rowNames(block), ["github", "docs", "jira", "notes"]);
  const expected: Record<string, [string, string, string, string]> = {
    github: ["stdio", "Tools: search_issues, get_issue", "active", "connected"],
    docs: ["http", "Tools: all tools", "failed", "failed"],
    jira: ["http", "Tools: no tools", "pending", "needs auth"],
    notes: ["stdio", "Tools: read_note", "not-used", "not used yet"],
  };
  for (const [name, [type, allow, state, label]] of Object.entries(expected)) {
    const item = row(block, name);
    assert.equal(text(one(item, (n) => n.props["data-type"] !== undefined)!), type, `${name} type`);
    assert.equal(text(one(item, (n) => n.props["data-allow"] !== undefined)!), allow, `${name} allow`);
    assert.equal(pillOf(item).props["data-state"], state, `${name} pill state`);
    assert.equal(text(pillOf(item)), label, `${name} pill label`);
  }
  assert.equal(all(block, (n) => n.tag === "button" && n.props["data-action"] !== "toggle-connections").length, 0, "the block has no write controls");
  assert.doesNotMatch(text(block), /npx|notes-server|mcp\.example|Bearer|GITHUB_TOKEN|DOCS_KEY|s3cr3t/);
});

test("the block renders the absent, empty, invalid, and ignored states; an invalid file stays collapsed", () => {
  const client = connectionsClient();
  const cases: Array<[UiConnections["state"], string, RegExp]> = [
    ["absent", "None", /^No connections\.json in this runtime home$/],
    ["valid", "None", /^connections\.json has no connections$/],
    ["invalid", "Invalid connections.json", /^connections\.json is invalid\. Turns fail until you fix it\. Run inoai connections validate\.$/],
    ["ignored", "Ignored (Claude only)", /^connections\.json is ignored\. Connections work only on Claude homes in this version\.$/],
  ];
  for (const [state, collapsedText, message] of cases) {
    const collapsed = client.view({ state, list: [] }, false);
    assert.equal(collapsed.props["data-connections-block"], state);
    assert.equal(toggle(collapsed).props["aria-expanded"], "false", `${state} starts collapsed`);
    assert.equal(text(summary(collapsed)!), collapsedText, state);
    const block = client.view({ state, list: [] }, true);
    assert.deepEqual(rowNames(block), [], `${state} has no rows`);
    assert.match(text(one(block, (n) => n.props["data-connections-empty"] !== undefined)!), message, state);
    assert.match(text(toggle(block)), /0 connections$/);
  }
});

test("the toggle re-renders the profile and keeps the scroll position", () => {
  const client = connectionsClient();
  const data = { data: { connections: { state: "valid" as const, list: [{ name: "github", type: "stdio" as const, allow: ["search_issues"], status: "connected" as const }] } } };
  client.open(false);
  client.pageBody.scrollTop = 120;
  toggle(client.block(data)).props.onclick();
  assert.equal(client.state.draws, 1);
  assert.equal(client.pageBody.scrollTop, 120);
  assert.equal(toggle(client.block(data)).props["aria-expanded"], "true");
});
