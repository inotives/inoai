// Pure Task schedule rules shared by the agent and the UI server. No I/O.

export const weekdays = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const;
export type Weekday = typeof weekdays[number];
export const scheduleKinds = ["once", "interval", "daily", "days", "weekly"] as const;
export type ScheduleKind = typeof scheduleKinds[number];

export type Schedule =
  | { kind: "once"; at: number | null }
  | { kind: "interval"; hours: number }
  | { kind: "daily"; time: string }
  | { kind: "days"; time: string; days: Weekday[] }
  | { kind: "weekly"; time: string; day: Weekday };

export type TaskSpec = {
  title: string;
  instruction: string;
  expectedOutput: string | null;
  schedule: Schedule;
  timezone: string;
  endsAt: number | null;
  maxRuns: number | null;
};

export type TaskSpecErrors = Record<string, string>;
export type TaskSpecResult = { ok: true; spec: TaskSpec } | { ok: false; errors: TaskSpecErrors };

export type TaskColumns = {
  goal: string;
  task_type: "one_time" | "recurring";
  interval_seconds: number | null;
  next_due_at: number;
  title: string;
  output_spec: string | null;
  timezone: string;
  schedule_kind: ScheduleKind;
  schedule_time: string | null;
  schedule_days: string | null;
  ends_at: number | null;
  max_runs: number | null;
};

export const titleMaxLength = 100;
export const instructionMaxLength = 4000;
export const expectedOutputMaxLength = 2000;

