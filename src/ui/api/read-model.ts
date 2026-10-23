import { DatabaseSync } from "node:sqlite";
import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { inspectRuntimeHomeLock, type RuntimeHome } from "../../inoai/agent-instance/runtime-home.js";
import { validateEnabledSkills, type EnabledSkillsDocument } from "../../inoai/skills/skill-manifest.js";

type UiMessage = { id: number; workspaceId: string; transport: string; direction: string; state: string; body: string; createdAt: string; updatedAt: string };
type UiSkillFile = { path: string; size: number; text: string | null };
type UiSkill = { id: string; version: string; approvedAt: string; capabilities: Record<string, string | boolean>; files: UiSkillFile[] };
type UiMemory = { id: number; origin: string; state: string; body: string; review: { id: number; state: string; recap: string | null } | null; createdAt: string; updatedAt: string };

export type UiData = {
  profile: { agentInstanceId: string; provider: string; transport: string; workspaceIds: string[]; status: "running" | "stopped" | "unknown" };
  metrics: { messages24h: number; messages30d: number; failedReplies24h: number; failedReplies30d: number; activeSessions: number; messagesPerSession: number };
  agentMarkdown: string;
  skills: string[];
  skillDetails: UiSkill[];
  tools: string[];
  health: Array<{ eventType: string; detail: string | null; createdAt: string }>;
  messages: UiMessage[];
  memories: UiMemory[];
  insights: { "24h": InsightWindow; "7d": InsightWindow; "30d": InsightWindow };
};

type TokenCounts = { input: number; output: number; cached: number; reasoning: number };

export type InsightWindow = {
  bucket: "hour" | "day";
  conversationTypes: { chat: number; oneTime: number; recurring: number };
  volume: Array<{ start: string; owner: number; agent: number }>;
  replyTime: { count: number; medianSeconds: number | null; p90Seconds: number | null };
  failures: Array<{ cause: string; count: number }>;
  taskRuns: { completed: number; failed: number };
  tokens: {
    series: Array<{ start: string } & TokenCounts>;
    totals: TokenCounts & { costUsd: number | null; turns: number };
  };
  skills: Array<{ skill: string; count: number }>;
};

function timestamp(value: number | null): string {
  return value === null ? "" : new Date(value * 1_000).toISOString();
}

function redact(value: string): string {
  return value
    .replace(/(DISCORD_BOT_TOKEN|DISCORD_OWNER_USER_ID|DISCORD_GUILD_ID|DISCORD_STATUS_CHANNEL_ID|API_KEY|TOKEN|PASSWORD)\s*[:=]\s*[^\s,;]+/gi, "$1=[redacted]")
    .replace(/\b(?:sk|ghp|github_pat)_[A-Za-z0-9_-]+\b/g, "[redacted]")
    .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, "Bearer [redacted]");
}

const SKILL_FILE_LIMIT = 200;
const SKILL_TEXT_LIMIT = 64 * 1024;

// Lists regular files in an installed skill package. Symlinks are skipped, and
// only small text files carry their redacted content.
async function readSkillFiles(directory: string): Promise<UiSkillFile[]> {
  const files: UiSkillFile[] = [];
  const walk = async (relativeDirectory: string): Promise<void> => {
    const entries = await readdir(join(directory, relativeDirectory), { withFileTypes: true });
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (files.length >= SKILL_FILE_LIMIT) return;
      const path = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name;
      if (entry.isDirectory()) { await walk(path); continue; }
      if (!entry.isFile()) continue;
      const size = (await stat(join(directory, path))).size;
      let text: string | null = null;
      if (size <= SKILL_TEXT_LIMIT) {
        const content = await readFile(join(directory, path));
        if (!content.includes(0)) text = redact(content.toString("utf8"));
      }
      files.push({ path, size, text });
    }
  };
  await walk("");
  return files.sort((a, b) => Number(b.path === "SKILL.md") - Number(a.path === "SKILL.md"));
}

async function readEnabledSkills(home: RuntimeHome): Promise<UiSkill[]> {
  let document: EnabledSkillsDocument;
  try {
    document = validateEnabledSkills(JSON.parse(await readFile(home.skillsEnabledFile, "utf8")) as EnabledSkillsDocument);
  } catch {
    return [];
  }
  return Promise.all(document.skills.map(async (skill) => ({
    id: skill.id,
    version: skill.version,
    approvedAt: skill.approved_at,
    capabilities: skill.capabilities,
    files: await readSkillFiles(join(home.skillsDirectory, skill.id)).catch(() => []),
  })));
}

