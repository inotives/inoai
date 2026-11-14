import assert from "node:assert/strict";
import test from "node:test";
import { connectionFixtures, type FixtureConnections } from "../pages/connection-fixtures.js";
import { renderAppShell } from "../pages/app-shell.js";

// FIXTURE PROTOTYPE tests (IP-0009 T-0005). T-0006 replaces them when it binds live data.

const token = "ab".repeat(32);
const pageScript = (html: string) => html.split('<script type="module">')[1]?.split("</script>")[0] ?? "";
const connectionsSectionSource = () => {
  const script = pageScript(renderAppShell(token));
  const start = script.indexOf("// ---------- connections (fixture prototype) ----------");
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
function connectionsClient(fixtures: Record<string, FixtureConnections> = connectionFixtures) {
  const state = { draws: 0 };
  const pageBody = { scrollTop: 0 };
  const document = { getElementById: (id: string) => id === "d-body" ? pageBody : null };
  const pill = (pillState: string, label = pillState) => h("span", { class: "pill", "data-state": pillState }, label);
  const empty = (label: string) => h("div", { class: "empty" }, label);
  const openDrawer = (key: string) => { assert.equal(key, "profile"); state.draws += 1; pageBody.scrollTop = 0; };
  const fetch = () => { throw new Error("the connections prototype must not call the network"); };
  const client = new Function("CONNECTION_FIXTURES", "h", "pill", "empty", "openDrawer", "openSection", "document", "fetch",
    `${connectionsSectionSource()}\nreturn { block: connectionsBlock, scenario: (key) => { connectionScenario = key; }, open: (value) => { connectionsOpen = value; } };`)(
    fixtures, h, pill, empty, openDrawer, "profile", document, fetch) as { block: () => Node; scenario: (key: string) => void; open: (value: boolean) => void };
  const view = (key: string, open: boolean) => { client.scenario(key); client.open(open); return client.block(); };
  return { ...client, view, state, pageBody };
}

test("the page shows the Connections block only behind the ?connections-fixture switch, below the Role block", () => {
  const html = renderAppShell(token);
  const script = pageScript(html);
  assert.doesNotThrow(() => new Function(`return async () => {${script}}`), "page script must parse");
  assert.match(script, /const CONNECTION_FIXTURES = new URLSearchParams\(location\.search\)\.has\('connections-fixture'\) \? \{.*\} : null;\n/);
  assert.match(script, /\n {4}roleBlock\(v\),\n {4}CONNECTION_FIXTURES \? connectionsBlock\(\) : null,\n {4}markdown\(v\.data\.agentMarkdown\)\] \}\),/);
  const embedded = /const CONNECTION_FIXTURES = new URLSearchParams\(location\.search\)\.has\('connections-fixture'\) \? (.*) : null;\n/.exec(script)?.[1];
  assert.deepEqual(JSON.parse(embedded!), connectionFixtures, "the embedded fixtures round-trip");
  const section = connectionsSectionSource();
  assert.equal(/fetch\(|\/api\//.test(section), false, "the section makes no network calls");
  assert.equal(/innerHTML|outerHTML|insertAdjacentHTML|document\.write/.test(section), false, "the section never parses HTML");
  assert.equal(/\.(command|args|url|headers|env)\b/.test(section), false, "the section reads no command, args, url, headers, or env");
});