const timePattern = /^([01]\d|2[0-3]):([0-5]\d)$/;
const dayNames: Record<Weekday, string> = {
  mon: "Monday", tue: "Tuesday", wed: "Wednesday", thu: "Thursday", fri: "Friday", sat: "Saturday", sun: "Sunday",
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isUnixSeconds(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isWeekday(value: unknown): value is Weekday {
  return typeof value === "string" && (weekdays as readonly string[]).includes(value);
}

/** Returns the canonical IANA name, or null when the time zone is unknown. */
export function normalizeTimeZone(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim() || /^[+-]/.test(value.trim())) return null;
  try {
    return new Intl.DateTimeFormat("en-US", { timeZone: value.trim() }).resolvedOptions().timeZone;
  } catch {
    return null;
  }
}

function optionalText(value: unknown): string | null | undefined {
  if (value == null) return null;
  if (typeof value !== "string") return undefined;
  return value.trim() || null;
}

export function validateTaskSpec(input: unknown, now = Math.floor(Date.now() / 1000)): TaskSpecResult {
  const errors: TaskSpecErrors = {};
  const source = isRecord(input) ? input : {};

  const title = optionalText(source.title);
  if (!title) errors.title = "Title is required.";
  else if (title.length > titleMaxLength) errors.title = `Title must be at most ${titleMaxLength} characters.`;

  const instruction = optionalText(source.instruction);
  if (!instruction) errors.instruction = "Instruction is required.";
  else if (instruction.length > instructionMaxLength) errors.instruction = `Instruction must be at most ${instructionMaxLength} characters.`;

  const expectedOutput = optionalText(source.expectedOutput);
  if (expectedOutput === undefined) errors.expectedOutput = "Expected output must be text.";
  else if (expectedOutput && expectedOutput.length > expectedOutputMaxLength) {
    errors.expectedOutput = `Expected output must be at most ${expectedOutputMaxLength} characters.`;
  }

  const timezone = normalizeTimeZone(source.timezone);
  if (!timezone) errors.timezone = "Time zone must be a known IANA name, for example Asia/Singapore.";

  const schedule = validateSchedule(source.schedule, now, errors);

  let endsAt: number | null = null;
  if (source.endsAt != null) {
    if (!isUnixSeconds(source.endsAt)) errors.endsAt = "Stop date must be a time in unix seconds.";
    else if (source.endsAt <= now) errors.endsAt = "Stop date must be in the future.";
    else endsAt = source.endsAt;
  }

  let maxRuns: number | null = null;
  if (source.maxRuns != null) {
    if (typeof source.maxRuns !== "number" || !Number.isSafeInteger(source.maxRuns) || source.maxRuns < 1) {
      errors.maxRuns = "Run limit must be a whole number of at least 1.";
    } else maxRuns = source.maxRuns;
  }

  if (schedule?.kind === "once" && (source.endsAt != null || source.maxRuns != null)) {
    errors.schedule = "A one-time schedule cannot have a stop date or run limit.";
  }

  if (Object.keys(errors).length > 0) return { ok: false, errors };
  const spec: TaskSpec = { title: title!, instruction: instruction!, expectedOutput: expectedOutput ?? null,
    schedule: schedule!, timezone: timezone!, endsAt, maxRuns };
  if (nextRunAt(spec, now, 0) === null) return { ok: false, errors: { endsAt: "Stop date is before the first run." } };
  return { ok: true, spec };
}

function validateSchedule(input: unknown, now: number, errors: TaskSpecErrors): Schedule | undefined {
  if (!isRecord(input) || !(scheduleKinds as readonly unknown[]).includes(input.kind)) {
    errors["schedule.kind"] = `Schedule kind must be one of: ${scheduleKinds.join(", ")}.`;
    return undefined;
  }
  const kind = input.kind as ScheduleKind;
  if (kind === "once") {
    if (input.at == null) return { kind, at: null };
    if (!isUnixSeconds(input.at)) errors["schedule.at"] = "Run time must be a time in unix seconds.";
    else if (input.at < now) errors["schedule.at"] = "Run time must not be in the past.";
    else return { kind, at: input.at };
    return undefined;
  }
  if (kind === "interval") {
    if (typeof input.hours !== "number" || !Number.isSafeInteger(input.hours) || input.hours < 1) {
      errors["schedule.hours"] = "Interval must be a whole number of hours, at least 1.";
      return undefined;
    }
    return { kind, hours: input.hours };
  }
  const time = typeof input.time === "string" && timePattern.test(input.time) ? input.time : undefined;
  if (!time) errors["schedule.time"] = "Time must be HH:MM in 24-hour format.";
  if (kind === "daily") return time ? { kind, time } : undefined;
  if (kind === "weekly") {
    if (!isWeekday(input.day)) {
      errors["schedule.day"] = "Day must be one of: mon, tue, wed, thu, fri, sat, sun.";
      return undefined;
    }
    return time ? { kind, time, day: input.day } : undefined;
  }
  if (!Array.isArray(input.days) || input.days.length === 0 || !input.days.every(isWeekday)) {
    errors["schedule.days"] = "Choose at least one day from: mon, tue, wed, thu, fri, sat, sun.";
    return undefined;
  }
  const days = weekdays.filter((day) => (input.days as unknown[]).includes(day));
  return time ? { kind, time, days } : undefined;
}

// Local-time math with Intl.DateTimeFormat only.

const formatters = new Map<string, Intl.DateTimeFormat>();
function formatter(timeZone: string): Intl.DateTimeFormat {
  let value = formatters.get(timeZone);
  if (!value) {
    value = new Intl.DateTimeFormat("en-US", { timeZone, hourCycle: "h23", year: "numeric", month: "numeric",
      day: "numeric", hour: "numeric", minute: "numeric", second: "numeric" });
    formatters.set(timeZone, value);
  }
  return value;
}

type LocalParts = { year: number; month: number; day: number; hour: number; minute: number; second: number };
function localParts(unixSeconds: number, timeZone: string): LocalParts {
  const parts: Record<string, number> = {};
  for (const { type, value } of formatter(timeZone).formatToParts(new Date(unixSeconds * 1000))) {
    if (type !== "literal") parts[type] = Number(value);
  }
  return { year: parts.year, month: parts.month, day: parts.day, hour: parts.hour, minute: parts.minute, second: parts.second };
}

/** Local wall-clock time of an instant, expressed as if it were UTC seconds. */
function wallSeconds(unixSeconds: number, timeZone: string): number {
  const p = localParts(unixSeconds, timeZone);
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) / 1000;
}

function offsetAt(unixSeconds: number, timeZone: string): number {
  return wallSeconds(unixSeconds, timeZone) - unixSeconds;
}

/**
 * Resolves a local wall-clock time to an instant. A repeated local time resolves
 * to its first instant. A skipped local time resolves to the first valid instant
 * after the gap.
 */
function localToUnix(year: number, month: number, day: number, hour: number, minute: number, timeZone: string): number {
  const wall = Date.UTC(year, month - 1, day, hour, minute) / 1000;
  const guesses = [wall - offsetAt(wall - 86400, timeZone), wall - offsetAt(wall + 86400, timeZone)];
  const valid = guesses.filter((candidate) => wallSeconds(candidate, timeZone) === wall).sort((a, b) => a - b);
  if (valid.length > 0) return valid[0];
  let low = Math.min(...guesses);
  let high = Math.max(...guesses);
  const target = offsetAt(high, timeZone);
  while (high - low > 60) {
    const middle = low + Math.floor((high - low) / 120) * 60;
    if (offsetAt(middle, timeZone) === target) high = middle;
    else low = middle;
  }
  return high;
}

