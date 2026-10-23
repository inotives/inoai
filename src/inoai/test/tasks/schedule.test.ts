import assert from "node:assert/strict";
import test from "node:test";

import { describeSchedule, nextRunAt, taskSpecFromRow, toTaskColumns, validateTaskSpec, type Schedule, type TaskSpec } from "../../tasks/schedule.js";

const at = (iso: string) => Date.parse(iso) / 1000;
const spec = (schedule: Schedule, timezone: string, extra: Partial<TaskSpec> = {}): TaskSpec => ({
  title: "Report", instruction: "Summarize failing CI", expectedOutput: null, schedule, timezone,
  endsAt: null, maxRuns: null, ...extra,
});

test("validateTaskSpec normalizes valid input", () => {
  const now = at("2026-10-23T00:00:00Z");
  const result = validateTaskSpec({
    title: "  CI summary ", instruction: "  Summarize failing CI  ", expectedOutput: "   ",
    schedule: { kind: "days", time: "09:00", days: ["fri", "mon", "mon", "wed"] }, timezone: "Asia/Singapore", maxRuns: 3,
  }, now);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(result.spec, {
    title: "CI summary", instruction: "Summarize failing CI", expectedOutput: null,
    schedule: { kind: "days", time: "09:00", days: ["mon", "wed", "fri"] }, timezone: "Asia/Singapore", endsAt: null, maxRuns: 3,
  });
  const once = validateTaskSpec({ title: "t", instruction: "i", schedule: { kind: "once" }, timezone: "UTC" }, now);
  assert.equal(once.ok && once.spec.schedule.kind === "once" && once.spec.schedule.at, null);
});

test("validateTaskSpec rejects bad input with field errors", () => {
  const now = at("2026-10-23T00:00:00Z");
  const base = { title: "t", instruction: "i", schedule: { kind: "daily", time: "09:00" }, timezone: "Europe/London" };
  const errorsOf = (input: unknown) => {
    const result = validateTaskSpec(input, now);
    assert.equal(result.ok, false, JSON.stringify(input));
    return result.ok ? {} : result.errors;
  };
  assert.match(errorsOf({ ...base, instruction: "   " }).instruction, /required/);
  assert.match(errorsOf({ ...base, instruction: "x".repeat(4001) }).instruction, /4000/);
  assert.equal(validateTaskSpec({ ...base, instruction: "x".repeat(4000) }, now).ok, true);
  assert.match(errorsOf({ ...base, expectedOutput: "x".repeat(2001) }).expectedOutput, /2000/);
  assert.match(errorsOf({ ...base, title: "" }).title, /required/);
  assert.match(errorsOf({ ...base, title: "x".repeat(101) }).title, /100/);
  for (const hours of [0, 1.5, "2", -3]) {
    assert.match(errorsOf({ ...base, schedule: { kind: "interval", hours } })["schedule.hours"], /whole number/);
  }
  for (const time of ["9:00", "24:00", "09:60", "0900", undefined]) {
    assert.match(errorsOf({ ...base, schedule: { kind: "daily", time } })["schedule.time"], /HH:MM/);
  }
  assert.match(errorsOf({ ...base, schedule: { kind: "days", time: "09:00", days: [] } })["schedule.days"], /at least one/);
  assert.match(errorsOf({ ...base, schedule: { kind: "days", time: "09:00", days: ["mon", "funday"] } })["schedule.days"], /at least one/);
  assert.match(errorsOf({ ...base, schedule: { kind: "weekly", time: "09:00" } })["schedule.day"], /Day must be/);
  assert.match(errorsOf({ ...base, schedule: { kind: "cron" } })["schedule.kind"], /must be one of/);
  assert.match(errorsOf({ ...base, schedule: { kind: "once", at: now - 60 } })["schedule.at"], /past/);
  for (const timezone of ["Mars/Olympus", "", "+08:00", undefined]) {
    assert.match(errorsOf({ ...base, timezone }).timezone, /IANA/);
  }
  for (const maxRuns of [0, -1, 1.5]) assert.match(errorsOf({ ...base, maxRuns }).maxRuns, /at least 1/);
  assert.match(errorsOf({ ...base, endsAt: now - 1 }).endsAt, /future/);
  assert.match(errorsOf({ ...base, endsAt: now + 60 }).endsAt, /before the first run/);
  assert.match(errorsOf({ ...base, schedule: { kind: "once" }, maxRuns: 2 }).schedule, /one-time/);
  assert.deepEqual(Object.keys(errorsOf(null)).sort(), ["instruction", "schedule.kind", "timezone", "title"]);
});