// Parses an event detail of the form `key=value; key=value`. Returns undefined
// when any nonempty part is not a key=value pair.
function parseDetail(detail: string | null): Map<string, string> | undefined {
  if (detail === null) return undefined;
  const fields = new Map<string, string>();
  for (const part of detail.split(";").map((item) => item.trim()).filter(Boolean)) {
    const separator = part.indexOf("=");
    if (separator <= 0) return undefined;
    fields.set(part.slice(0, separator).trim(), part.slice(separator + 1).trim());
  }
  return fields;
}

const usageKeys = [["input", "input"], ["output", "output"], ["cached", "cached"], ["reasoning", "reasoning"]] as const;

// Reads one runtime_usage detail. A detail is malformed, and skipped, when a
// token value is not a nonnegative integer, cost is not a nonnegative number,
// or no usage value is present. `provider` and unknown keys are ignored.
function parseUsage(detail: string | null): (Partial<TokenCounts> & { costUsd?: number }) | undefined {
  const fields = parseDetail(detail);
  if (!fields) return undefined;
  const usage: Partial<TokenCounts> & { costUsd?: number } = {};
  for (const [key, field] of usageKeys) {
    const raw = fields.get(key);
    if (raw === undefined) continue;
    if (!/^\d+$/.test(raw)) return undefined;
    usage[field] = Number(raw);
  }
  const cost = fields.get("cost_usd");
  if (cost !== undefined) {
    if (!/^\d+(?:\.\d+)?(?:e-?\d+)?$/i.test(cost)) return undefined;
    usage.costUsd = Number(cost);
  }
  return Object.keys(usage).length ? usage : undefined;
}

const SAFE_TOKEN = /^[A-Za-z0-9_.:-]{1,64}$/;

// Maps a failure event to its chart cause. Free-text turn_failed details have
// no reason key, so they map to a fixed cause instead of exposing their text.
function failureCause(eventType: string, detail: string | null): string {
  if (eventType === "response_delivery_failed") return "delivery_failed";
  const reason = parseDetail(detail)?.get("reason");
  if (reason !== undefined && SAFE_TOKEN.test(reason)) return `${eventType}:${reason}`;
  if (eventType === "turn_failed" && detail !== null) {
    if (/uncertain/i.test(detail)) return "turn_failed:uncertain";
    if (/setup failed/i.test(detail)) return "turn_failed:setup_failed";
  }
  return `${eventType}:unknown`;
}

function percentile(sorted: number[], fraction: number): number | null {
  if (!sorted.length) return null;
  return sorted[Math.max(0, Math.ceil(fraction * sorted.length) - 1)]!;
}