function parseTime(time: string): [number, number] {
  const [hour, minute] = time.split(":").map(Number);
  return [hour, minute];
}

function dayFilter(schedule: Schedule): ReadonlySet<Weekday> | null {
  if (schedule.kind === "days") return new Set(schedule.days);
  if (schedule.kind === "weekly") return new Set([schedule.day]);
  return null;
}

function nextClockRun(schedule: Extract<Schedule, { time: string }>, timeZone: string, after: number): number {
  const [hour, minute] = parseTime(schedule.time);
  const allowed = dayFilter(schedule);
  const start = localParts(after, timeZone);
  for (let offset = 0; offset <= 8; offset += 1) {
    const date = new Date(Date.UTC(start.year, start.month - 1, start.day + offset));
    const weekday = weekdays[(date.getUTCDay() + 6) % 7];
    if (allowed && !allowed.has(weekday)) continue;
    const at = localToUnix(date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate(), hour, minute, timeZone);
    if (at > after) return at;
  }
  throw new Error("No scheduled day found within eight days");
}

/**
 * Returns the next run time after `afterUnixSeconds` in unix seconds, or null when
 * a stop condition is reached. Clock times use the task's time zone. Intervals are
 * elapsed hours. A one-time task without `at` runs at `afterUnixSeconds`.
 */
export function nextRunAt(spec: TaskSpec, afterUnixSeconds: number, runsSoFar: number): number | null {
  const { schedule } = spec;
  if (schedule.kind === "once" && runsSoFar >= 1) return null;
  if (spec.maxRuns != null && runsSoFar >= spec.maxRuns) return null;
  const next = schedule.kind === "once" ? schedule.at ?? afterUnixSeconds
    : schedule.kind === "interval" ? afterUnixSeconds + schedule.hours * 3600
      : nextClockRun(schedule, spec.timezone, afterUnixSeconds);
  if (spec.endsAt != null && next > spec.endsAt) return null;
  return next;
}

export function toTaskColumns(spec: TaskSpec, now = Math.floor(Date.now() / 1000)): TaskColumns {
  const { schedule } = spec;
  const nextDueAt = nextRunAt(spec, now, 0);
  if (nextDueAt === null) throw new RangeError("Task schedule has no run before its stop condition");
  return {
    goal: spec.instruction,
    task_type: schedule.kind === "once" ? "one_time" : "recurring",
    interval_seconds: schedule.kind === "once" ? null : schedule.kind === "interval" ? schedule.hours * 3600 : 86400,
    next_due_at: nextDueAt,
    title: spec.title,
    output_spec: spec.expectedOutput,
    timezone: spec.timezone,
    schedule_kind: schedule.kind,
    schedule_time: "time" in schedule ? schedule.time : null,
    schedule_days: schedule.kind === "days" ? schedule.days.join(",") : schedule.kind === "weekly" ? schedule.day : null,
    ends_at: spec.endsAt,
    max_runs: spec.maxRuns,
  };
}

function formatLocal(unixSeconds: number, timeZone: string): string {
  const p = localParts(unixSeconds, timeZone);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${p.year}-${pad(p.month)}-${pad(p.day)} ${pad(p.hour)}:${pad(p.minute)}`;
}

function describeDays(days: readonly Weekday[]): string {
  const key = days.join(",");
  if (key === "mon,tue,wed,thu,fri") return "weekdays";
  if (key === "sat,sun") return "weekends";
  if (days.length === 7) return "daily";
  return days.map((day) => dayNames[day].slice(0, 3)).join(", ");
}

/** Returns a short plain-English label, for example "weekdays at 09:00 (Asia/Singapore)". */
export function describeSchedule(spec: TaskSpec): string {
  const { schedule, timezone } = spec;
  let label: string;
  if (schedule.kind === "once") {
    label = schedule.at == null ? "once, now" : `once at ${formatLocal(schedule.at, timezone)} (${timezone})`;
  } else if (schedule.kind === "interval") {
    label = schedule.hours === 1 ? "every hour" : `every ${schedule.hours} hours`;
  } else if (schedule.kind === "daily") {
    label = `daily at ${schedule.time} (${timezone})`;
  } else if (schedule.kind === "weekly") {
    label = `weekly on ${dayNames[schedule.day]} at ${schedule.time} (${timezone})`;
  } else {
    label = `${describeDays(schedule.days)} at ${schedule.time} (${timezone})`;
  }
  if (spec.endsAt != null) label += `, until ${formatLocal(spec.endsAt, timezone)}`;
  if (spec.maxRuns != null) label += spec.maxRuns === 1 ? ", 1 run" : `, up to ${spec.maxRuns} runs`;
  return label;
}
