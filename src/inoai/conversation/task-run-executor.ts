import { constants } from "node:fs";
import { mkdir, open, readdir, realpath, lstat } from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";
import type { AgentRuntime } from "../agent-runtime/ports.js";
import type { RuntimeHome } from "../agent-instance/runtime-home.js";
import type { TaskOperationsStore } from "../connectors/persistence/sqlite/operational-store.js";
import type { TaskRecord } from "../connectors/persistence/sqlite/legacy-database.js";
import type { OperationalStore } from "../persistence/operational-store.js";
import type { ChatTransport } from "../transport/ports.js";
import { resumeAgentSession, startAgentSession } from "./agent-session.js";
import { addUsage, recordUsage, type Usage } from "./runtime-turn.js";
import type { ConversationWorker } from "./conversation-worker.js";

type Store = OperationalStore & TaskOperationsStore;
type RunFolder = { task: TaskRecord; output: string; relativeOutput: string };
type ActiveRun = { taskId: number; runId: number; startedAt: number; sessionId?: string; cancelled: boolean; done: Promise<void>; folder?: RunFolder };
type RunTransport = Pick<ChatTransport, "sendMessage" | "uploadFile">
  & Partial<Pick<ChatTransport, "createConversation" | "deleteConversation" | "deleteMessage">>;

/** Error whose message is safe to store in result.md. Other errors are reported with a generic reason. */
class TaskRunError extends Error {}
const genericFailure = "Task Run failed; check local logs";

export class TaskRunExecutor {
  private active?: ActiveRun;
  private settled?: () => void;

  constructor(private readonly store: Store, private readonly runtime: AgentRuntime,
    private readonly home: RuntimeHome, private readonly transport: RunTransport,
    private readonly worker: Pick<ConversationWorker, "reserveTaskRun">, private readonly agentProvider: string,
    private readonly options: { now?: () => number; pauseReview?: () => Promise<() => void>; taskChannelId?: string } = {}) {}

  onSettled(listener: () => void): void { this.settled = listener; }
  private now(): number { return this.options.now?.() ?? Math.floor(Date.now() / 1000); }

  async start(taskId: number): Promise<"started" | "busy" | "unavailable"> {
    const releaseChat = await this.worker.reserveTaskRun();
    if (!releaseChat) return "busy";
    let releaseReview: (() => void) | undefined;
    let handedOff = false;
    try {
      releaseReview = await this.options.pauseReview?.();
      if (await this.store.chatBusy()) return "busy";
      const task = await this.store.getTask(taskId);
      if (!task || task.state !== "active") return "unavailable";
      const run = await this.store.claimTaskRun(taskId, this.now(), "task-runtime");
      if (!run) return "busy";
      const active: ActiveRun = { taskId, runId: run.id, startedAt: run.started_at, cancelled: false, done: Promise.resolve() };
      this.active = active;
      handedOff = true;
      active.done = this.execute(task.id, run.id, active).finally(() => {
        if (this.active === active) this.active = undefined;
        releaseChat();
        releaseReview?.();
        this.settled?.();
      });
      void active.done.catch(() => undefined);
      return "started";
    } finally {
      if (!handedOff) { releaseChat(); releaseReview?.(); }
    }
  }

  async cancel(taskId: number): Promise<boolean> {
    if (!await this.store.cancelTask(taskId, this.now(), "user:owner")) return false;
    const active = this.active;
    if (active?.taskId === taskId) {
      active.cancelled = true;
      if (active.sessionId) await this.runtime.cancel(active.sessionId).catch(() => undefined);
    }
    return true;
  }

  async stop(): Promise<void> {
    const active = this.active;
    if (!active) return;
    active.cancelled = true;
    if (active.sessionId) await this.runtime.cancel(active.sessionId).catch(() => undefined);
    await active.done;
    const endedAt = this.now();
    if (await this.store.failTaskRun(active.runId, "Interrupted by shutdown", endedAt, "task-runtime") && active.folder) {
      await writeTaskRunResult(this.home.directory, active.folder.task, { id: active.runId, startedAt: active.startedAt },
        { state: "failed", endedAt, failure: "Interrupted by shutdown" }).catch(() => undefined);
    }
  }

