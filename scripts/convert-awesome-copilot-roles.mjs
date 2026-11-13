// Converts a local awesome-copilot checkout (`agents/*.agent.md`) into the vendored inoai role catalog.
//
// Usage: npm run build && node scripts/convert-awesome-copilot-roles.mjs <path-to-awesome-copilot>
//
// It rewrites `src/inoai/roles/catalog/*.md`, the vendoring report, and the generated embedding module.
// The output depends only on the checkout's files and HEAD commit, so a second run produces no diff.
import { execFileSync } from "node:child_process";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { secretLike } from "../dist/inoai/conversation/prompt-context.js";
import { InvalidRoleError, isValidRoleId, reservedRoleId, validateRole } from "../dist/inoai/roles/role-file.js";

export const upstreamUrl = "https://github.com/github/awesome-copilot";
export const defaultWorkflow = "Follow the instructions above step by step and report results.";
// A top-level `##` title that ends with one of these words, ignoring trailing punctuation.
const workflowHeading = /(?:workflow|process|steps)[\s\p{P}]*$/iu;

/** Returns the role id for an upstream file name, or `null` when it does not end in `.agent.md`. */
export function normalizeId(fileName) {
  if (!fileName.endsWith(".agent.md")) return null;
  return fileName
    .slice(0, -".agent.md".length)
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .replace(/_/g, "-")
    .toLowerCase();
}

