import assert from "node:assert/strict";
import test from "node:test";

import { extractTaskBlock, taskBlockInstruction, validateTaskBlock, type TaskListRow } from "../../tasks/task-block.js";

const now = Date.parse("2026-10-23T00:00:00Z") / 1000;
const owner = { ownerTimeZone: "Asia/Singapore", now };
const block = (json: string) => "```inoai-task\n" + json + "\n```";
const create = { action: "create", title: "CI report", instruction: "Summarize failing CI", schedule: { kind: "daily", time: "09:00" } };

function validate(value: unknown, taskIds?: ReadonlySet<number>) {
  const extracted = extractTaskBlock(block(JSON.stringify(value)));
  assert.equal(extracted.found, true);
  if (!extracted.found) throw new Error("unreachable");
  return validateTaskBlock(extracted, { ...owner, taskIds });
}

test("extractTaskBlock uses the last block and strips every block", () => {
  const answer = `Sure.\n${block('{"action":"pause","task":1}')}\nMiddle text.\n${block('{"action":"resume","task":2}')}\n`;
  const extracted = extractTaskBlock(answer);
  assert.equal(extracted.found, true);
  if (!extracted.found) return;
  assert.equal(extracted.answer, "Sure.\nMiddle text.");
  assert.deepEqual(extracted.parsed, { ok: true, value: { action: "resume", task: 2 } });
  assert.doesNotMatch(extracted.answer, /inoai-task|action/);
});

test("extractTaskBlock leaves other answers and code blocks unchanged", () => {
  const answer = "  Here:\n```json\n{\"a\":1}\n```\n\n\nDone  ";
  assert.deepEqual(extractTaskBlock(answer), { found: false, answer });
  const withBlock = extractTaskBlock(`${answer}\n${block("{}")}`);
  assert.equal(withBlock.found && withBlock.answer, answer.trim());
});

test("extractTaskBlock handles CRLF, an unterminated block, and a block-only answer", () => {
  const crlf = extractTaskBlock("Hi\r\n```inoai-task\r\n{\"action\":\"run\",\"task\":3}\r\n```\r\n");
  assert.deepEqual(crlf, { found: true, answer: "Hi", parsed: { ok: true, value: { action: "run", task: 3 } } });
  const open = extractTaskBlock("Hi\n```inoai-task\n{\"action\":\"run\",\"task\":3}");
  assert.deepEqual(open, { found: true, answer: "Hi", parsed: { ok: false } });
  const only = extractTaskBlock(block('{"action":"run","task":3}'));
  assert.equal(only.found && only.answer, "");
});

test("validateTaskBlock rejects malformed JSON and unknown actions without echoing the block", () => {
  const malformed = extractTaskBlock(block('{"action": "create", "title": "secret-ish",'));
  assert.ok(malformed.found);
  if (!malformed.found) return;
  const result = validateTaskBlock(malformed, owner);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.rejection.reason, "invalid_json");
  assert.doesNotMatch(result.rejection.note, /secret-ish/);
  for (const value of [{ action: "delete", task: 1 }, { task: 1 }]) {
    const unknown = validate(value);
    assert.equal(!unknown.ok && unknown.rejection.reason, "unknown_action");
  }
  const array = validate([create]);
  assert.equal(!array.ok && array.rejection.reason, "invalid_json");
});

test("validateTaskBlock accepts every schedule kind", () => {
  const schedules = [
    { kind: "once", at: null }, { kind: "once", at: now + 3600 }, { kind: "interval", hours: 6 },
    { kind: "daily", time: "09:00" }, { kind: "days", time: "08:30", days: ["mon", "fri"] }, { kind: "weekly", time: "18:00", day: "sun" },
  ];
  for (const schedule of schedules) {
    const result = validate({ ...create, schedule });
    assert.equal(result.ok, true, JSON.stringify(schedule));
    if (result.ok) assert.equal(result.proposal.spec?.schedule.kind, schedule.kind);
  }
  const bad = validate({ ...create, schedule: { kind: "monthly", time: "09:00" } });
  assert.deepEqual(!bad.ok && bad.rejection.fields, ["schedule.kind"]);
});