test("nextRunAt handles once and interval schedules in two time zones", () => {
  const after = at("2026-03-07T14:00:00Z");
  for (const timezone of ["America/New_York", "Asia/Singapore"]) {
    assert.equal(nextRunAt(spec({ kind: "once", at: null }, timezone), after, 0), after);
    assert.equal(nextRunAt(spec({ kind: "once", at: after + 600 }, timezone), after, 0), after + 600);
    assert.equal(nextRunAt(spec({ kind: "once", at: after + 600 }, timezone), after, 1), null);
    // Intervals are elapsed hours, so a 24-hour interval shifts local time across DST.
    assert.equal(nextRunAt(spec({ kind: "interval", hours: 24 }, timezone), after, 5), at("2026-03-08T14:00:00Z"));
    assert.equal(nextRunAt(spec({ kind: "interval", hours: 1 }, timezone), after, 0), after + 3600);
  }
});

test("nextRunAt daily schedules follow local time across DST in New York and London", () => {
  const ny = (time: string) => spec({ kind: "daily", time }, "America/New_York");
  // Spring forward: 2026-03-08 02:00 EST -> 03:00 EDT.
  assert.equal(nextRunAt(ny("09:00"), at("2026-03-07T15:00:00Z"), 0), at("2026-03-08T13:00:00Z"));
  assert.equal(nextRunAt(ny("09:00"), at("2026-03-06T15:00:00Z"), 0), at("2026-03-07T14:00:00Z"));
  // Skipped local time runs at the next valid instant (03:00 EDT), then normally the next day.
  assert.equal(nextRunAt(ny("02:30"), at("2026-03-07T12:00:00Z"), 0), at("2026-03-08T07:00:00Z"));
  assert.equal(nextRunAt(ny("02:30"), at("2026-03-08T07:00:00Z"), 1), at("2026-03-09T06:30:00Z"));
  // Fall back: 2026-11-01 02:00 EDT -> 01:00 EST. The repeated 01:30 runs once.
  assert.equal(nextRunAt(ny("01:30"), at("2026-10-31T12:00:00Z"), 0), at("2026-11-01T05:30:00Z"));
  assert.equal(nextRunAt(ny("01:30"), at("2026-11-01T05:30:00Z"), 1), at("2026-11-02T06:30:00Z"));

  const london = (time: string) => spec({ kind: "daily", time }, "Europe/London");
  // Spring forward: 2026-03-29 01:00 GMT -> 02:00 BST.
  assert.equal(nextRunAt(london("01:30"), at("2026-03-28T12:00:00Z"), 0), at("2026-03-29T01:00:00Z"));
  assert.equal(nextRunAt(london("09:00"), at("2026-03-28T12:00:00Z"), 0), at("2026-03-29T08:00:00Z"));
  // Fall back: 2026-10-25 02:00 BST -> 01:00 GMT.
  assert.equal(nextRunAt(london("01:30"), at("2026-10-24T12:00:00Z"), 0), at("2026-10-25T00:30:00Z"));
  assert.equal(nextRunAt(london("01:30"), at("2026-10-25T00:30:00Z"), 1), at("2026-10-26T01:30:00Z"));

  // No DST in Singapore.
  assert.equal(nextRunAt(spec({ kind: "daily", time: "09:00" }, "Asia/Singapore"), at("2026-10-23T01:00:00Z"), 0), at("2026-10-24T01:00:00Z"));
});