  private async execute(taskId: number, runId: number, active: ActiveRun): Promise<void> {
    const output = join(this.home.directory, "results", String(taskId), String(runId));
    const relativeOutput = `results/${taskId}/${runId}`;
    let conversationId: string | undefined;
    let ended = false;
    try {
      const task = await this.store.getTask(taskId);
      if (!task) throw new TaskRunError("Task unavailable");
      // A UI-created Task keeps a `pending:ui:` placeholder until the agent opens its thread.
      conversationId = task.conversation_id.startsWith("pending:ui:") ? undefined : task.conversation_id;
      const messages = (await this.store.listMessages(task.session_id)).filter((message) =>
        message.id > task.message_cursor && message.direction === "user" && message.state === "completed");
      const cursor = messages.at(-1)?.id ?? task.message_cursor;
      const results = join(this.home.directory, "results");
      const taskDirectory = dirname(output);
      await mkdir(results, { recursive: true });
      const resultsInfo = await lstat(results);
      if (!resultsInfo.isDirectory() || resultsInfo.isSymbolicLink()) throw new TaskRunError("Unsafe results directory");
      await mkdir(taskDirectory, { recursive: true });
      const taskInfo = await lstat(taskDirectory);
      if (!taskInfo.isDirectory() || taskInfo.isSymbolicLink()) throw new TaskRunError("Unsafe Task directory");
      await mkdir(output);
      const folder: RunFolder = { task, output, relativeOutput };
      active.folder = folder;
      if (active.cancelled) return;
      let session = await this.store.getSession(task.session_id);
      if (session?.state === "active" && session.agent_provider !== this.agentProvider) {
        // Task runs follow the active provider: the Task's own Session gets a fresh pending id under it.
        // If another start switched it first, the re-read below continues with the current state.
        await this.store.switchTaskSessionProvider(session.id, { taskId, runId, fromProvider: session.agent_provider,
          toProvider: this.agentProvider }, this.now(), "task-runtime");
        session = await this.store.getSession(task.session_id);
      }
      if (!session || session.state !== "active" || session.agent_provider !== this.agentProvider) {
        throw new TaskRunError("Task Agent Session unavailable");
      }
      const carryover = await this.carryover(task, session.id);
      conversationId ??= await this.openTaskThread(task, runId);
      active.sessionId = session.agent_session_id.startsWith("pending:")
        ? await startAgentSession(this.store, this.runtime, session.id, this.home)
        : await resumeAgentSession(this.store, this.runtime, session.id, this.home);
      if (active.cancelled) { await this.runtime.cancel(active.sessionId); return; }
      const prompt = [
        ...(task.title ? [`Task title: ${task.title}`] : []),
        `Task goal: ${task.goal}`,
        ...(task.output_spec ? [`Expected output: ${task.output_spec}`] : []),
        ...(carryover ? [carryover] : []),
        messages.length ? `New Task thread messages:\n${messages.map((message) => message.body).join("\n\n")}` : "No new Task thread messages.",
        `This is one Task Run. Save only requested files inside ${output}. Do not overwrite files from prior runs. Do not create result.md; inoai writes it with your reply. Reply with a concise completion summary.`,
      ].join("\n\n");
      let answer: string | undefined;
      const usage: Usage = {};
      try {
        for await (const event of this.runtime.runTurn(active.sessionId, prompt)) {
          if (event.type === "answer") answer = event.text;
          if (event.type === "usage") addUsage(usage, event);
          if (event.type === "session") {
            await this.store.rebindAgentSession(session.id, active.sessionId, event.id, `runtime:${session.agent_provider}`);
            active.sessionId = event.id;
          }
        }
      } finally {
        await recordUsage(this.store, session.id, null, usage);
      }
      if (active.cancelled) return;
      if (answer === undefined) throw new TaskRunError("Task Run returned no answer");
      const endedAt = this.now();
      const files = await writeTaskRunResult(this.home.directory, task, { id: runId, startedAt: active.startedAt },
        { state: "completed", endedAt, answer });
      const paths = [...files, `${relativeOutput}/result.md`].sort();
      await this.store.completeTaskRun(runId, cursor, paths, endedAt, "task-runtime");
      ended = true;
      if (!conversationId) return;
      const summary = answer.trim().slice(0, 1200) || "Task Run completed.";
      const report = `Task #${taskId} run #${runId} completed.\n${summary}\n${files.length ? `Files: ${files.join(", ")}` : "No files produced."}`;
      await this.transport.sendMessage(conversationId, report.slice(0, 1900)).catch(() => undefined);
      // result.md stays local; the thread keeps its existing report and uploads only the produced files.
      for (const path of files) {
        try {
          if (!this.transport.uploadFile) throw new Error("File upload unavailable");
          await this.transport.uploadFile(conversationId, join(this.home.directory, path), path);
        }
        catch { await this.transport.sendMessage(conversationId, `Upload failed; local file: ${path}`).catch(() => undefined); }
      }
    } catch (error) {
      const endedAt = this.now();
      if (!active.cancelled && await this.store.failTaskRun(runId, genericFailure, endedAt, "task-runtime")) {
        ended = true;
        const failure = error instanceof TaskRunError ? error.message : genericFailure;
        if (active.folder) await writeTaskRunResult(this.home.directory, active.folder.task, { id: runId, startedAt: active.startedAt },
          { state: "failed", endedAt, failure }).catch(() => undefined);
        if (conversationId) await this.transport.sendMessage(conversationId, `Task #${taskId} run #${runId} failed. Check the local archive; it will not retry automatically.`).catch(() => undefined);
      }
    } finally {
      // A cancel can land at any point, including after the completed result.md was written; SQLite decides.
      if (!ended) await this.writeCancelledResult(taskId, active).catch(() => undefined);
    }
  }

