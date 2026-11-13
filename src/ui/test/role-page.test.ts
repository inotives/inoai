import assert from "node:assert/strict";
import { request } from "node:http";
import test from "node:test";
import type { UiRoles } from "../api/read-model.js";
import { renderAppShell } from "../pages/app-shell.js";
import { roleFixtures } from "../pages/role-fixtures.js";
import { launchRolePreview } from "../role-preview.js";

const token = "ab".repeat(32);
const pageScript = (html: string) => html.split('<script type="module">')[1]?.split("</script>")[0] ?? "";

// A tiny stand-in for DOM nodes. Strings stay strings, so a test can tell text from markup.
type Node = { tag: string; props: Record<string, any>; kids: Array<Node | string> };
const h = (tag: string, props: Record<string, any> = {}, ...kids: any[]): Node =>
  ({ tag, props, kids: kids.flat(Infinity).filter((kid) => kid != null && kid !== false).map((kid) => typeof kid === "object" ? kid : String(kid)) });
const rawText = (node: Node | string): string => typeof node === "string" ? node : node.kids.map(rawText).join(" ");
const text = (node: Node | string): string => rawText(node).replace(/\s+/g, " ").trim();
const all = (node: Node | string, test: (n: Node) => boolean): Node[] =>
  typeof node === "string" ? [] : [...(test(node) ? [node] : []), ...node.kids.flatMap((kid) => all(kid, test))];

type RoleClient = {
  setRoleScenario: (key: string) => void;
  roleBlock: () => Node;
  equippedRole: () => { kind: string };
  applyRoleReply: (reply: { role: unknown }) => void;
  state: () => UiRoles;
  search: { query: string; option: string };
};
type SearchArgs = { state: { query: string; option: string }; items: any[]; options: string[]; key: (x: any) => string; text: (x: any) => string; render: (x: any) => Node; placeholder: string };

// Runs the page's own roles section with stub helpers. The searchable stub applies the
// same filter as the page helper without DOM calls. A fetch call would throw.
function roleClient(fixtures: Record<string, UiRoles>) {
  const script = pageScript(renderAppShell(token, fixtures));
  const start = script.indexOf("// ---------- roles (fixture prototype)");
  const end = script.indexOf("// ---------- end roles ----------");
  assert.ok(start > 0 && end > start, "page has a roles section");
  let rerenders = 0;
  const searches: SearchArgs[] = [];
  const pill = (state: string, label = state) => h("span", { class: "pill", "data-state": state }, label);
  const empty = (label: string) => h("div", { class: "empty" }, label);
  const icon = (key: string) => h("i", { "data-icon": key });
  const openDrawer = (key: string) => { assert.equal(key, "profile"); rerenders += 1; };
  const searchable = (args: SearchArgs) => {
    searches.push(args);
    const query = args.state.query.trim().toLowerCase();
    const rows = args.items.filter((x) => (args.state.option === "all" || args.key(x) === args.state.option) && (!query || args.text(x).toLowerCase().includes(query)));
    return h("div", { "data-search": args.placeholder }, h("input", { type: "search" }), rows.length ? rows.map(args.render) : empty("No matches"));
  };
  const fetch = () => { throw new Error("the roles prototype must not call the network"); };
  const client = new Function("ROLE_FIXTURES", "h", "pill", "empty", "icon", "openDrawer", "searchable", "fetch",
    `${script.slice(start, end)}\nreturn { setRoleScenario, roleBlock, equippedRole, applyRoleReply, state: () => roleState, search: roleSearch };`)(
    fixtures, h, pill, empty, icon, openDrawer, searchable, fetch) as RoleClient;
  return { ...client, rerenders: () => rerenders, searches };
}

const buttons = (node: Node, action: string) => all(node, (n) => n.tag === "button" && n.props["data-action"] === action);
const roleRow = (node: Node, id: string) => all(node, (n) => n.props["data-role"] === id)[0]!;
const rowIds = (node: Node) => all(node, (n) => n.props["data-role"] !== undefined).map((n) => n.props["data-role"] as string);
const click = (button: Node) => button.props.onclick();