function median(sorted: number[]): number | null {
  if (!sorted.length) return null;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

function sortedCounts<K extends string>(counts: Map<string, number>, key: K): Array<Record<K, string> & { count: number }> {
  return [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([name, count]) => ({ [key]: name, count }) as Record<K, string> & { count: number });
}

// Builds one insights window. Buckets use UTC boundaries: the 24h window has
// 24 hourly buckets ending with the current hour; the 7d and 30d windows have
// daily buckets ending with the current UTC day. Every aggregate in a window
// covers [first bucket start, current bucket end).
function loadInsightWindow(database: DatabaseSync, nowSeconds: number, bucket: "hour" | "day", bucketCount: number): InsightWindow {
  const size = bucket === "hour" ? 3_600 : 86_400;
  const start = Math.floor(nowSeconds / size) * size - (bucketCount - 1) * size;
  const end = start + bucketCount * size;
  const starts = Array.from({ length: bucketCount }, (_, index) => timestamp(start + index * size));
  const bucketOf = (createdAt: number) => Math.floor((createdAt - start) / size);

  const conversationTypes = { chat: 0, oneTime: 0, recurring: 0 };
  // A session is a task session when it has a tasks row. The row's soft
  // deletion does not change the kind of messages already exchanged in it.
  for (const row of database.prepare(`SELECT t.task_type AS taskType, COUNT(*) AS count FROM messages m
      LEFT JOIN tasks t ON t.session_id = m.session_id
      WHERE m.deleted_at IS NULL AND m.created_at >= ? AND m.created_at < ? GROUP BY t.task_type`).all(start, end) as Array<{ taskType: string | null; count: number }>) {
    if (row.taskType === "one_time") conversationTypes.oneTime += row.count;
    else if (row.taskType === "recurring") conversationTypes.recurring += row.count;
    else conversationTypes.chat += row.count;
  }

  const volume = starts.map((bucketStart) => ({ start: bucketStart, owner: 0, agent: 0 }));
  for (const row of database.prepare(`SELECT CAST((created_at - ?) / ? AS INTEGER) AS bucket, direction, COUNT(*) AS count FROM messages
      WHERE deleted_at IS NULL AND created_at >= ? AND created_at < ? GROUP BY bucket, direction`).all(start, size, start, end) as Array<{ bucket: number; direction: string; count: number }>) {
    const item = volume[row.bucket];
    if (!item) continue;
    if (row.direction === "user") item.owner += row.count;
    else if (row.direction === "agent") item.agent += row.count;
  }

  // Reply time uses the in_reply_to_message_id link. Owner messages without a
  // linked agent reply are not counted.
  const replySeconds = (database.prepare(`SELECT MAX(0, MIN(r.created_at) - u.created_at) AS seconds FROM messages u
      JOIN messages r ON r.in_reply_to_message_id = u.id AND r.direction = 'agent' AND r.deleted_at IS NULL
      WHERE u.direction = 'user' AND u.deleted_at IS NULL AND u.created_at >= ? AND u.created_at < ?
      GROUP BY u.id ORDER BY seconds`).all(start, end) as Array<{ seconds: number }>).map((row) => Number(row.seconds));

  const taskRuns = { completed: 0, failed: 0 };
  for (const row of database.prepare(`SELECT state, COUNT(*) AS count FROM task_runs
      WHERE deleted_at IS NULL AND started_at >= ? AND started_at < ? AND state IN ('completed', 'failed') GROUP BY state`).all(start, end) as Array<{ state: "completed" | "failed"; count: number }>) {
    taskRuns[row.state] = row.count;
  }

  const failures = new Map<string, number>();
  const skills = new Map<string, number>();
  const series = starts.map((bucketStart) => ({ start: bucketStart, input: 0, output: 0, cached: 0, reasoning: 0 }));
  const totals = { input: 0, output: 0, cached: 0, reasoning: 0, costUsd: null as number | null, turns: 0 };
  const events = database.prepare(`SELECT event_type AS eventType, detail, created_at AS createdAt FROM events
      WHERE deleted_at IS NULL AND created_at >= ? AND created_at < ?
      AND event_type IN ('runtime_usage', 'skill_selected', 'runtime_failure', 'turn_failed', 'response_delivery_failed')`).all(start, end) as Array<{ eventType: string; detail: string | null; createdAt: number }>;
  for (const event of events) {
    if (event.eventType === "runtime_usage") {
      const usage = parseUsage(event.detail);
      const item = series[bucketOf(event.createdAt)];
      if (!usage || !item) continue;
      for (const [, field] of usageKeys) {
        item[field] += usage[field] ?? 0;
        totals[field] += usage[field] ?? 0;
      }
      if (usage.costUsd !== undefined) totals.costUsd = (totals.costUsd ?? 0) + usage.costUsd;
      totals.turns += 1;
    } else if (event.eventType === "skill_selected") {
      const skill = parseDetail(event.detail)?.get("skill");
      if (skill !== undefined && SAFE_TOKEN.test(skill)) skills.set(skill, (skills.get(skill) ?? 0) + 1);
    } else {
      const cause = failureCause(event.eventType, event.detail);
      failures.set(cause, (failures.get(cause) ?? 0) + 1);
    }
  }
  if (totals.costUsd !== null) totals.costUsd = Number(totals.costUsd.toFixed(6));

  return {
    bucket,
    conversationTypes,
    volume,
    replyTime: { count: replySeconds.length, medianSeconds: median(replySeconds), p90Seconds: percentile(replySeconds, 0.9) },
    failures: sortedCounts(failures, "cause"),
    taskRuns,
    tokens: { series, totals },
    skills: sortedCounts(skills, "skill"),
  };
}

export async function loadUiData(home: RuntimeHome, now = new Date()): Promise<UiData> {
  const [agentMarkdown, skillDetails, lockState] = await Promise.all([
    readFile(home.agentFile, "utf8").then(redact),
    readEnabledSkills(home),
    inspectRuntimeHomeLock(home.lockFile),
  ]);
  const database = new DatabaseSync(home.databaseFile, { readOnly: true });
  try {
    const session = database.prepare("SELECT agent_provider AS provider, transport FROM sessions WHERE deleted_at IS NULL ORDER BY id DESC LIMIT 1").get() as { provider?: string; transport?: string } | undefined;
    const workspaceIds = (database.prepare("SELECT DISTINCT workspace_id AS workspaceId FROM messages WHERE deleted_at IS NULL ORDER BY workspace_id").all() as Array<{ workspaceId: string }>).map((row) => row.workspaceId);
    const messages = (database.prepare("SELECT id, workspace_id AS workspaceId, transport, direction, state, body, created_at AS createdAt, updated_at AS updatedAt FROM messages WHERE deleted_at IS NULL ORDER BY created_at DESC LIMIT 500").all() as Array<UiMessage & { createdAt: number; updatedAt: number }>).map((row) => ({ ...row, body: redact(row.body), createdAt: timestamp(row.createdAt), updatedAt: timestamp(row.updatedAt) }));
    const nowSeconds = Math.floor(now.getTime() / 1_000);
    const countMessages = (since: number, failedOnly: boolean) => Number((database.prepare(`SELECT COUNT(*) AS count FROM messages
      WHERE deleted_at IS NULL AND created_at >= ?${failedOnly ? " AND direction = 'agent' AND state = 'failed'" : ""}`).get(since) as { count: number }).count);
    const messages24h = countMessages(nowSeconds - 86_400, false);
    const activeSessions = Number((database.prepare("SELECT COUNT(*) AS count FROM sessions WHERE state='active' AND deleted_at IS NULL").get() as { count: number }).count);
    const metrics = { messages24h, messages30d: countMessages(nowSeconds - 30 * 86_400, false), failedReplies24h: countMessages(nowSeconds - 86_400, true), failedReplies30d: countMessages(nowSeconds - 30 * 86_400, true), activeSessions, messagesPerSession: activeSessions ? Number((messages24h / activeSessions).toFixed(1)) : 0 };
    const insights = { "24h": loadInsightWindow(database, nowSeconds, "hour", 24), "7d": loadInsightWindow(database, nowSeconds, "day", 7), "30d": loadInsightWindow(database, nowSeconds, "day", 30) };
    const memories = (database.prepare("SELECT m.id, m.origin, m.state, m.body, m.created_at AS createdAt, m.updated_at AS updatedAt, r.id AS reviewId, r.state AS reviewState, r.recap AS reviewRecap FROM memories m LEFT JOIN memory_reviews r ON r.id = m.review_id AND r.deleted_at IS NULL WHERE m.deleted_at IS NULL ORDER BY m.created_at DESC LIMIT 500").all() as Array<UiMemory & { createdAt: number; updatedAt: number; reviewId: number | null; reviewState: string | null; reviewRecap: string | null }>).map((row) => ({ id: row.id, origin: row.origin, state: row.state, body: redact(row.body), review: row.reviewId === null ? null : { id: row.reviewId, state: row.reviewState!, recap: row.reviewRecap === null ? null : redact(row.reviewRecap) }, createdAt: timestamp(row.createdAt), updatedAt: timestamp(row.updatedAt) }));
    const health = (database.prepare("SELECT event_type AS eventType, detail, created_at AS createdAt FROM events WHERE event_type LIKE 'heartbeat%' AND deleted_at IS NULL ORDER BY created_at DESC LIMIT 24").all() as Array<{ eventType: string; detail: string | null; createdAt: number }>).map((row) => ({ eventType: row.eventType, detail: row.detail === null ? null : redact(row.detail), createdAt: timestamp(row.createdAt) }));
    const status = lockState === "live" ? "running" : lockState === "missing" || lockState === "stale" ? "stopped" : "unknown";
    return { profile: { agentInstanceId: home.directory.split("/").pop()?.replace(/^\./, "") ?? "unknown", provider: session?.provider ?? "unknown", transport: session?.transport ?? "unknown", workspaceIds, status }, metrics, agentMarkdown, skills: skillDetails.map((skill) => skill.id), skillDetails, tools: [], health, messages, memories, insights };
  } finally {
    database.close();
  }
}
