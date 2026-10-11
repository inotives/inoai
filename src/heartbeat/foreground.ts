import { basename } from "node:path";
import { loadConfiguration } from "../platform/config.js";
import { bootstrapRuntimeHome } from "../platform/runtime-home.js";
import { createPostgresPool } from "../persistence/postgres.js";
import { postgresHealthProbes, probeHealth } from "./health.js";
import { HeartbeatSupervisor, localHeartbeatLog, spawnInoai, supervisorClock, type SupervisorLog } from "./supervisor.js";

export async function runHeartbeat(launchDirectory: string, connectDirectory?: string, supplied: { log?: SupervisorLog } = {}): Promise<void> {
  const log = supplied.log ?? localHeartbeatLog();
  let pool: ReturnType<typeof createPostgresPool> | undefined;
  let supervisor: HeartbeatSupervisor | undefined;
  const onSignal = () => { void supervisor?.stop(); };
  try {
    const home = await bootstrapRuntimeHome(launchDirectory, connectDirectory);
    const configuration = await loadConfiguration(home.envFile);
    pool = createPostgresPool(configuration);
    // pg idle-client errors must never expose connection values or terminate
    // the supervisor outside its lifecycle. The next probe applies policy.
    pool.on("error", () => { void log("degraded", true).catch(() => undefined); });
    const probes = postgresHealthProbes(pool, configuration.agentInstanceId);
    supervisor = new HeartbeatSupervisor({
      spawn: () => spawnInoai(basename(home.directory), launchDirectory),
      probe: (childPid) => probeHealth({ childPid, lockFile: home.lockFile, ...probes }),
      clock: supervisorClock, log,
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
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
    await pool?.end().catch(() => undefined);
  }
}
