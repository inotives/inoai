import { mkdir, readdir, lstat } from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";
import type { AgentRuntime } from "../agent-runtime/ports.js";
import type { RuntimeHome } from "../agent-instance/runtime-home.js";
import type { TaskOperationsStore } from "../connectors/persistence/sqlite/operational-store.js";
import type { OperationalStore } from "../persistence/operational-store.js";
import type { ChatTransport } from "../transport/ports.js";
import { resumeAgentSession, startAgentSession } from "./agent-session.js";
import { addUsage, recordUsage, type Usage } from "./runtime-turn.js";
import type { ConversationWorker } from "./conversation-worker.js";

type Store = OperationalStore & TaskOperationsStore;
type ActiveRun = { taskId: number; runId: number; sessionId?: string; cancelled: boolean; done: Promise<void> };

export class TaskRunExecutor {
  private active?: ActiveRun;
  private settled?: () => void;

  constructor(private readonly store: Store, private readonly runtime: AgentRuntime,
    private readonly home: RuntimeHome, private readonly transport: Pick<ChatTransport, "sendMessage" | "uploadFile">,
    private readonly worker: Pick<ConversationWorker, "reserveTaskRun">, private readonly agentProvider: string,
    private readonly options: { now?: () => number; pauseReview?: () => Promise<() => void> } = {}) {}

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
      const active: ActiveRun = { taskId, runId: run.id, cancelled: false, done: Promise.resolve() };
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
    await this.store.failTaskRun(active.runId, "Interrupted by shutdown", this.now(), "task-runtime");
  }

  private async execute(taskId: number, runId: number, active: ActiveRun): Promise<void> {
    const output = join(this.home.directory, "results", String(taskId), String(runId));
    const relativeOutput = `results/${taskId}/${runId}`;
    let conversationId: string | undefined;
    try {
      const task = await this.store.getTask(taskId);
      if (!task) throw new Error("Task unavailable");
      conversationId = task.conversation_id;
      const messages = (await this.store.listMessages(task.session_id)).filter((message) =>
        message.id > task.message_cursor && message.direction === "user" && message.state === "completed");
      const cursor = messages.at(-1)?.id ?? task.message_cursor;
      const results = join(this.home.directory, "results");
      const taskDirectory = dirname(output);
      await mkdir(results, { recursive: true });
      const resultsInfo = await lstat(results);
      if (!resultsInfo.isDirectory() || resultsInfo.isSymbolicLink()) throw new Error("Unsafe results directory");
      await mkdir(taskDirectory, { recursive: true });
      const taskInfo = await lstat(taskDirectory);
      if (!taskInfo.isDirectory() || taskInfo.isSymbolicLink()) throw new Error("Unsafe Task directory");
      await mkdir(output);
      if (active.cancelled) return;
      const session = await this.store.getSession(task.session_id);
      if (!session || session.state !== "active" || session.agent_provider !== this.agentProvider) {
        throw new Error("Task Agent Session unavailable");
      }
      active.sessionId = session.agent_session_id.startsWith("pending:")
        ? await startAgentSession(this.store, this.runtime, session.id, this.home)
        : await resumeAgentSession(this.store, this.runtime, session.id, this.home);
      if (active.cancelled) { await this.runtime.cancel(active.sessionId); return; }
      const prompt = [
        `Task goal: ${task.goal}`,
        messages.length ? `New Task thread messages:\n${messages.map((message) => message.body).join("\n\n")}` : "No new Task thread messages.",
        `This is one Task Run. Save only requested files inside ${output}. Do not overwrite files from prior runs. Reply with a concise completion summary.`,
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
      if (answer === undefined) throw new Error("Task Run returned no answer");
      const paths = await artifactPaths(output, relativeOutput);
      await this.store.completeTaskRun(runId, cursor, paths, this.now(), "task-runtime");
      const summary = answer.trim().slice(0, 1200) || "Task Run completed.";
      const report = `Task #${taskId} run #${runId} completed.\n${summary}\n${paths.length ? `Files: ${paths.join(", ")}` : "No files produced."}`;
      await this.transport.sendMessage(task.conversation_id, report.slice(0, 1900)).catch(() => undefined);
      for (const path of paths) {
        try {
          if (!this.transport.uploadFile) throw new Error("File upload unavailable");
          await this.transport.uploadFile(task.conversation_id, join(this.home.directory, path), path);
        }
        catch { await this.transport.sendMessage(task.conversation_id, `Upload failed; local file: ${path}`).catch(() => undefined); }
      }
    } catch {
      if (!active.cancelled && await this.store.failTaskRun(runId, "Task Run failed; check local logs", this.now(), "task-runtime")) {
        if (conversationId) await this.transport.sendMessage(conversationId, `Task #${taskId} run #${runId} failed. Check the local archive; it will not retry automatically.`).catch(() => undefined);
      }
    }
  }
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
