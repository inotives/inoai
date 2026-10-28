import { isIP } from "node:net";

export const UI_DEFAULT_PORT = 8989;
export const UI_DEFAULT_HOST = "127.0.0.1";

export function parseUiOptions(args: string[], command: "ui" | "start" = "ui"): { connectDirectory?: string; port: number; host: string } {
  const usage = `Usage: inoai ${command} [--dir <agent-folder> | --connect-dir .inoai-connect*] [--port 8989] [--host 192.168.1.10]`;
  let connectDirectory: string | undefined;
  let port = UI_DEFAULT_PORT;
  let host = UI_DEFAULT_HOST;
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === "--connect-dir" && args[index + 1]) { connectDirectory = args[++index]; continue; }
    if (args[index] === "--port" && args[index + 1]) {
      port = Number(args[++index]);
      if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error(usage);
      continue;
    }
    if (args[index] === "--host" && args[index + 1]) {
      host = args[++index]!;
      const [first, second] = host.split(".").map(Number);
      const privateAddress = first === 10 || (first === 172 && second! >= 16 && second! <= 31) || (first === 192 && second === 168);
      if (isIP(host) !== 4 || (host !== UI_DEFAULT_HOST && !privateAddress)) throw new Error(usage);
      continue;
    }
    throw new Error(usage);
  }
  return { connectDirectory, port, host };
}
