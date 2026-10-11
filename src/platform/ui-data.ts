import { DatabaseSync } from "node:sqlite";
import { readFile } from "node:fs/promises";
import { inspectRuntimeHomeLock, type RuntimeHome } from "./runtime-home.js";
import { validateEnabledSkills, type EnabledSkillsDocument } from "./skill-manifest.js";

type UiMessage = { id: number; workspaceId: string; transport: string; direction: string; state: string; body: string; createdAt: string; updatedAt: string };
type UiMemory = { id: number; origin: string; state: string; body: string; review: { id: number; state: string; recap: string | null } | null; createdAt: string; updatedAt: string };

export type UiData = {
  profile: { agentInstanceId: string; provider: string; transport: string; workspaceIds: string[]; status: "running" | "stopped" | "unknown" };
  metrics: { messages24h: number; messages30d: number; failedReplies24h: number; failedReplies30d: number; activeSessions: number; messagesPerSession: number };
  agentMarkdown: string;
  skills: string[];
  tools: string[];
  health: Array<{ eventType: string; detail: string | null; createdAt: string }>;
  messages: UiMessage[];
  memories: UiMemory[];
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

async function readEnabledSkills(home: RuntimeHome): Promise<string[]> {
  try {
    const document = validateEnabledSkills(JSON.parse(await readFile(home.skillsEnabledFile, "utf8")) as EnabledSkillsDocument);
    return document.skills.map((skill) => skill.id);
  } catch {
    return [];
  }
}

export async function loadUiData(home: RuntimeHome): Promise<UiData> {
  const [agentMarkdown, skills, lockState] = await Promise.all([
    readFile(home.agentFile, "utf8").then(redact),
    readEnabledSkills(home),
    inspectRuntimeHomeLock(home.lockFile),
  ]);
  const database = new DatabaseSync(home.databaseFile, { readOnly: true });
  try {
    const session = database.prepare("SELECT agent_provider AS provider, transport FROM sessions WHERE deleted_at IS NULL ORDER BY id DESC LIMIT 1").get() as { provider?: string; transport?: string } | undefined;
    const workspaceIds = (database.prepare("SELECT DISTINCT workspace_id AS workspaceId FROM messages WHERE deleted_at IS NULL ORDER BY workspace_id").all() as Array<{ workspaceId: string }>).map((row) => row.workspaceId);
    const messages = (database.prepare("SELECT id, workspace_id AS workspaceId, transport, direction, state, body, created_at AS createdAt, updated_at AS updatedAt FROM messages WHERE deleted_at IS NULL ORDER BY created_at DESC LIMIT 500").all() as Array<UiMessage & { createdAt: number; updatedAt: number }>).map((row) => ({ ...row, body: redact(row.body), createdAt: timestamp(row.createdAt), updatedAt: timestamp(row.updatedAt) }));
    const now = Date.now();
    const recent = messages.filter((message) => now - Date.parse(message.createdAt) <= 86_400_000);
    const month = messages.filter((message) => now - Date.parse(message.createdAt) <= 30 * 86_400_000);
    const failedReplies = (items: UiMessage[]) => items.filter((message) => message.direction === "agent" && message.state === "failed").length;
    const activeSessions = Number((database.prepare("SELECT COUNT(*) AS count FROM sessions WHERE state='active' AND deleted_at IS NULL").get() as { count: number }).count);
    const metrics = { messages24h: recent.length, messages30d: month.length, failedReplies24h: failedReplies(recent), failedReplies30d: failedReplies(month), activeSessions, messagesPerSession: activeSessions ? Number((recent.length / activeSessions).toFixed(1)) : 0 };
    const memories = (database.prepare("SELECT m.id, m.origin, m.state, m.body, m.created_at AS createdAt, m.updated_at AS updatedAt, r.id AS reviewId, r.state AS reviewState, r.recap AS reviewRecap FROM memories m LEFT JOIN memory_reviews r ON r.id = m.review_id AND r.deleted_at IS NULL WHERE m.deleted_at IS NULL ORDER BY m.created_at DESC LIMIT 500").all() as Array<UiMemory & { createdAt: number; updatedAt: number; reviewId: number | null; reviewState: string | null; reviewRecap: string | null }>).map((row) => ({ id: row.id, origin: row.origin, state: row.state, body: redact(row.body), review: row.reviewId === null ? null : { id: row.reviewId, state: row.reviewState!, recap: row.reviewRecap === null ? null : redact(row.reviewRecap) }, createdAt: timestamp(row.createdAt), updatedAt: timestamp(row.updatedAt) }));
    const health = (database.prepare("SELECT event_type AS eventType, detail, created_at AS createdAt FROM events WHERE event_type LIKE 'heartbeat%' AND deleted_at IS NULL ORDER BY created_at DESC LIMIT 24").all() as Array<{ eventType: string; detail: string | null; createdAt: number }>).map((row) => ({ eventType: row.eventType, detail: row.detail === null ? null : redact(row.detail), createdAt: timestamp(row.createdAt) }));
    const status = lockState === "live" ? "running" : lockState === "missing" || lockState === "stale" ? "stopped" : "unknown";
    return { profile: { agentInstanceId: home.directory.split("/").pop()?.replace(/^\./, "") ?? "unknown", provider: session?.provider ?? "unknown", transport: session?.transport ?? "unknown", workspaceIds, status }, metrics, agentMarkdown, skills, tools: [], health, messages, memories };
  } finally {
    database.close();
  }
}
