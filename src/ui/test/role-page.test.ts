import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { bootstrapRuntimeHome } from "../../inoai/agent-instance/runtime-home.js";
import { openDatabase } from "../../inoai/connectors/persistence/sqlite/legacy-database.js";
import { loadUiData, type UiRoles } from "../api/read-model.js";
import { renderAppShell } from "../pages/app-shell.js";
import { roleFixture } from "./role-fixtures.js";

const token = "ab".repeat(32);
const pageScript = (html: string) => html.split('<script type="module">')[1]?.split("</script>")[0] ?? "";
const roleSectionSource = () => {
  const script = pageScript(renderAppShell(token));
  const start = script.indexOf("// ---------- roles ----------");
  const end = script.indexOf("// ---------- end roles ----------");
  assert.ok(start > 0 && end > start, "page has a roles section");
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
const buttons = (node: Node, action: string) => all(node, (n) => n.tag === "button" && n.props["data-action"] === action);
const roleRow = (node: Node, id: string) => all(node, (n) => n.props["data-role"] === id)[0]!;
const rowIds = (node: Node) => all(node, (n) => n.props["data-role"] !== undefined).map((n) => n.props["data-role"] as string);

type SearchArgs = { state: { query: string; option: string }; items: any[]; options: string[]; key: (x: any) => string; text: (x: any) => string; render: (x: any) => Node };
type FetchCall = { url: string; method: string; headers: Record<string, string>; body: string };
type Reply = { status: number; body?: unknown };

// Runs the page's own roles section with stub helpers. The searchable stub applies the same
// filter as the page helper without DOM calls. `replies` answer fetch calls in order, and
// `reloadTo` is the data a refresh loads.
function roleClient(roles: UiRoles, options: { replies?: Reply[]; reloadTo?: () => UiRoles; pageToken?: string } = {}) {
  const view = { data: { roles } };
  const calls: FetchCall[] = [];
  const replies = [...(options.replies ?? [])];
  const state = { reloads: 0, draws: 0 };
  const body = { scrollTop: 0 };
  const document = { getElementById: (id: string) => id === "d-body" ? body : null };
  const pill = (pillState: string, label = pillState) => h("span", { class: "pill", "data-state": pillState }, label);
  const empty = (label: string) => h("div", { class: "empty" }, label);
  const searchable = (args: SearchArgs) => {
    const query = args.state.query.trim().toLowerCase();
    const rows = args.items.filter((x) => (args.state.option === "all" || args.key(x) === args.state.option) && (!query || args.text(x).toLowerCase().includes(query)));
    return h("div", { "data-search": "roles" }, h("input", { type: "search" }), rows.length ? rows.map(args.render) : empty("No matches"));
  };
  // A re-render resets the scroll, as replaceChildren does in the page.
  const openDrawer = (key: string) => { assert.equal(key, "profile"); state.draws += 1; body.scrollTop = 0; };
  const reloadView = async () => { state.reloads += 1; if (options.reloadTo) view.data = { roles: options.reloadTo() }; };
  const fetch = async (url: string, init: any) => {
    calls.push({ url, method: init.method, headers: init.headers, body: init.body });
    const reply = replies.shift();
    if (!reply) throw new TypeError("network down");
    return new Response(JSON.stringify(reply.body ?? {}), { status: reply.status, headers: { "content-type": "application/json" } });
  };
  const client = new Function("view", "h", "pill", "empty", "searchable", "openDrawer", "openSection", "document", "fetch", "uiToken", "TOKEN_HEADER", "reloadView",
    `${roleSectionSource()}\nreturn { roleBlock: () => roleBlock(view), changeRole, applyRoleReply, equippedRole: () => equippedRole(view.data.roles), note: () => roleNote, busy: () => roleBusy, search: roleSearch };`)(
    view, h, pill, empty, searchable, openDrawer, "profile", document, fetch, () => options.pageToken ?? token, "x-inoai-token", reloadView) as {
    roleBlock: () => Node; changeRole: (action: string, id?: string) => Promise<void>; applyRoleReply: (reply: { role: unknown }) => void;
    equippedRole: () => { kind: string }; note: () => { error: boolean; text: string; retry: unknown } | null; busy: () => boolean; search: { query: string; option: string };
  };
  return { ...client, view, calls, state, body };
}

test("the live page shows the Role block in the profile, with no fixture, preview, or Roles tab code", () => {
  const html = renderAppShell(token);
  const script = pageScript(html);
  assert.doesNotThrow(() => new Function(`return async () => {${script}}`), "page script must parse");
  assert.match(script, /h\('dt', \{\}, 'Storage'\), h\('dd', \{\}, 'SQLite · read-only'\)\),\n {4}roleBlock\(v\),/, "the profile renders the Role block");
  assert.match(script, /roles: \{ equipped: null, list: \[\] \}/, "an older server without roles reads as an empty list");
  assert.equal(/ROLE_FIXTURES|fixture|prototype|Fixture scenario/i.test(script), false, "no fixture or prototype paths remain");
  assert.equal(/roles: '|openDrawer\('roles'/.test(script), false, "there is no Roles drawer section or rail icon");
  assert.equal(/innerHTML|outerHTML|insertAdjacentHTML|document\.write/.test(script), false, "the page never parses HTML from data");
  assert.equal(/\.text\b/.test(roleSectionSource().replace(/args\.text|text: roleSearchText|roleNote\.text|result\.text/g, "")), false, "the Role block reads no role text");
});

test("the Role block renders live roles from the read model of a temporary home", async (t) => {
  const deploymentDirectory = await mkdtemp(join(tmpdir(), "inoai-ui-role-page-"));
  t.after(() => rm(deploymentDirectory, { recursive: true, force: true }));
  const home = await bootstrapRuntimeHome(deploymentDirectory, ".inoai-connect-test");
  const database = openDatabase(home);
  database.exec("INSERT INTO role_equips (role_id, equipped_by, created_by, updated_by) VALUES ('reviewer', 'cli:owner', 'cli:owner', 'cli:owner')");
  database.close();
  await writeFile(join(home.rolesDirectory, "broken.md"), "# Role: Broken\n");

  const { roles } = await loadUiData(home);
  for (const role of roles.list) assert.equal("text" in role, false, `${role.id} has no text in UI data`);
  const client = roleClient(roles);
  const block = client.roleBlock();
  assert.equal(block.props["data-role-block"], "valid");
  assert.match(text(all(block, (n) => n.props["data-equipped"] === "valid")[0]!), /^Reviewer · reviewer /);
  assert.deepEqual(rowIds(block), roles.list.map((role) => role.id));
  assert.ok(rowIds(block).includes("planner"));
  assert.equal(buttons(roleRow(block, "reviewer"), "equip").length, 0, "the equipped role has no Equip");
  assert.equal(buttons(roleRow(block, "planner"), "equip").length, 1);
  assert.equal(buttons(roleRow(block, "broken"), "equip").length, 0, "an invalid role has no Equip");
  assert.match(text(roleRow(block, "broken")), /Invalid: /);
});

test("the Role block renders equipped, not-equipped, invalid, missing, and empty states", () => {
  let block = roleClient(roleFixture("equipped")).roleBlock();
  assert.equal(block.props["data-role-block"], "valid");
  assert.equal(buttons(block, "unequip").length, 1);
  for (const id of ["broken", "leaky", "bad_name"]) {
    assert.equal(buttons(roleRow(block, id), "equip").length, 0, `${id} has no Equip`);
    assert.equal(all(roleRow(block, id), (n) => n.props["data-state"] === "failed").length, 1, `${id} is marked invalid`);
  }
  assert.match(text(roleRow(block, "leaky")), /Invalid: secret-like text/);

  block = roleClient(roleFixture("not equipped")).roleBlock();
  assert.match(text(block), /No role equipped\. The agent uses agent\.md only\./);
  assert.equal(buttons(block, "unequip").length, 0);
  assert.equal(buttons(block, "equip").length, 3);

  block = roleClient(roleFixture("equipped invalid")).roleBlock();
  assert.match(text(block), /broken is equipped but is invalid: missing or empty '## Instructions' section\./);
  assert.equal(buttons(block, "unequip").length, 1);

  block = roleClient(roleFixture("equipped missing")).roleBlock();
  assert.match(text(block), /reviewer is equipped but is missing from roles\//);
  assert.equal(rowIds(block).includes("reviewer"), false);

  block = roleClient(roleFixture("empty")).roleBlock();
  assert.equal(all(block, (n) => n.props.class === "empty" && text(n) === "No role files in roles/").length, 1);
  assert.equal(all(block, (n) => n.props["data-search"] !== undefined).length, 0);
});

test("the role search filters by id, name, and summary, and by validity", () => {
  const client = roleClient(roleFixture("not equipped"));
  client.search.query = "PLAN";
  assert.deepEqual(rowIds(client.roleBlock()), ["planner"]);
  client.search.query = "screens and flows";
  assert.deepEqual(rowIds(client.roleBlock()), ["designer"]);
  client.search.query = "";
  client.search.option = "invalid";
  assert.deepEqual(rowIds(client.roleBlock()), ["bad_name", "broken", "leaky"]);
  client.search.option = "all";
});

test("Equip posts the role id with the token, applies the reply, refreshes, and keeps the scroll position", async () => {
  const designer = roleFixture("not equipped").list.find((role) => role.id === "designer")!;
  const client = roleClient(roleFixture("not equipped"), {
    replies: [{ status: 200, body: { role: designer } }],
    reloadTo: () => ({ ...roleFixture("not equipped"), equipped: "designer" }),
  });
  client.body.scrollTop = 420;
  const pending = client.changeRole("equip", "designer");
  assert.equal(client.busy(), true);
  assert.ok(buttons(client.roleBlock(), "equip").every((b) => "disabled" in b.props), "buttons are disabled while saving");
  await pending;
  assert.deepEqual(client.calls, [{ url: "/api/role/equip", method: "POST", headers: { "content-type": "application/json", "x-inoai-token": token }, body: JSON.stringify({ roleId: "designer" }) }]);
  assert.equal(client.state.reloads, 1, "data is refreshed after success");
  assert.equal(client.equippedRole().kind, "valid");
  assert.equal(client.body.scrollTop, 420, "the drawer keeps its scroll position");
  const block = client.roleBlock();
  assert.match(text(block), /Equipped Designer \(designer\)\./);
  assert.equal(buttons(roleRow(block, "designer"), "equip").length, 0);
  assert.equal(client.busy(), false);
});

test("Unequip posts an empty body with the token and refreshes", async () => {
  const client = roleClient(roleFixture("equipped"), { replies: [{ status: 200, body: { role: null } }], reloadTo: () => roleFixture("not equipped") });
  await client.changeRole("unequip");
  assert.deepEqual(client.calls, [{ url: "/api/role/unequip", method: "POST", headers: { "content-type": "application/json", "x-inoai-token": token }, body: "{}" }]);
  assert.equal(client.state.reloads, 1);
  assert.equal(client.equippedRole().kind, "none");
  assert.match(text(client.roleBlock()), /Role unequipped\./);
});

test("404 and 409 errors show the server message and refresh the list", async () => {
  for (const [status, error] of [[404, "Role not found."], [409, "Cannot equip role: secret-like text"], [409, "Start the Agent Instance once to upgrade its database."],
    [409, "Start the agent once before managing roles from the UI."], [400, "Invalid role id."]] as const) {
    const client = roleClient(roleFixture("not equipped"), { replies: [{ status, body: { error } }] });
    await client.changeRole("equip", "designer");
    const note = all(client.roleBlock(), (n) => n.props["data-role-note"] === "error")[0]!;
    assert.equal(text(note), error, `${status} shows its message`);
    assert.equal(buttons(client.roleBlock(), "retry").length, 0, `${status} is not retryable`);
    assert.equal(client.state.reloads, status === 400 ? 0 : 1, `${status} refresh`);
    assert.equal(client.equippedRole().kind, "none", "nothing is equipped locally");
  }
});

test("a 503 busy error offers Try again, and the retry repeats the request", async () => {
  const designer = roleFixture("not equipped").list.find((role) => role.id === "designer")!;
  const client = roleClient(roleFixture("not equipped"), { replies: [
    { status: 503, body: { error: "The database is busy. Try again.", retryable: true } },
    { status: 200, body: { role: designer } },
  ] });
  await client.changeRole("equip", "designer");
  let block = client.roleBlock();
  assert.match(text(block), /The database is busy\. Try again\./);
  assert.equal(client.state.reloads, 0, "a busy error does not refresh");
  const retry = buttons(block, "retry");
  assert.equal(retry.length, 1);
  await retry[0]!.props.onclick();
  assert.equal(client.calls.length, 2);
  assert.deepEqual(client.calls[1], client.calls[0], "the retry sends the same request");
  block = client.roleBlock();
  assert.match(text(block), /Equipped Designer \(designer\)\./);
  assert.equal(buttons(block, "retry").length, 0);
});

test("an unreachable server is retryable, and a page without a token does not send", async () => {
  const offline = roleClient(roleFixture("equipped"));
  await offline.changeRole("unequip");
  assert.match(text(offline.roleBlock()), /The UI server is not reachable\. Try again\./);
  assert.equal(buttons(offline.roleBlock(), "retry").length, 1);

  const noToken = roleClient(roleFixture("equipped"), { pageToken: "" });
  await noToken.changeRole("unequip");
  assert.equal(noToken.calls.length, 0);
  assert.match(text(noToken.roleBlock()), /This page has no write token\. Reload the page\./);
});

test("a 200 equip reply with valid: false shows the role as equipped and invalid", async () => {
  const client = roleClient(roleFixture("not equipped"), { replies: [{ status: 200, body: { role: { id: "planner", name: null, summary: null, valid: false, reason: "secret-like text" } } }] });
  await client.changeRole("equip", "planner");
  assert.equal(client.equippedRole().kind, "invalid");
  const block = client.roleBlock();
  assert.match(text(block), /Equipped planner, but it is invalid: secret-like text\. Fix roles\/planner\.md or unequip it\./);
  assert.equal(buttons(block, "unequip").length, 1);
  assert.equal(buttons(roleRow(block, "planner"), "equip").length, 0);
});

test("role names and summaries stay plain text", () => {
  const strings = (node: Node | string): string[] => typeof node === "string" ? [node] : node.kids.flatMap(strings);
  const values = strings(roleRow(roleClient(roleFixture("not equipped")).roleBlock(), "markup"));
  assert.ok(values.includes("<img src=x onerror=alert(1)>"));
  assert.ok(values.includes(" · Summary with </script><script>alert(2)</script> & \"quotes\"."));
});