test("validateTaskBlock uses the owner time zone only when the block has none", () => {
  for (const timezone of [undefined, null, "  "]) {
    const result = validate({ ...create, timezone });
    assert.equal(result.ok && result.proposal.spec?.timezone, "Asia/Singapore");
  }
  const given = validate({ ...create, timezone: "Europe/London" });
  assert.equal(given.ok && given.proposal.spec?.timezone, "Europe/London");
  const invalid = validate({ ...create, timezone: "Mars/Base" });
  assert.deepEqual(!invalid.ok && invalid.rejection.fields, ["timezone"]);
});

test("validateTaskBlock reports field errors in the note", () => {
  const result = validate({ action: "create", schedule: { kind: "daily", time: "9am" } });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.rejection.reason, "invalid_fields");
  assert.deepEqual(result.rejection.fields, ["title", "instruction", "schedule.time"]);
  assert.match(result.rejection.note, /^Task card not created: title: Title is required\..*schedule\.time: Time must be HH:MM/);
});

test("validateTaskBlock checks edit and management shapes", () => {
  const edit = validate({ ...create, action: "edit", task: 4 }, new Set([4]));
  assert.equal(edit.ok, true);
  if (edit.ok) assert.deepEqual([edit.proposal.kind, edit.proposal.taskId, edit.proposal.spec?.title], ["edit", 4, "CI report"]);
  const badEdit = validate({ action: "edit", task: 4, title: "x" }, new Set([4]));
  assert.equal(!badEdit.ok && badEdit.rejection.reason, "invalid_fields");
  const createWithTask = validate({ ...create, task: 9 });
  assert.equal(createWithTask.ok && createWithTask.proposal.taskId, null);
  for (const action of ["run", "pause", "resume", "cancel"] as const) {
    const result = validate({ action, task: 4 }, new Set([4]));
    assert.deepEqual(result, { ok: true, proposal: { kind: action, taskId: 4, spec: null } });
    for (const task of [undefined, 1.5, 0]) {
      const invalid = validate({ action, task });
      assert.equal(!invalid.ok && invalid.rejection.reason, "invalid_task", `${action} ${String(task)}`);
    }
    const missing = validate({ action, task: 5 }, new Set([4]));
    assert.equal(!missing.ok && missing.rejection.reason, "task_not_found");
  }
});

test("validateTaskBlock reads the Task ID from a number, digits, or # plus digits", () => {
  for (const action of ["edit", "run", "pause", "resume", "cancel"] as const) {
    const extra = action === "edit" ? create : {};
    for (const task of [3, "3", " #3 ", "#3"]) {
      const result = validate({ ...extra, action, task }, new Set([3]));
      assert.equal(result.ok && result.proposal.taskId, 3, `${action} ${JSON.stringify(task)}`);
      assert.equal(result.ok && result.proposal.kind, action);
    }
    for (const task of [0, -1, 1.5, "", "#", "three", "3a", "#-3", "-3", "0", "#0", Number.MAX_SAFE_INTEGER + 1,
      String(Number.MAX_SAFE_INTEGER + 1), "9".repeat(400), null, true, [3], { id: 3 }]) {
      const invalid = validate({ ...extra, action, task }, new Set([3]));
      assert.equal(!invalid.ok && invalid.rejection.reason, "invalid_task", `${action} ${JSON.stringify(task)}`);
    }
    const missing = validate({ ...extra, action, task: "#5" }, new Set([3]));
    assert.equal(!missing.ok && missing.rejection.reason, "task_not_found");
    assert.equal(!missing.ok && missing.rejection.note, "Task card not created: Task #5 was not found.");
  }
});