test("nextRunAt selected days skip other days, including a weekend", () => {
  const weekdaysSg = spec({ kind: "days", time: "09:00", days: ["mon", "tue", "wed", "thu", "fri"] }, "Asia/Singapore");
  // Friday 2026-10-23 10:00 SGT -> Monday 2026-10-26 09:00 SGT.
  assert.equal(nextRunAt(weekdaysSg, at("2026-10-23T02:00:00Z"), 0), at("2026-10-26T01:00:00Z"));
  // Friday before 09:00 still runs that day.
  assert.equal(nextRunAt(weekdaysSg, at("2026-10-23T00:00:00Z"), 0), at("2026-10-23T01:00:00Z"));

  const mwfNy = spec({ kind: "days", time: "08:00", days: ["mon", "wed", "fri"] }, "America/New_York");
  // Friday 2026-10-30 after 08:00 EDT -> Monday 2026-11-02 08:00 EST, across the fall-back weekend.
  assert.equal(nextRunAt(mwfNy, at("2026-10-30T13:00:00Z"), 0), at("2026-11-02T13:00:00Z"));
  // Saturday before spring forward -> Monday 2026-03-09 08:00 EDT.
  assert.equal(nextRunAt(mwfNy, at("2026-03-07T12:00:00Z"), 0), at("2026-03-09T12:00:00Z"));
});

test("nextRunAt weekly schedules run once a week across DST", () => {
  const london = spec({ kind: "weekly", time: "09:00", day: "mon" }, "Europe/London");
  // Exactly at Monday 2026-10-19 09:00 BST -> next Monday 09:00 GMT.
  assert.equal(nextRunAt(london, at("2026-10-19T08:00:00Z"), 1), at("2026-10-26T09:00:00Z"));
  const ny = spec({ kind: "weekly", time: "09:00", day: "sun" }, "America/New_York");
  // Sunday 2026-03-01 after 09:00 EST -> Sunday 2026-03-08 09:00 EDT.
  assert.equal(nextRunAt(ny, at("2026-03-01T15:00:00Z"), 1), at("2026-03-08T13:00:00Z"));
  const sydney = spec({ kind: "weekly", time: "02:30", day: "sun" }, "Australia/Sydney");
  // Sydney spring forward 2026-10-04 02:00 AEST -> 03:00 AEDT; skipped 02:30 runs at 03:00 AEDT.
  assert.equal(nextRunAt(sydney, at("2026-10-01T00:00:00Z"), 0), at("2026-10-03T16:00:00Z"));
});

test("nextRunAt returns null once endsAt or maxRuns is reached", () => {
  const daily = spec({ kind: "daily", time: "09:00" }, "Asia/Singapore", { endsAt: at("2026-10-24T01:00:00Z") });
  assert.equal(nextRunAt(daily, at("2026-10-23T02:00:00Z"), 0), at("2026-10-24T01:00:00Z"));
  assert.equal(nextRunAt(daily, at("2026-10-24T01:00:00Z"), 1), null);
  const limited = spec({ kind: "interval", hours: 2 }, "Europe/London", { maxRuns: 3 });
  assert.equal(nextRunAt(limited, 1000, 2), 1000 + 7200);
  assert.equal(nextRunAt(limited, 1000, 3), null);
  const both = spec({ kind: "weekly", time: "09:00", day: "mon" }, "America/New_York", { maxRuns: 5, endsAt: at("2026-11-01T00:00:00Z") });
  assert.equal(nextRunAt(both, at("2026-10-27T00:00:00Z"), 1), null);
});

