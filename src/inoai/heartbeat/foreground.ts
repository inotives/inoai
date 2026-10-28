import { basename } from "node:path";
import { bootstrapRuntimeHome } from "../agent-instance/runtime-home.js";
import { sqliteHealthProbes, probeHealth } from "./health.js";
import { HeartbeatSupervisor, localHeartbeatLog, spawnInoai, supervisorClock, type SupervisorLog } from "./supervisor.js";
import { createHeartbeatEventRecorder } from "./events.js";

export async function runHeartbeat(launchDirectory: string, connectDirectory?: string, supplied: { log?: SupervisorLog } = {}): Promise<void> {
  const log = supplied.log ?? localHeartbeatLog();
  let supervisor: HeartbeatSupervisor | undefined;
  let record: ReturnType<typeof createHeartbeatEventRecorder> | undefined;
  const onSignal = () => { void supervisor?.stop(); };
  try {
    const home = await bootstrapRuntimeHome(launchDirectory, connectDirectory);
    const probes = sqliteHealthProbes(home.databaseFile);
    record = createHeartbeatEventRecorder(home);
    supervisor = new HeartbeatSupervisor({
      spawn: () => spawnInoai(connectDirectory?.startsWith("direct:") ? connectDirectory : basename(home.directory), launchDirectory),
      probe: (childPid) => probeHealth({ childPid, lockFile: home.lockFile, ...probes }),
      clock: supervisorClock, log, record,
    });
    process.on("SIGINT", onSignal);
    process.on("SIGTERM", onSignal);
    supervisor.start();
    process.exitCode = await supervisor.finished;
  } catch {
    await supervisor?.stop();
    await log("supervisor-failed", true).catch(() => undefined);
    throw new Error("Heartbeat supervisor failed; inspect local heartbeat logs");
  } finally {
    record?.close();
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
  }
}