  /** Opens the Task's thread in the task channel on its first run. On failure the run continues thread-less. */
  private async openTaskThread(task: TaskRecord, runId: number): Promise<string | undefined> {
    const channel = this.options.taskChannelId;
    if (!channel || !this.transport.createConversation) return undefined;
    let starterId: string | undefined;
    let threadId: string | undefined;
    try {
      starterId = await this.transport.sendMessage(channel, "inoai Task thread");
      threadId = await this.transport.createConversation(channel, starterId, threadName(task));
      await this.store.bindTaskConversation(task.id, { conversationId: threadId, parentConversationId: channel,
        initiatingExternalMessageId: starterId }, this.now(), "task-runtime");
      return threadId;
    } catch {
      if (threadId) await this.transport.deleteConversation?.(threadId).catch(() => undefined);
      if (starterId) await this.transport.deleteMessage?.(channel, starterId).catch(() => undefined);
      await this.store.createEvent({ session_id: task.session_id, message_id: null, event_type: "task_thread_failed",
        detail: `task=${task.id}; run=${runId}` }, "task-runtime").catch(() => undefined);
      return undefined;
    }
  }

  /**
   * Builds the carryover for runs after a provider switch until one of them completes: the latest completed run's
   * answer and the Task thread so far. The latest `task_provider_switched` event names the run that switched; a
   * completed run with that id or later means the new agent session already has the context.
   */
  private async carryover(task: TaskRecord, sessionId: number): Promise<string | undefined> {
    const switched = (await this.store.listEvents(sessionId)).filter((event) => event.event_type === "task_provider_switched").at(-1);
    const switchRunId = Number(switched?.detail?.match(/^task=\d+; run=(\d+);/)?.[1]);
    if (!Number.isSafeInteger(switchRunId)) return undefined;
    const runs = await this.store.listTaskRuns(task.id);
    if (runs.some((run) => run.id >= switchRunId && run.state === "completed")) return undefined;
    const previous = runs.filter((run) => run.state === "completed").at(-1);
    const answer = previous ? await readRunAnswer(this.home.directory, task.id, previous.id) : undefined;
    const thread = keepNewest((await this.store.listMessages(sessionId))
      .filter((message) => message.direction === "user" && message.state === "completed").map((message) => message.body));
    return [
      "Carryover: earlier runs of this Task used another agent provider; this run continues in a fresh agent session.",
      ...(answer ? [`Previous run answer:\n${answer}`] : []),
      ...(thread ? [`Task thread messages so far:\n${thread}`] : []),
    ].join("\n\n");
  }

  /** Writes a cancelled result.md when SQLite shows the run cancelled. Shutdown leaves the run processing for `stop`. */
  private async writeCancelledResult(taskId: number, active: ActiveRun): Promise<void> {
    const run = await this.store.getTaskRun(active.runId);
    if (run?.state !== "cancelled") return;
    const task = active.folder?.task ?? await this.store.getTask(taskId);
    if (!task) return;
    await writeTaskRunResult(this.home.directory, task, { id: run.id, startedAt: run.started_at },
      { state: "cancelled", endedAt: run.completed_at ?? this.now() }, { createFolder: true });
  }
}

export type TaskRunOutcome = { state: "completed" | "failed" | "cancelled"; endedAt: number; answer?: string; failure?: string };

/**
 * Writes result.md inside `results/<task>/<run>` of a runtime home and returns the run's other file paths.
 * With `createFolder`, a missing run folder is created one level at a time, refusing symlinked or non-directory levels.
 */