function unquoteScalar(value) {
  if (value.startsWith("'") && value.endsWith("'") && value.length >= 2) return value.slice(1, -1).replace(/''/g, "'");
  if (value.startsWith('"') && value.endsWith('"') && value.length >= 2) {
    const escapes = { n: "\n", t: "\t", '"': '"', "\\": "\\", "/": "/", r: "\r", "0": "\0" };
    return value.slice(1, -1).replace(/\\(.)/g, (match, char) => escapes[char] ?? match);
  }
  return value.replace(/\s+#.*$/, "");
}

/**
 * Reads the top-level scalar keys of a simple YAML frontmatter block. Supports plain, quoted,
 * folded (`>`), and literal (`|`) scalars. List and nested values are skipped, so their keys
 * are dropped. Returns `null` when the text has no frontmatter.
 */
export function parseFrontmatter(text) {
  const match = text.match(/^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/);
  if (!match) return null;
  const lines = match[1].split(/\r?\n/);
  const data = {};
  for (let index = 0; index < lines.length; index += 1) {
    const key = lines[index].match(/^([A-Za-z0-9_-]+):[ \t]*(.*)$/);
    if (!key) continue;
    const continuation = [];
    while (index + 1 < lines.length && (/^[ \t]/.test(lines[index + 1]) || lines[index + 1].trim() === "")) {
      continuation.push(lines[(index += 1)]);
    }
    const value = key[2].trim();
    if (/^[>|][+-]?$/.test(value)) {
      const parts = continuation.map((line) => line.trim());
      data[key[1]] = (value.startsWith(">") ? parts.join(" ") : parts.join("\n")).replace(/\s+$/, "");
    } else if (value && !value.startsWith("[") && !value.startsWith("{")) {
      data[key[1]] = unquoteScalar([value, ...continuation.map((line) => line.trim())].join(" ").trim());
    }
  }
  return { data, body: text.slice(match[0].length) };
}

function headingOf(line) {
  const match = line.match(/^(#{1,6})(?:[ \t]+(.*?))?[ \t]*$/);
  return match ? { level: match[1].length, title: match[2] ?? "" } : null;
}

/** Splits Markdown into lines tagged with whether each line is inside a fenced code block. */
function tagLines(markdown) {
  let fence = null;
  return markdown.split(/\r?\n/).map((line) => {
    const marker = line.match(/^ {0,3}(`{3,}|~{3,})/);
    if (fence) {
      if (marker && marker[1][0] === fence[0] && marker[1].length >= fence.length && line.trim() === marker[1]) fence = null;
      return { line, code: true };
    }
    if (marker) {
      fence = marker[1];
      return { line, code: true };
    }
    return { line, code: false };
  });
}

function shiftHeading(line, level) {
  return line.replace(/^#{1,6}/, "#".repeat(Math.min(Math.max(level, 1), 6)));
}

/**
 * Converts an upstream agent body into the intended Instructions and Workflow text.
 * Drops the first H1 title and lifts the first non-empty top-level `##` section whose title
 * ends with Workflow, Process, or Steps. Outside fenced code blocks, the remaining headings
 * are demoted one level, and never above `###`, so no heading becomes a `##` section boundary.
 */
export function convertBody(body) {
  const lines = tagLines(body);
  const titleIndex = lines.findIndex(({ line, code }) => !code && headingOf(line)?.level === 1);
  if (titleIndex >= 0) lines.splice(titleIndex, 1);

  let workflow = null;
  for (let start = 0; start < lines.length && workflow === null; start += 1) {
    const heading = !lines[start].code && headingOf(lines[start].line);
    if (!heading || heading.level !== 2 || !workflowHeading.test(heading.title)) continue;
    let end = start + 1;
    while (end < lines.length && !(!lines[end].code && (headingOf(lines[end].line)?.level ?? 7) <= heading.level)) end += 1;
    const section = lines.slice(start + 1, end).map(({ line, code }) => {
      const nested = !code && headingOf(line);
      return nested ? shiftHeading(line, nested.level - heading.level + 2) : line;
    });
    const text = section.join("\n").trim();
    if (!text) continue;
    workflow = text;
    lines.splice(start, end - start);
  }

  const instructions = lines.map(({ line, code }) => {
    const heading = !code && headingOf(line);
    return heading ? shiftHeading(line, Math.max(heading.level + 1, 3)) : line;
  }).join("\n").trim();
  return { instructions, workflow: workflow ?? defaultWorkflow };
}

export function renderRoleFile({ name, summary, instructions, workflow }) {
  return `# Role: ${name}\n\n${summary}\n\n## Instructions\n\n${instructions}\n\n## Workflow\n\n${workflow}\n`;
}

/**
 * Converts one upstream file. Returns `{ text }` for a shipped role or `{ reason }` for a skipped one.
 * The id checks happen in `convertCatalog`, which sees every file.
 */
export function convertAgentFile(source) {
  if (secretLike.test(source)) return { reason: "secret-like text" };
  const parsed = parseFrontmatter(source);
  if (!parsed) return { reason: "no frontmatter" };
  const name = (parsed.data.name ?? "").replace(/\s+/g, " ").trim();
  const summary = (parsed.data.description ?? "").replace(/\s+/g, " ").trim();
  if (!name) return { reason: "missing name" };
  if (!summary) return { reason: "missing description" };
  const intended = { name, summary, ...convertBody(parsed.body) };
  if (!intended.instructions) return { reason: "empty instructions" };
  const text = renderRoleFile(intended);
  let actual;
  try {
    actual = validateRole(text);
  } catch (error) {
    if (error instanceof InvalidRoleError) return { reason: `round-trip: ${error.reason}` };
    throw error;
  }
  for (const field of ["name", "summary", "instructions", "workflow"]) {
    if (actual[field] !== intended[field]) return { reason: `round-trip: ${field} changed` };
  }
  return { text };
}

/**
 * Converts every `agents/*.agent.md` file. Returns the shipped roles by file name and every
 * skipped upstream file with its reason, both sorted by upstream file name.
 */
export async function convertCatalog(upstreamDirectory) {
  const agentsDirectory = join(upstreamDirectory, "agents");
  const files = (await readdir(agentsDirectory)).filter((name) => name.endsWith(".agent.md")).sort();
  const idCounts = new Map();
  for (const file of files) idCounts.set(normalizeId(file), (idCounts.get(normalizeId(file)) ?? 0) + 1);
  const roles = new Map();
  const skipped = [];
  for (const file of files) {
    const id = normalizeId(file);
    let result;
    if (id === reservedRoleId) result = { reason: "reserved role id" };
    else if (!isValidRoleId(id)) result = { reason: "invalid role id" };
    else if (idCounts.get(id) > 1) result = { reason: `id clash: ${id}` };
    else result = convertAgentFile(await readFile(join(agentsDirectory, file), "utf8"));
    if (result.text) roles.set(`${id}.md`, result.text);
    else skipped.push({ file, id, reason: result.reason });
  }
  return { total: files.length, roles, skipped };
}

// Locale-independent order, the same as the default `Array.prototype.sort`.
function byCodeUnit(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function renderReport({ commit, total, roles, skipped }) {
  const reasons = new Map();
  for (const { reason } of skipped) reasons.set(reason, (reasons.get(reason) ?? 0) + 1);
  const lines = [
    "# Role catalog vendoring report",
    "",
    "This file is generated by `scripts/convert-awesome-copilot-roles.mjs`. Do not edit it by hand.",
    "",
    `- Upstream: ${upstreamUrl}`,
    `- Commit: \`${commit}\``,
    "- Source files: `agents/*.agent.md`",
    "- License: MIT, Copyright GitHub, Inc. See `licenses/awesome-copilot-LICENSE.md`.",
    "",
    "## Counts",
    "",
    `- Upstream files: ${total}`,
    `- Converted: ${roles.size}`,
    `- Skipped: ${skipped.length}`,
    ...[...reasons.entries()].sort(([a], [b]) => byCodeUnit(a, b)).map(([reason, count]) => `  - ${reason}: ${count}`),
    "",
    "## Skipped files",
    "",
  ];
  if (skipped.length === 0) lines.push("None.");
  else {
    lines.push("| Upstream file | Id | Reason |", "| --- | --- | --- |");
    for (const { file, id, reason } of skipped) lines.push(`| \`${file}\` | \`${id}\` | ${reason} |`);
  }
  return `${lines.join("\n")}\n`;
}

export function renderEmbeddingModule(roles) {
  const entries = [...roles.entries()].sort(([a], [b]) => byCodeUnit(a, b));
  return [
    "// Generated by scripts/convert-awesome-copilot-roles.mjs from src/inoai/roles/catalog/. Do not edit.",
    "/** The vendored role catalog, by file name. Bootstrap copies it into a new `roles/` folder. */",
    "export const roleCatalog: Readonly<Record<string, string>> = {",
    ...entries.map(([name, text]) => `  ${JSON.stringify(name)}: ${JSON.stringify(text)},`),
    "};",
    "",
  ].join("\n");
}

export async function writeCatalog(upstreamDirectory, repositoryRoot) {
  const commit = execFileSync("git", ["-C", upstreamDirectory, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  const result = await convertCatalog(upstreamDirectory);
  const rolesSource = join(repositoryRoot, "src", "inoai", "roles");
  const catalogDirectory = join(rolesSource, "catalog");
  await rm(catalogDirectory, { recursive: true, force: true });
  await mkdir(catalogDirectory, { recursive: true });
  for (const [name, text] of result.roles) await writeFile(join(catalogDirectory, name), text);
  await writeFile(join(rolesSource, "catalog-vendoring.md"), renderReport({ commit, ...result }));
  await writeFile(join(rolesSource, "role-catalog.generated.ts"), renderEmbeddingModule(result.roles));
  return { commit, ...result };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const upstream = process.argv[2];
  if (!upstream) {
    console.error("Usage: node scripts/convert-awesome-copilot-roles.mjs <path-to-awesome-copilot>");
    process.exit(2);
  }
  const result = await writeCatalog(resolve(upstream), resolve(import.meta.dirname, ".."));
  console.log(`Converted ${result.roles.size} of ${result.total} roles from ${result.commit}; skipped ${result.skipped.length}.`);
}
