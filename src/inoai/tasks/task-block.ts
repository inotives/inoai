// Pure rules for the `inoai-task` block an agent adds to a chat answer. No I/O.

import { describeSchedule, normalizeTimeZone, scheduleKinds, taskSpecFromRow, validateTaskSpec,
  type TaskScheduleRow, type TaskSpec } from "./schedule.js";

export const taskBlockActions = ["create", "edit", "run", "pause", "resume", "cancel"] as const;
export type TaskBlockAction = typeof taskBlockActions[number];

export type ExtractedTaskBlock =
  | { found: false; answer: string }
  | { found: true; answer: string; parsed: { ok: true; value: unknown } | { ok: false } };

export type TaskBlockProposal = { kind: TaskBlockAction; taskId: number | null; spec: TaskSpec | null };
export type TaskBlockRejection = {
  reason: "invalid_json" | "unknown_action" | "invalid_task" | "task_not_found" | "invalid_fields";
  fields: string[];
  note: string;
};
export type TaskBlockResult = { ok: true; proposal: TaskBlockProposal } | { ok: false; rejection: TaskBlockRejection };

export type TaskListRow = TaskScheduleRow & { id: number; state: string; task_type: string };

const listLimit = 20;
const textLimit = 60;
// Line prefix: indentation, "> " quote markers, and list markers. Then a fence of 3+ backticks or tildes and its info.
// Every pattern here is anchored and unambiguous, so long lines cost linear time.
const openerPattern = /^((?:[ \t>]|[-*+](?=[ \t])|\d{1,9}[.)](?=[ \t]))*)(`{3,}|~{3,})(.*)$/;
const tagPattern = /(?<![\w-])inoai-task(?![\w-])/gi;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

type FoundBlock = { body: string; closed: boolean };

/** Reads one block that opens on lines[index]. Returns undefined when that line is not an `inoai-task` opener. */
function readBlock(lines: readonly string[], index: number): (FoundBlock & { end: number }) | undefined {
  const opener = openerPattern.exec(lines[index].replace(/\r$/, ""));
  if (!opener) return undefined;
  const [, prefix, fence, info] = opener;
  tagPattern.lastIndex = 0;
  const tag = tagPattern.exec(info);
  if (!tag) return undefined;
  const char = fence[0];
  const closer = new RegExp(`^[ \\t>]*\\${char}{${fence.length},}[ \\t]*$`);
  const quotes = (prefix.match(/>/g) ?? []).length;
  const unquote = (line: string) => line.replace(new RegExp(`^(?:[ \\t]*>[ \\t]?){0,${quotes}}`), "");
  const body: string[] = [];
  // JSON may start on the opener line after the tag; other info words are ignored.
  const rest = info.slice(tag.index + tag[0].length).trim();
  if (/^[{[]/.test(rest)) {
    let close = rest.length;
    while (close > 0 && rest[close - 1] === char) close--;
    if (rest.length - close >= fence.length) return { body: rest.slice(0, close), closed: true, end: index };
    body.push(rest);
  }
  for (let line = index + 1; line < lines.length; line++) {
    const text = lines[line].replace(/\r$/, "");
    if (closer.test(text)) return { body: body.join("\n"), closed: true, end: line };
    body.push(unquote(text));
  }
  return { body: body.join("\n"), closed: false, end: lines.length - 1 };
}

/** True when ``` or ~~~ appears before an `inoai-task` tag on the line. Uses indexOf only, so it is linear. */
function hasLeftoverFence(line: string): boolean {
  const fences = [line.indexOf("```"), line.indexOf("~~~")].filter((at) => at >= 0);
  if (!fences.length) return false;
  tagPattern.lastIndex = Math.min(...fences) + 3;
  return tagPattern.test(line);
}

/** Removes every `inoai-task` block and parses the last one. An answer without a block is returned unchanged. */
export function extractTaskBlock(answer: string): ExtractedTaskBlock {
  const lines = answer.split("\n");
  const kept: string[] = [];
  let last: FoundBlock | undefined;
  for (let index = 0; index < lines.length; index++) {
    const block = readBlock(lines, index);
    if (!block) { kept.push(lines[index]); continue; }
    last = block;
    index = block.end;
  }
  // Safety net: a line where a fence comes before the tag is one the reader missed. Cut from the start of that
  // line to the end and mark the block invalid, so raw JSON never leaks.
  const cut = kept.findIndex(hasLeftoverFence);
  const leftover = cut >= 0;
  let stripped = (leftover ? kept.slice(0, cut) : kept).join("\n");
  if (!last && !leftover) return { found: false, answer };
  stripped = stripped.trim();
  if (!last || leftover || !last.closed) return { found: true, answer: stripped, parsed: { ok: false } };
  try {
    return { found: true, answer: stripped, parsed: { ok: true, value: JSON.parse(last.body) } };
  } catch {
    return { found: true, answer: stripped, parsed: { ok: false } };
  }
}

function reject(reason: TaskBlockRejection["reason"], note: string, fields: string[] = []): TaskBlockResult {
  return { ok: false, rejection: { reason, fields, note: `Task card not created: ${note}` } };
}

/** Validates a parsed block. Create and edit use validateTaskSpec; a missing time zone uses the owner time zone. */
export function validateTaskBlock(parsed: ExtractedTaskBlock & { found: true }, options: {
  ownerTimeZone: string; now: number; taskIds?: ReadonlySet<number>;
}): TaskBlockResult {
  if (!parsed.parsed.ok || !isRecord(parsed.parsed.value)) return reject("invalid_json", "the task block was not a valid JSON object.");
  const { action, task, ...fields } = parsed.parsed.value;
  if (!(taskBlockActions as readonly unknown[]).includes(action)) {
    return reject("unknown_action", `unknown action. Use one of: ${taskBlockActions.join(", ")}.`);
  }
  const kind = action as TaskBlockAction;
  let taskId: number | null = null;
  if (kind !== "create") {
    if (typeof task !== "number" || !Number.isSafeInteger(task) || task < 1) return reject("invalid_task", "task must be a Task ID number.", ["task"]);
    if (options.taskIds && !options.taskIds.has(task)) return reject("task_not_found", `Task #${task} was not found.`, ["task"]);
    taskId = task;
  }
  if (kind !== "create" && kind !== "edit") return { ok: true, proposal: { kind, taskId, spec: null } };
  const timezone = fields.timezone == null || (typeof fields.timezone === "string" && !fields.timezone.trim())
    ? options.ownerTimeZone : fields.timezone;
  const result = validateTaskSpec({ ...fields, timezone }, options.now);
  if (!result.ok) {
    const keys = Object.keys(result.errors);
    return reject("invalid_fields", keys.map((key) => `${key}: ${result.errors[key]}`).join(" "), keys);
  }
  return { ok: true, proposal: { kind, taskId, spec: result.spec } };
}

function oneLine(text: string): string {
  const value = text.replace(/\s+/g, " ").trim();
  return value.length > textLimit ? `${value.slice(0, textLimit - 1)}…` : value;
}

function scheduleLabel(row: TaskListRow): string {
  const spec = taskSpecFromRow(row);
  if (spec) return describeSchedule(spec);
  if (row.task_type === "recurring" && row.interval_seconds) return `every ${row.interval_seconds / 3600} hours`;
  return "one time";
}

function localTime(unixSeconds: number, timeZone: string): string {
  const parts: Record<string, string> = {};
  for (const { type, value } of new Intl.DateTimeFormat("en-US", { timeZone, hourCycle: "h23", year: "numeric", month: "2-digit",
    day: "2-digit", hour: "2-digit", minute: "2-digit", weekday: "short" }).formatToParts(new Date(unixSeconds * 1000))) parts[type] = value;
  return `${parts.weekday} ${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}`;
}

/** The short per-turn instruction for owner turns in normal conversations. */
export function taskBlockInstruction(tasks: readonly TaskListRow[], ownerTimeZone: string, now: number): string {
  const zone = normalizeTimeZone(ownerTimeZone) ?? "UTC";
  const listed = tasks.filter((row) => row.state === "active" || row.state === "paused").slice(-listLimit).map((row) =>
    `- #${row.id} ${oneLine(row.title || row.goal)}: ${scheduleLabel(row)}${row.state === "paused" ? " (paused)" : ""}`);
  return [
    "inoai Tasks (system note, not from the user):",
    "Only when the user asks for scheduled, repeated, or later work, or to edit, run, pause, resume, or cancel a Task, end your reply with one fenced code block tagged inoai-task that holds JSON. inoai removes the block and shows the user a confirm card. Nothing is saved until they confirm. Do not show or explain the JSON.",
    `Create: {"action":"create","title":"...","instruction":"...","expectedOutput":"..." or null,"schedule":{...},"timezone":"IANA name","endsAt":unix seconds or null,"maxRuns":number or null}`,
    `Edit: {"action":"edit","task":ID, plus every create field}. Others: {"action":"run"|"pause"|"resume"|"cancel","task":ID}.`,
    `Schedule kinds (${scheduleKinds.join(", ")}): {"kind":"once","at":unix seconds or null for now}, {"kind":"interval","hours":N}, {"kind":"daily","time":"HH:MM"}, {"kind":"days","time":"HH:MM","days":["mon","fri"]}, {"kind":"weekly","time":"HH:MM","day":"mon"}.`,
    `Now: ${localTime(now, zone)} ${zone} (unix ${now}). Default time zone: ${zone}.`,
    listed.length ? `Current Tasks:\n${listed.join("\n")}` : "Current Tasks: none.",
  ].join("\n");
}
