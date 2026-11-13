import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  convertAgentFile,
  convertBody,
  convertCatalog,
  defaultWorkflow,
  normalizeId,
  parseFrontmatter,
  renderReport,
} from "./convert-awesome-copilot-roles.mjs";
import { validateRole } from "../dist/inoai/roles/role-file.js";

const agent = (frontmatter, body) => `---\n${frontmatter}\n---\n${body}`;

test("frontmatter name and description map to the heading and summary; other keys are dropped", () => {
  const source = agent([
    "name: 'Bicep Planner'",
    "description: >",
    "  Plans Bicep",
    "  deployments.",
    "tools: ['codebase', 'search']",
    "model: GPT-4.1",
    "mcp-servers:",
    "  example:",
    "    type: 'local'",
    "    tools: ['*']",
    "handoffs:",
    "  - label: Next",
    "    agent: other",
    "user-invocable: true",
  ].join("\n"), "# Bicep Planner\n\nPlan carefully.\n");
  const parsed = parseFrontmatter(source);
  assert.equal(parsed.data.name, "Bicep Planner");
  assert.equal(parsed.data.description, "Plans Bicep deployments.");
  assert.equal(parsed.data.tools, undefined);
  assert.equal(parsed.data["mcp-servers"], undefined);
  assert.equal(parsed.data.handoffs, undefined);
  const { text } = convertAgentFile(source);
  assert.equal(text, `# Role: Bicep Planner\n\nPlans Bicep deployments.\n\n## Instructions\n\nPlan carefully.\n\n## Workflow\n\n${defaultWorkflow}\n`);
  for (const dropped of ["codebase", "GPT-4.1", "mcp-servers", "handoffs", "user-invocable", "local"]) assert.ok(!text.includes(dropped), dropped);
});

test("quoted scalars are unescaped", () => {
  assert.equal(parseFrontmatter(agent("description: 'the project''s stack'", "")).data.description, "the project's stack");
  assert.equal(parseFrontmatter(agent('name: "A \\"quoted\\" name"', "")).data.name, 'A "quoted" name');
  assert.equal(parseFrontmatter("# No frontmatter\n"), null);
});

test("ids are lowercased, CamelCase is split, and underscores become hyphens", () => {
  assert.equal(normalizeId("CSharpExpert.agent.md"), "csharp-expert");
  assert.equal(normalizeId("Thinking-Beast-Mode.agent.md"), "thinking-beast-mode");
  assert.equal(normalizeId("Ultimate-Transparent-Thinking-Beast-Mode.agent.md"), "ultimate-transparent-thinking-beast-mode");
  assert.equal(normalizeId("WinFormsExpert.agent.md"), "win-forms-expert");
  assert.equal(normalizeId("microsoft_learn_contributor.agent.md"), "microsoft-learn-contributor");
  assert.equal(normalizeId("react18-auditor.agent.md"), "react18-auditor");
  assert.equal(normalizeId("notes.md"), null);
});

test("only a top-level ## section whose title ends with Workflow, Process, or Steps is lifted", () => {
  const lifted = convertBody("# Title\n\nIntro.\n\n## Rules\n\nBe brief.\n\n## Review process\n\n1. Read.\n\n### Details\n\nMore.\n\n## After\n\nDone.\n");
  assert.equal(lifted.workflow, "1. Read.\n\n### Details\n\nMore.");
  assert.equal(lifted.instructions, "Intro.\n\n### Rules\n\nBe brief.\n\n### After\n\nDone.");
  assert.equal(convertBody("## Core Workflow\n\nGo.\n").workflow, "Go.");
  assert.equal(convertBody("## Development Process:\n\nGo.\n").workflow, "Go.");
  assert.equal(convertBody("## **Implementation Steps**\n\nGo.\n").workflow, "Go.");
  for (const body of [
    "## Workflow Definition Structure\n\nKeep.\n",
    "## Job for Background Processing\n\nKeep.\n",
    "## Build\n\n### 1. Locate the build workflow\n\nKeep.\n",
    "### Steps\n\nKeep.\n",
    "# Steps\n\nTitle only.\n\n# Steps\n\nKeep.\n",
    "```md\n## Workflow\n```\n",
  ]) {
    const converted = convertBody(body);
    assert.equal(converted.workflow, defaultWorkflow, body);
    assert.ok(converted.instructions.includes("Keep.") || converted.instructions.includes("## Workflow"), body);
  }
  assert.equal(convertBody("## Workflow\n\n## Real\n\nText.\n").workflow, defaultWorkflow);
  assert.equal(convertBody("# Title\n\nJust do it.\n").workflow, defaultWorkflow);
});