test("the live page has no role prototype; the preview page embeds the fixtures safely and adds no Roles tab", () => {
  const live = renderAppShell(token);
  assert.match(live, /const ROLE_FIXTURES = null;/);
  assert.equal(live.includes("onerror=alert"), false, "the live page carries no fixture data");
  assert.match(pageScript(live), /ROLE_FIXTURES \? roleBlock\(\) : null/, "the Role block is added only with fixtures");

  const html = renderAppShell(token, roleFixtures);
  const script = pageScript(html);
  assert.doesNotThrow(() => new Function(`return async () => {${script}}`), "page script must parse");
  assert.equal(/innerHTML|outerHTML|insertAdjacentHTML|document\.write/.test(script), false, "the page never parses HTML from data");
  assert.equal(html.includes("</script><script>alert"), false, "fixture text cannot close the script element");
  assert.equal(html.includes("<img src=x"), false, "fixture markup is not in the page as markup");
  const embedded = /const ROLE_FIXTURES = (.*);\n/.exec(script)?.[1];
  assert.deepEqual(JSON.parse(embedded!), roleFixtures, "the embedded fixtures round-trip");
  assert.equal(/roles: '|roles: \(|openDrawer\('roles'/.test(script), false, "there is no Roles drawer section or rail icon");
  const section = script.slice(script.indexOf("// ---------- roles (fixture"), script.indexOf("// ---------- end roles"));
  assert.equal(/fetch\(|\/api\/role/.test(section), false, "the roles section makes no network calls");
  assert.equal(/'viewer'|role\.text/.test(section), false, "the Role block has no role text preview");
});

test("Role block renders the equipped state with Unequip, Equip on other valid roles, and no Equip on invalid roles", () => {
  const client = roleClient(roleFixtures);
  client.setRoleScenario("equipped");
  const block = client.roleBlock();
  assert.equal(block.props["data-role-block"], "valid");
  const card = all(block, (n) => n.props["data-equipped"] === "valid")[0]!;
  assert.match(text(card), /Planner · planner Turn a goal into a clear, ordered plan/);
  assert.equal(buttons(card, "unequip").length, 1);
  assert.equal(client.searches.length, 1);
  assert.deepEqual(client.searches[0]!.options, ["all", "valid", "invalid"]);
  assert.deepEqual(rowIds(block), ["bad_name", "broken", "designer", "leaky", "markup", "planner"]);
  const planner = roleRow(block, "planner");
  assert.match(text(planner), /equipped/);
  assert.equal(buttons(planner, "equip").length, 0, "the equipped role has no Equip");
  assert.equal(buttons(roleRow(block, "designer"), "equip").length, 1);
  for (const id of ["broken", "leaky", "bad_name"]) {
    const row = roleRow(block, id);
    assert.equal(buttons(row, "equip").length, 0, `${id} has no Equip`);
    assert.equal(all(row, (n) => n.props["data-state"] === "failed").length, 1, `${id} is marked invalid`);
  }
  assert.match(text(roleRow(block, "broken")), /Invalid: missing or empty '## Instructions' section/);
  assert.match(text(roleRow(block, "leaky")), /Invalid: secret-like text/);
});

test("Role block renders not-equipped, equipped-invalid, equipped-missing, and empty-list states", () => {
  const client = roleClient(roleFixtures);
  client.setRoleScenario("not equipped");
  let block = client.roleBlock();
  assert.equal(block.props["data-role-block"], "none");
  assert.match(text(block), /No role equipped\. The agent uses agent\.md only\./);
  assert.equal(buttons(block, "unequip").length, 0);
  assert.equal(buttons(block, "equip").length, 3, "every valid role can be equipped");

  client.setRoleScenario("equipped invalid");
  block = client.roleBlock();
  assert.equal(client.equippedRole().kind, "invalid");
  assert.equal(all(block, (n) => n.props["data-equipped"] === "invalid").length, 1);
  assert.match(text(block), /broken is equipped but is invalid: missing or empty '## Instructions' section\./);
  assert.equal(buttons(block, "unequip").length, 1, "an invalid equipped role can be unequipped");
  assert.equal(buttons(roleRow(block, "broken"), "equip").length, 0);

  client.setRoleScenario("equipped missing");
  block = client.roleBlock();
  assert.equal(all(block, (n) => n.props["data-equipped"] === "missing").length, 1);
  assert.match(text(block), /reviewer is equipped but is missing from roles\//);
  assert.equal(rowIds(block).includes("reviewer"), false, "a missing role is not listed");
  assert.equal(buttons(block, "unequip").length, 1);

  client.setRoleScenario("empty");
  block = client.roleBlock();
  assert.equal(all(block, (n) => n.props.class === "empty" && text(n) === "No role files in roles/").length, 1);
  assert.equal(all(block, (n) => n.props["data-search"] !== undefined).length, 0, "an empty list has no search box");
});

test("the role search filters by id, name, and summary, and by validity", () => {
  const client = roleClient(roleFixtures);
  client.setRoleScenario("not equipped");
  client.search.query = "PLAN";
  assert.deepEqual(rowIds(client.roleBlock()), ["planner"], "matches the id and name");
  client.search.query = "screens and flows";
  assert.deepEqual(rowIds(client.roleBlock()), ["designer"], "matches the summary");
  client.search.query = "secret-like";
  assert.deepEqual(rowIds(client.roleBlock()), [], "does not match the invalid reason");
  client.search.query = "";
  client.search.option = "invalid";
  assert.deepEqual(rowIds(client.roleBlock()), ["bad_name", "broken", "leaky"]);
  client.search.option = "all";
});

test("Equip and Unequip change only local fixture state", () => {
  const client = roleClient(roleFixtures);
  client.setRoleScenario("not equipped");
  click(buttons(roleRow(client.roleBlock(), "designer"), "equip")[0]!);
  assert.equal(client.state().equipped, "designer");
  let block = client.roleBlock();
  assert.match(text(block), /Equipped Designer \(designer\)\. Fixture only; nothing was saved\./);
  assert.equal(buttons(roleRow(block, "designer"), "equip").length, 0);

  click(buttons(block, "unequip")[0]!);
  assert.equal(client.state().equipped, null);
  assert.match(text(client.roleBlock()), /Role unequipped/);
  assert.equal(client.rerenders(), 2, "each button re-renders the profile drawer");

  client.setRoleScenario("equipped");
  assert.equal(client.state().equipped, "planner", "switching scenarios resets the local state");
  assert.equal(roleFixtures["not equipped"]!.equipped, null, "fixtures are not mutated");
});

test("an equip reply with valid: false shows the role as equipped and invalid", () => {
  const client = roleClient(roleFixtures);
  client.setRoleScenario("not equipped");
  client.applyRoleReply({ role: { id: "planner", name: null, summary: null, valid: false, reason: "secret-like text" } });
  assert.equal(client.equippedRole().kind, "invalid");
  const block = client.roleBlock();
  assert.match(text(block), /Equipped planner, but it is invalid: secret-like text/);
  assert.equal(buttons(roleRow(block, "planner"), "equip").length, 0);
  assert.equal(buttons(block, "unequip").length, 1);
});

test("role names and summaries stay plain text", () => {
  const client = roleClient(roleFixtures);
  client.setRoleScenario("not equipped");
  const strings = (node: Node | string): string[] => typeof node === "string" ? [node] : node.kids.flatMap(strings);
  const values = strings(roleRow(client.roleBlock(), "markup"));
  assert.ok(values.includes("<img src=x onerror=alert(1)>"), "the name is one text value");
  assert.ok(values.includes(" · Summary with </script><script>alert(2)</script> & \"quotes\"."), "the summary is one text value");
});

function get(port: number, path: string, host = `127.0.0.1:${port}`, method = "GET"): Promise<{ status: number; type: string; body: string }> {
  return new Promise((resolve, reject) => {
    const outgoing = request({ host: "127.0.0.1", port, path, method, headers: { host } }, (reply) => {
      let body = "";
      reply.setEncoding("utf8");
      reply.on("data", (chunk) => { body += chunk; });
      reply.on("end", () => resolve({ status: reply.statusCode ?? 0, type: String(reply.headers["content-type"]), body }));
    });
    outgoing.on("error", reject);
    outgoing.end();
  });
}

test("the role preview server serves the fixture page on loopback and has no write routes", async () => {
  const preview = await launchRolePreview(0);
  try {
    const address = preview.server.address();
    assert.equal(typeof address === "object" && address?.address, "127.0.0.1");
    const page = await get(preview.port, "/");
    assert.equal(page.status, 200);
    assert.match(page.type, /text\/html/);
    assert.match(page.body, /const ROLE_FIXTURES = \{/);
    const data = await get(preview.port, "/api/ui-data");
    assert.equal(data.status, 200);
    assert.equal(JSON.parse(data.body).profile.agentInstanceId, "inoai-connect-role-preview");
    assert.equal((await get(preview.port, "/", "evil.example:80")).status, 403);
    assert.equal((await get(preview.port, "/api/role/equip", undefined, "POST")).status, 404);
    assert.equal((await get(preview.port, "/api/tasks", undefined, "POST")).status, 404);
    assert.equal((await get(preview.port, "/api/ui-data", undefined, "POST")).status, 405);
  } finally {
    await new Promise((resolve) => preview.server.close(resolve));
  }
});