test("toTaskColumns maps each kind to the task columns", () => {
  const now = at("2026-10-23T02:00:00Z");
  const tz = "Asia/Singapore";
  assert.deepEqual(toTaskColumns(spec({ kind: "once", at: null }, tz, { expectedOutput: "A list" }), now), {
    goal: "Summarize failing CI", task_type: "one_time", interval_seconds: null, next_due_at: now, title: "Report",
    output_spec: "A list", timezone: tz, schedule_kind: "once", schedule_time: null, schedule_days: null, ends_at: null, max_runs: null,
  });
  assert.equal(toTaskColumns(spec({ kind: "once", at: now + 60 }, tz), now).next_due_at, now + 60);
  const interval = toTaskColumns(spec({ kind: "interval", hours: 3 }, tz, { maxRuns: 4 }), now);
  assert.deepEqual([interval.task_type, interval.interval_seconds, interval.next_due_at, interval.max_runs], ["recurring", 10800, now + 10800, 4]);
  const days = toTaskColumns(spec({ kind: "days", time: "09:00", days: ["mon", "fri"] }, tz), now);
  assert.deepEqual([days.task_type, days.interval_seconds, days.schedule_time, days.schedule_days, days.next_due_at],
    ["recurring", 86400, "09:00", "mon,fri", at("2026-10-26T01:00:00Z")]);
  const weekly = toTaskColumns(spec({ kind: "weekly", time: "18:30", day: "sun" }, tz), now);
  assert.deepEqual([weekly.interval_seconds, weekly.schedule_days, weekly.next_due_at], [86400, "sun", at("2026-10-25T10:30:00Z")]);
  const daily = toTaskColumns(spec({ kind: "daily", time: "09:00" }, tz, { endsAt: now + 864000 }), now);
  assert.deepEqual([daily.interval_seconds, daily.schedule_days, daily.ends_at], [86400, null, now + 864000]);
  assert.throws(() => toTaskColumns(spec({ kind: "daily", time: "09:00" }, tz, { endsAt: now + 60 }), now), RangeError);
});

test("describeSchedule returns short plain-English labels", () => {
  assert.equal(describeSchedule(spec({ kind: "days", time: "09:00", days: ["mon", "tue", "wed", "thu", "fri"] }, "Asia/Singapore")),
    "weekdays at 09:00 (Asia/Singapore)");
  assert.equal(describeSchedule(spec({ kind: "days", time: "10:00", days: ["sat", "sun"] }, "UTC")), "weekends at 10:00 (UTC)");
  assert.equal(describeSchedule(spec({ kind: "days", time: "10:00", days: ["mon", "wed"] }, "UTC")), "Mon, Wed at 10:00 (UTC)");
  assert.equal(describeSchedule(spec({ kind: "daily", time: "07:15" }, "Europe/London")), "daily at 07:15 (Europe/London)");
  assert.equal(describeSchedule(spec({ kind: "weekly", time: "09:00", day: "mon" }, "UTC", { maxRuns: 4 })), "weekly on Monday at 09:00 (UTC), up to 4 runs");
  assert.equal(describeSchedule(spec({ kind: "interval", hours: 1 }, "UTC")), "every hour");
  assert.equal(describeSchedule(spec({ kind: "interval", hours: 6 }, "UTC", { endsAt: at("2026-12-31T10:00:00Z") })),
    "every 6 hours, until 2026-12-31 10:00");
  assert.equal(describeSchedule(spec({ kind: "once", at: null }, "UTC")), "once, now");
  assert.equal(describeSchedule(spec({ kind: "once", at: at("2026-10-24T01:00:00Z") }, "Asia/Singapore")),
    "once at 2026-10-24 09:00 (Asia/Singapore)");
});

test("taskSpecFromRow rebuilds each stored schedule and ignores legacy or invalid rows", () => {
  const now = at("2026-10-23T00:00:00Z");
  const schedules: Schedule[] = [{ kind: "once", at: now + 3600 }, { kind: "interval", hours: 4 }, { kind: "daily", time: "09:00" },
    { kind: "days", time: "09:00", days: ["mon", "fri"] }, { kind: "weekly", time: "18:30", day: "sun" }];
  for (const schedule of schedules) {
    const original = spec(schedule, "Asia/Singapore", { expectedOutput: "List", maxRuns: schedule.kind === "once" ? null : 3 });
    const columns = toTaskColumns(original, now);
    assert.deepEqual(taskSpecFromRow(columns), original, schedule.kind);
  }
  const legacy = { ...toTaskColumns(spec({ kind: "daily", time: "09:00" }, "UTC"), now), schedule_kind: null };
  assert.equal(taskSpecFromRow(legacy), null);
  const daily = toTaskColumns(spec({ kind: "daily", time: "09:00" }, "UTC"), now);
  assert.equal(taskSpecFromRow({ ...daily, schedule_time: "9am" }), null);
  assert.equal(taskSpecFromRow({ ...daily, schedule_kind: "days", schedule_days: "mon,funday" }), null);
  assert.equal(taskSpecFromRow({ ...daily, timezone: "Not/AZone" }), null);
});