test("the fixtures cover every state and hold only name, type, allow, and status", () => {
  const list = Object.values(connectionFixtures).flatMap((fixture) => fixture.list);
  for (const connection of list) assert.deepEqual(Object.keys(connection).sort(), ["allow", "name", "status", "type"]);
  for (const status of ["connected", "failed", "needs_auth", "unknown", null]) assert.ok(list.some((c) => c.status === status), `status ${status}`);
  assert.ok(list.some((c) => c.allow === "all"));
  assert.ok(list.some((c) => Array.isArray(c.allow) && c.allow.length === 0));
  assert.ok(list.some((c) => c.type === "stdio") && list.some((c) => c.type === "http"));
  for (const file of ["absent", "valid", "invalid", "ignored"]) assert.ok(Object.values(connectionFixtures).some((f) => f.file === file), `file ${file}`);
  assert.doesNotMatch(JSON.stringify(connectionFixtures), /command|args|url|headers|env|Bearer|\$\{|https?:/i);
});

test("collapsed, the block shows the count and a status summary, and hides the rows", () => {
  const client = connectionsClient();
  const block = client.view("mixed", false);
  assert.equal(block.props.class, "setting");
  assert.equal(toggle(block).props["aria-expanded"], "false");
  assert.equal(toggle(block).props.class, "setting-head");
  assert.match(text(toggle(block)), /^› Connections 5 connections$/);
  assert.equal(text(summary(block)!), "2 connected, 1 failed, 1 needs auth, 1 not used yet");
  assert.equal(body(block).props.hidden, "");
  assert.equal(text(summary(client.view("connected", false))!), "2 connected");
  assert.equal(text(summary(client.view("failed", false))!), "1 failed");
  assert.match(text(toggle(client.view("failed", false))), /1 connection$/);
  assert.equal(text(summary(client.view("not used yet", false))!), "2 not used yet");
  assert.equal(text(summary(client.view("unknown", false))!), "1 unknown");
  for (const key of ["empty file", "no file"]) assert.equal(text(summary(client.view(key, false))!), "None");
  assert.equal(text(summary(client.view("invalid file", false))!), "Invalid connections.json");
  assert.equal(text(summary(client.view("not claude", false))!), "Ignored (Claude only)");
});

test("expanded, each row shows the name, type, allow list, and status pill", () => {
  const client = connectionsClient();
  const block = client.view("mixed", true);
  assert.equal(toggle(block).props["aria-expanded"], "true");
  assert.equal(summary(block), undefined);
  assert.equal(body(block).props.hidden, undefined);
  assert.deepEqual(rowNames(block), ["github", "docs", "jira", "kg-demo", "notes"]);
  const expected: Record<string, [string, string, string, string]> = {
    github: ["stdio", "Tools: search_issues, get_issue", "active", "connected"],
    docs: ["http", "Tools: all tools", "active", "connected"],
    jira: ["http", "Tools: no tools", "failed", "failed"],
    "kg-demo": ["http", "Tools: search_grid, get_page, list_pages", "pending", "needs auth"],
    notes: ["stdio", "Tools: read_note", "not-used", "not used yet"],
  };
  for (const [name, [type, allow, state, label]] of Object.entries(expected)) {
    const item = row(block, name);
    assert.equal(text(one(item, (n) => n.props["data-type"] !== undefined)!), type, `${name} type`);
    assert.equal(text(one(item, (n) => n.props["data-allow"] !== undefined)!), allow, `${name} allow`);
    assert.equal(pillOf(item).props["data-state"], state, `${name} pill state`);
    assert.equal(text(pillOf(item)), label, `${name} pill label`);
  }
  assert.equal(text(pillOf(row(client.view("unknown", true), "github"))), "unknown");
  assert.equal(text(one(row(client.view("allow all", true), "docs"), (n) => n.props["data-allow"] !== undefined)!), "Tools: all tools");
  assert.equal(text(one(row(client.view("allow none", true), "jira"), (n) => n.props["data-allow"] !== undefined)!), "Tools: no tools");
  assert.equal(text(pillOf(row(client.view("needs auth", true), "kg-demo"))), "needs auth");
});

test("expanded empty states explain no file, an empty file, an invalid file, and a non-Claude home", () => {
  const client = connectionsClient();
  const cases: Record<string, [string, RegExp]> = {
    "no file": ["absent", /^No connections\.json in this runtime home$/],
    "empty file": ["valid", /^connections\.json has no connections$/],
    "invalid file": ["invalid", /^connections\.json is invalid\. Turns fail until you fix it\. Run inoai connections validate\.$/],
    "not claude": ["ignored", /^connections\.json is ignored\. Connections work only on Claude homes in this version\.$/],
  };
  for (const [key, [file, message]] of Object.entries(cases)) {
    const block = client.view(key, true);
    assert.equal(block.props["data-connections-block"], file);
    assert.deepEqual(rowNames(block), [], `${key} has no rows`);
    assert.match(text(one(block, (n) => n.props["data-connections-empty"] !== undefined)!), message, key);
    assert.match(text(toggle(block)), /0 connections$/);
  }
});

test("the toggle and the fixture switch re-render the profile and keep the scroll position", () => {
  const client = connectionsClient();
  client.scenario("mixed");
  client.open(false);
  client.pageBody.scrollTop = 120;
  toggle(client.block()).props.onclick();
  assert.equal(client.state.draws, 1);
  assert.equal(client.pageBody.scrollTop, 120);
  assert.equal(toggle(client.block()).props["aria-expanded"], "true");
  const switches = all(client.block(), (n) => n.props["data-scenario"] !== undefined);
  assert.deepEqual(switches.map((n) => n.props["data-scenario"]), Object.keys(connectionFixtures));
  assert.equal(one(client.block(), (n) => n.props["aria-label"] === "Fixture scenario") !== undefined, true);
  assert.match(text(one(client.block(), (n) => n.props["aria-label"] === "Fixture scenario")!), /^Fixture prototype:/);
  assert.equal(switches.find((n) => n.props["data-scenario"] === "mixed")!.props["aria-pressed"], "true");
  switches.find((n) => n.props["data-scenario"] === "invalid file")!.props.onclick();
  assert.equal(client.state.draws, 2);
  assert.equal(client.block().props["data-connections-block"], "invalid");
  assert.equal(all(client.block(), (n) => n.tag === "button" && n.props["data-action"] !== undefined && n.props["data-action"] !== "toggle-connections").length, 0,
    "the block has no write controls");
});

test("the block never shows command, args, url, headers, env, or secret values", () => {
  const leaky: Record<string, FixtureConnections> = { leaky: { file: "valid", list: [
    Object.assign({ name: "github", type: "stdio" as const, allow: ["search_issues"], status: "connected" as const },
      { command: "npx", args: ["server-github"], env: { TOKEN: "s3cr3t-value" }, url: "https://mcp.example.com", headers: { Authorization: "Bearer s3cr3t-value" } }),
  ] } };
  const client = connectionsClient(leaky);
  for (const open of [false, true]) {
    const shown = text(client.view("leaky", open));
    assert.doesNotMatch(shown, /npx|server-github|s3cr3t|mcp\.example|Bearer|TOKEN|Authorization/);
  }
});