test("headings are demoted outside fenced code blocks only, and never become ## boundaries", () => {
  const { instructions } = convertBody("# Title\n\n## Section\n\n```md\n### In a fence\n```\n\n~~~\n# Also fenced\n~~~\n\n#### Deep\n\n# Second title\n");
  assert.equal(instructions, "### Section\n\n```md\n### In a fence\n```\n\n~~~\n# Also fenced\n~~~\n\n##### Deep\n\n### Second title");
});

test("extra H1s and fenced ## lines no longer cause a round-trip skip", () => {
  const twoTitles = convertAgentFile(agent("name: Two Titles\ndescription: Has two H1s.", "# One\n\nText.\n\n# Two\n\nMore.\n"));
  assert.deepEqual(validateRole(twoTitles.text).instructions, "Text.\n\n### Two\n\nMore.");
  const template = convertAgentFile(agent("name: Templater\ndescription: Writes templates.", "# Templater\n\nUse this:\n\n```md\n## Summary\n## Workflow\n```\n"));
  assert.equal(validateRole(template.text).instructions, "Use this:\n\n```md\n## Summary\n## Workflow\n```");
});

test("a file whose output does not round-trip is skipped", () => {
  assert.deepEqual(convertAgentFile(agent("name: Open\ndescription: Has an open fence.", "Text.\n\n```md\n## Never closed\n")), { reason: "round-trip: unclosed code fence" });
  assert.deepEqual(convertAgentFile(agent("name: Big\ndescription: Too big.", `Text.\n\n${"x".repeat(49_152)}\n`)), { reason: "round-trip: larger than 49152 bytes" });
});

test("secret-like files and files without a description are skipped", () => {
  assert.deepEqual(convertAgentFile(agent("name: Keys\ndescription: Uses keys.", "Set PublicKeyToken=abc.\n")), { reason: "secret-like text" });
  assert.deepEqual(convertAgentFile(agent("name: Keys\ndescription: Uses keys.\nmcp-servers:\n  x:\n    env:\n      API_KEY: abc", "Text.\n")), { reason: "secret-like text" });
  assert.deepEqual(convertAgentFile(agent("name: Nameless", "Text.\n")), { reason: "missing description" });
});

test("convertCatalog skips reserved, clashing, and secret files and reports every skip", async () => {
  const upstream = await mkdtemp(join(tmpdir(), "inoai-awesome-copilot-"));
  try {
    const agents = join(upstream, "agents");
    await mkdir(agents);
    const role = (name) => agent(`name: ${name}\ndescription: The ${name} role.`, `# ${name}\n\nDo ${name} work.\n`);
    await writeFile(join(agents, "CSharpExpert.agent.md"), role("C# Expert"));
    await writeFile(join(agents, "none.agent.md"), role("None"));
    await writeFile(join(agents, "Foo_Bar.agent.md"), role("Foo A"));
    await writeFile(join(agents, "foo-bar.agent.md"), role("Foo B"));
    await writeFile(join(agents, "leaky.agent.md"), role("Leaky").replace("Do Leaky work.", "password: hunter2"));
    await writeFile(join(agents, "README.md"), "ignored");
    const result = await convertCatalog(upstream);
    assert.equal(result.total, 5);
    assert.deepEqual([...result.roles.keys()], ["csharp-expert.md"]);
    validateRole(result.roles.get("csharp-expert.md"));
    assert.deepEqual(result.skipped, [
      { file: "Foo_Bar.agent.md", id: "foo-bar", reason: "id clash: foo-bar" },
      { file: "foo-bar.agent.md", id: "foo-bar", reason: "id clash: foo-bar" },
      { file: "leaky.agent.md", id: "leaky", reason: "secret-like text" },
      { file: "none.agent.md", id: "none", reason: "reserved role id" },
    ]);
    const report = renderReport({ commit: "abc123", ...result });
    assert.match(report, /- Upstream: https:\/\/github\.com\/github\/awesome-copilot/);
    assert.match(report, /- Commit: `abc123`/);
    assert.match(report, /- Upstream files: 5\n- Converted: 1\n- Skipped: 4\n {2}- id clash: foo-bar: 2\n {2}- reserved role id: 1\n {2}- secret-like text: 1\n/);
    for (const { file } of result.skipped) assert.ok(report.includes(`\`${file}\``), file);
  } finally {
    await rm(upstream, { recursive: true, force: true });
  }
});