test("taskBlockInstruction lists up to 20 active and paused Tasks with schedule labels", () => {
  const row = (id: number, state: string, extra: Partial<TaskListRow> = {}): TaskListRow => ({ id, state, task_type: "recurring",
    goal: `Goal ${id}`, title: null, output_spec: null, interval_seconds: 7200, next_due_at: now, timezone: null, schedule_kind: null,
    schedule_time: null, schedule_days: null, ends_at: null, max_runs: null, ...extra });
  const tasks = [row(1, "cancelled"), row(2, "completed"), row(3, "paused", { title: "Daily\nreport", schedule_kind: "daily",
    schedule_time: "09:00", timezone: "Asia/Singapore" })];
  for (let id = 4; id <= 30; id++) tasks.push(row(id, "active"));
  const text = taskBlockInstruction(tasks, "Asia/Singapore", now);
  assert.match(text, /inoai-task/);
  assert.match(text, /"kind":"weekly"/);
  assert.match(text, /\{"action":"run"\|"pause"\|"resume"\|"cancel","task":12\}/);
  assert.match(text, /task is the Task ID number without #\./);
  assert.match(text, /Default time zone: Asia\/Singapore/);
  assert.match(text, new RegExp(`unix ${now}`));
  const listed = text.split("\n").filter((line) => line.startsWith("- #"));
  assert.equal(listed.length, 20);
  assert.equal(listed[0], "- #11 Goal 11: every 2 hours");
  assert.equal(listed.at(-1), "- #30 Goal 30: every 2 hours");
  const few = taskBlockInstruction(tasks.slice(0, 5), "Asia/Singapore", now);
  assert.match(few, /- #3 Daily report: daily at 09:00 \(Asia\/Singapore\) \(paused\)/);
  assert.doesNotMatch(few, /#1 |#2 /);
  assert.match(taskBlockInstruction([], "UTC", now), /Current Tasks: none\./);
  assert.ok(text.length < 3000, `instruction is ${text.length} characters`);
});

test("extractTaskBlock strips fence variants and parses their JSON", () => {
  const json = '{"action":"run","task":7}';
  const cases: Array<[string, string]> = [
    ["info string after the tag", "```inoai-task json\n" + json + "\n```"],
    ["tag in second position", "```json inoai-task\n" + json + "\n```"],
    ["four backticks", "````inoai-task\n" + json + "\n```\n````"],
    ["tilde fence", "~~~inoai-task\n" + json + "\n```\n~~~"],
    ["JSON on the fence line", "```inoai-task " + json + "\n```"],
    ["JSON and close on the fence line", "```inoai-task " + json + "```"],
    ["quoted with > ", "> ```inoai-task\n> " + json + "\n> ```"],
    ["upper-case tag", "```INOAI-TASK\n" + json + "\n```"],
    ["four-space indent", "    ```inoai-task\n    " + json + "\n    ```"],
    ["list item", "- ```inoai-task\n  " + json + "\n  ```"],
  ];
  for (const [name, fenced] of cases) {
    const extracted = extractTaskBlock(`Before.\n${fenced}\nAfter.`);
    assert.equal(extracted.found, true, name);
    if (!extracted.found) continue;
    assert.equal(extracted.answer, "Before.\nAfter.", name);
    assert.doesNotMatch(extracted.answer, /inoai-task|"action"/i, name);
    if (name === "four backticks" || name === "tilde fence") {
      // The inner ``` line belongs to the body, so JSON.parse fails; the block is still removed.
      assert.deepEqual(extracted.parsed, { ok: false }, name);
    } else assert.deepEqual(extracted.parsed, { ok: true, value: { action: "run", task: 7 } }, name);
  }
  const fourClean = extractTaskBlock("````inoai-task\n" + json + "\n````");
  assert.deepEqual(fourClean, { found: true, answer: "", parsed: { ok: true, value: { action: "run", task: 7 } } });
  const tildeClean = extractTaskBlock("~~~ inoai-task\n" + json + "\n~~~");
  assert.deepEqual(tildeClean, { found: true, answer: "", parsed: { ok: true, value: { action: "run", task: 7 } } });
});

test("extractTaskBlock keeps nested and fenced JSON cases working", () => {
  const nested = extractTaskBlock("````md\n```inoai-task\n{\"action\":\"run\",\"task\":1}\n```\n````");
  assert.deepEqual(nested, { found: true, answer: "````md\n````", parsed: { ok: true, value: { action: "run", task: 1 } } });
  const fenceInString = extractTaskBlock("```inoai-task\n{\"action\":\"create\",\"instruction\":\"use ``` fences\"}\n```\nDone");
  assert.equal(fenceInString.found && fenceInString.answer, "Done");
  assert.deepEqual(fenceInString.found && fenceInString.parsed, { ok: true, value: { action: "create", instruction: "use ``` fences" } });
  const tildeOnBacktick = extractTaskBlock("```inoai-task\n{\"action\":\"run\",\"task\":1}\n~~~\nleak?");
  assert.deepEqual(tildeOnBacktick, { found: true, answer: "", parsed: { ok: false } });
  assert.deepEqual(extractTaskBlock("No block: inoai-task is a word here."), { found: false, answer: "No block: inoai-task is a word here." });
  assert.deepEqual(extractTaskBlock("```my-inoai-tasks\n{}\n```"), { found: false, answer: "```my-inoai-tasks\n{}\n```" });
});

test("extractTaskBlock cuts a leftover tagged fence to the end and marks the block invalid", () => {
  const inline = extractTaskBlock('See ```inoai-task {"action":"run","task":1}``` now.\nMore text.');
  assert.deepEqual(inline, { found: true, answer: "", parsed: { ok: false } });
  const afterValid = extractTaskBlock('```inoai-task\n{"action":"run","task":1}\n```\nText x ~~~inoai-task {"action":"pause","task":2}');
  assert.deepEqual(afterValid, { found: true, answer: "", parsed: { ok: false } });
  const result = validateTaskBlock(inline as Extract<typeof inline, { found: true }>, owner);
  assert.equal(!result.ok && result.rejection.reason, "invalid_json");
});

test("extractTaskBlock cuts from the start of the line, so JSON before the fence does not remain", () => {
  const extracted = extractTaskBlock('Kept line.\n{"action":"run","task":1} ```inoai-task\nTail.');
  assert.deepEqual(extracted, { found: true, answer: "Kept line.", parsed: { ok: false } });
  assert.doesNotMatch(extracted.answer, /action|inoai-task|\{/);
});

test("extractTaskBlock stays linear on a long fence run before a bare CR or line separator", () => {
  // The quadratic opener took about 944 ms here; the linear one takes well under 1 ms. The bound leaves room for a loaded machine.
  for (const char of ["`", "~"]) {
    for (const separator of ["\r", " "]) {
      const answer = char.repeat(50_000) + separator + "x";
      const started = performance.now();
      const extracted = extractTaskBlock(answer);
      const elapsed = performance.now() - started;
      assert.ok(elapsed < 250, `${JSON.stringify(char + separator)} took ${elapsed} ms`);
      assert.deepEqual(extracted, { found: false, answer });
    }
  }
});

test("extractTaskBlock stays linear on long fence-character and space lines", () => {
  for (const char of ["`", "~", " "]) {
    for (const answer of [char.repeat(50_000), `Hi\n${char.repeat(50_000)}x\nBye`, "```inoai-task\n" + char.repeat(50_000) + "x"]) {
      const started = performance.now();
      const extracted = extractTaskBlock(answer);
      const elapsed = performance.now() - started;
      assert.ok(elapsed < 500, `${JSON.stringify(char)} took ${elapsed} ms`);
      if (!answer.startsWith("```inoai-task")) assert.deepEqual(extracted, { found: false, answer });
    }
  }
  for (const char of ["`", "~"]) {
    const started = performance.now();
    const extracted = extractTaskBlock(`Keep.\n${char.repeat(50_000)} inoai-task\n{"action":"run","task":1}`);
    assert.ok(performance.now() - started < 500);
    assert.deepEqual(extracted, { found: true, answer: "Keep.", parsed: { ok: false } });
    // Text before the fence: the reader skips the line and the safety net cuts it.
    const netStarted = performance.now();
    const net = extractTaskBlock(`Keep.\nx ${char.repeat(50_000)}inoai-task {"action":"run","task":1}\nTail`);
    assert.ok(performance.now() - netStarted < 500);
    assert.deepEqual(net, { found: true, answer: "Keep.", parsed: { ok: false } });
  }
});