export async function writeTaskRunResult(homeDirectory: string, task: TaskRecord, run: { id: number; startedAt: number },
  outcome: TaskRunOutcome, options: { createFolder?: boolean } = {}): Promise<string[]> {
  const results = join(homeDirectory, "results");
  const output = join(results, String(task.id), String(run.id));
  const relativeOutput = `results/${task.id}/${run.id}`;
  for (const directory of [results, dirname(output), output]) {
    if (options.createFolder) {
      await mkdir(directory).catch((error: NodeJS.ErrnoException) => { if (error.code !== "EEXIST") throw error; });
    }
    const info = await lstat(directory);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new TaskRunError("Unsafe results directory");
  }
  if (!(await realpath(output)).startsWith(`${await realpath(results)}${sep}`)) throw new TaskRunError("Unsafe results directory");
  const resultPath = `${relativeOutput}/result.md`;
  const files = (await artifactPaths(output, relativeOutput)).filter((path) => path !== resultPath);
  const iso = (seconds: number) => new Date(seconds * 1000).toISOString();
  const [heading, text] = outcome.state === "completed" ? ["## Answer", outcome.answer ?? ""]
    : outcome.state === "cancelled" ? ["## Cancellation", "Cancelled by the owner."]
    : ["## Failure", outcome.failure ?? genericFailure];
  const body = [
    `# ${(task.title ?? `Task #${task.id}`).replace(/\s+/g, " ").trim()}`,
    "",
    `- Task: #${task.id}`,
    `- Run: #${run.id}`,
    `- State: ${outcome.state}`,
    `- Started: ${iso(run.startedAt)}`,
    `- Ended: ${iso(outcome.endedAt)}`,
    "",
    "## Instruction",
    "",
    task.goal,
    "",
    "## Expected output",
    "",
    task.output_spec ?? "Not set.",
    "",
    heading,
    "",
    text,
    "",
    "## Files",
    "",
    ...(files.length ? files.map((path) => `- \`${path}\``) : ["No other files."]),
    "",
  ].join("\n");
  // O_NOFOLLOW refuses a symlink planted at result.md. The file is opened without O_TRUNC and truncated only after
  // fstat shows a regular file with one link, so a hard link to a file outside results/ is never overwritten.
  const handle = await open(join(output, "result.md"), constants.O_WRONLY | constants.O_CREAT | constants.O_NOFOLLOW, 0o600);
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.nlink !== 1) throw new TaskRunError("Unsafe result file");
    await handle.truncate(0);
    await handle.writeFile(body, "utf8");
  } finally { await handle.close(); }
  return files;
}

const carryoverAnswerLimit = 4_000;
const carryoverThreadLimit = 8_000;
const carryoverResultReadLimit = 1024 * 1024;

/**
 * Returns the `## Answer` text of a completed run's result.md, at most 4,000 characters, or undefined. Every folder must
 * be a real directory inside results/; the file must be a regular, single-link, non-FIFO file of at most 1 MiB.
 */
async function readRunAnswer(homeDirectory: string, taskId: number, runId: number): Promise<string | undefined> {
  try {
    const results = join(homeDirectory, "results");
    const output = join(results, String(taskId), String(runId));
    for (const directory of [results, dirname(output), output]) {
      const info = await lstat(directory);
      if (!info.isDirectory() || info.isSymbolicLink()) return undefined;
    }
    if (!(await realpath(output)).startsWith(`${await realpath(results)}${sep}`)) return undefined;
    // O_NONBLOCK keeps a FIFO planted at result.md from blocking the open; the fstat check then refuses it.
    const handle = await open(join(output, "result.md"), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const info = await handle.stat();
      if (!info.isFile() || info.nlink !== 1 || info.size > carryoverResultReadLimit) return undefined;
      const buffer = Buffer.alloc(info.size);
      const { bytesRead } = await handle.read(buffer, 0, info.size, 0);
      const bytes = buffer.subarray(0, bytesRead);
      if (bytes.includes(0)) return undefined;
      const content = bytes.toString("utf8");
      const heading = "\n\n## Answer\n\n";
      const start = content.indexOf(heading);
      const end = content.lastIndexOf("\n\n## Files\n\n");
      if (!content.includes("\n- State: completed\n") || start < 0 || end < start + heading.length) return undefined;
      return content.slice(start + heading.length, end).trim().slice(0, carryoverAnswerLimit) || undefined;
    } finally { await handle.close(); }
  } catch { return undefined; }
}

/** Joins whole messages, newest kept, within 8,000 characters; an oversized newest message keeps its end. */
function keepNewest(bodies: string[]): string | undefined {
  const kept: string[] = [];
  let size = 0;
  for (const body of [...bodies].reverse()) {
    const cost = body.length + (kept.length ? 2 : 0);
    if (size + cost > carryoverThreadLimit) {
      if (!kept.length) kept.push(body.slice(-carryoverThreadLimit));
      break;
    }
    kept.unshift(body);
    size += cost;
  }
  return kept.length ? kept.join("\n\n") : undefined;
}

function threadName(task: TaskRecord): string {
  const name = task.title?.replace(/\s+/g, " ").trim() || `inoai Task #${task.id}`;
  return Array.from(name).slice(0, 100).join("");
}

async function artifactPaths(directory: string, prefix: string): Promise<string[]> {
  const paths: string[] = [];
  async function walk(current: string): Promise<void> {
    for (const entry of await readdir(current)) {
      const path = join(current, entry);
      const info = await lstat(path);
      if (info.isSymbolicLink()) continue;
      if (info.isDirectory()) await walk(path);
      else if (info.isFile()) paths.push(`${prefix}/${relative(directory, path).split(sep).join("/")}`);
    }
  }
  await walk(directory);
  return paths.sort();
}
