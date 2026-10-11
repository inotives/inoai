import { execFile as execFileCallback } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { resolveRuntimeHome } from "../platform/runtime-home.js";

const execFile = promisify(execFileCallback);
export type LaunchAgentCommand = {
  operation: "render" | "install" | "status" | "stop" | "unload" | "uninstall";
  connectDirectory?: string;
  runAtLoad?: boolean;
  keepAlive?: boolean;
};

export function parseLaunchAgentCommand(args: string[]): LaunchAgentCommand {
  const usage = "Usage: inoai heartbeat launchagent <render|install|status|stop|unload|uninstall> [--connect-dir .inoai-connect*] [--run-at-load] [--keep-alive]";
  const operation = args[0];
  if (!operation || !["render", "install", "status", "stop", "unload", "uninstall"].includes(operation)) throw new Error(usage);
  const command = { operation } as LaunchAgentCommand;
  const seen = new Set<string>();
  for (let i = 1; i < args.length; i++) {
    const flag = args[i]!;
    if (seen.has(flag)) throw new Error(usage);
    seen.add(flag);
    if (flag === "--connect-dir" && args[i + 1] && !args[i + 1]!.startsWith("--")) command.connectDirectory = args[++i];
    else if ((operation === "render" || operation === "install") && flag === "--run-at-load") command.runAtLoad = true;
    else if ((operation === "render" || operation === "install") && flag === "--keep-alive") command.keepAlive = true;
    else throw new Error(usage);
  }
  return command;
}

function xml(value: string): string {
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/u.test(value)) throw new Error("Invalid control character in LaunchAgent path");
  return value.replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[character]!);
}

export function renderLaunchAgent(repository: string, command: LaunchAgentCommand, userHome = homedir(), nodeExecutable = process.execPath) {
  const checkout = resolve(repository);
  const runtimeHome = resolveRuntimeHome(checkout, command.connectDirectory ?? ".inoai-connect-planner").directory;
  const executable = join(checkout, "dist", "index.js");
  const label = `com.inoai.heartbeat.${createHash("sha256").update(runtimeHome).digest("hex").slice(0, 16)}`;
  const logs = join(resolve(userHome), "Library", "Logs", "inoai");
  const plistPath = join(resolve(userHome), "Library", "LaunchAgents", `${label}.plist`);
  const string = (value: string) => `<string>${xml(value)}</string>`;
  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>${string(label)}
  <key>ProgramArguments</key>
  <array>${[resolve(nodeExecutable), executable, "heartbeat", "--connect-dir", basename(runtimeHome)].map(string).join("")}</array>
  <key>WorkingDirectory</key>${string(checkout)}
  <key>StandardOutPath</key>${string(join(logs, "heartbeat.log"))}
  <key>StandardErrorPath</key>${string(join(logs, "heartbeat-error.log"))}
  <key>RunAtLoad</key><${command.runAtLoad ? "true" : "false"}/>
  <key>KeepAlive</key><${command.keepAlive ? "true" : "false"}/>
</dict>
</plist>
`;
  return { plist, plistPath, label, checkout, runtimeHome, executable, logs };
}

export type Launchctl = (args: string[]) => Promise<boolean>;
const launchctl: Launchctl = async (args) => {
  try {
    await execFile("/bin/launchctl", args);
    return true;
  } catch (error) {
    // launchctl reports a missing service with ESRCH or its bootstrap code.
    const code = (error as { code?: unknown }).code;
    if (code === 3 || code === 113) return false;
    throw new Error("LaunchAgent control failed");
  }
};

export async function manageLaunchAgent(repository: string, command: LaunchAgentCommand, supplied: {
  userHome?: string; nodeExecutable?: string; platform?: string; uid?: number; launchctl?: Launchctl;
} = {}): Promise<string> {
  const rendered = renderLaunchAgent(repository, command, supplied.userHome, supplied.nodeExecutable);
  if (command.operation === "render") return rendered.plist;
  if ((supplied.platform ?? process.platform) !== "darwin") throw new Error("LaunchAgents require macOS");
  if (command.operation === "install") {
    await mkdir(dirname(rendered.plistPath), { recursive: true });
    await mkdir(rendered.logs, { recursive: true, mode: 0o700 });
    await writeFile(rendered.plistPath, rendered.plist, { mode: 0o600 });
    return `Installed (not loaded): ${rendered.plistPath}\nCheckout: ${rendered.checkout}\nExecutable: ${rendered.executable}\nRuntime home: ${rendered.runtimeHome}\nLogs: ${rendered.logs}`;
  }
  try { await readFile(rendered.plistPath); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "LaunchAgent is not installed";
    throw error;
  }
  const control = supplied.launchctl ?? launchctl;
  const target = `gui/${supplied.uid ?? process.getuid!()}/${rendered.label}`;
  const loaded = await control(["print", target]);
  if (command.operation === "status") return `LaunchAgent is installed and ${loaded ? "loaded" : "not loaded"}: ${rendered.plistPath}`;
  if (loaded) await control(command.operation === "stop" ? ["kill", "SIGTERM", target] : ["bootout", target]);
  if (command.operation === "uninstall") await rm(rendered.plistPath, { force: true });
  return command.operation === "uninstall" ? "LaunchAgent uninstalled" : `LaunchAgent ${command.operation === "stop" ? "stop requested" : "unloaded"}`;
}
