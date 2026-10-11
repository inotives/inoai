export const UI_DEFAULT_PORT = 8989;

export function parseUiOptions(args: string[]): { connectDirectory?: string; port: number } {
  let connectDirectory: string | undefined;
  let port = UI_DEFAULT_PORT;
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === "--connect-dir" && args[index + 1]) { connectDirectory = args[++index]; continue; }
    if (args[index] === "--port" && args[index + 1]) {
      port = Number(args[++index]);
      if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error("Usage: inoai ui [--connect-dir .inoai-connect*] [--port 8989]");
      continue;
    }
    throw new Error("Usage: inoai ui [--connect-dir .inoai-connect*] [--port 8989]");
  }
  return { connectDirectory, port };
}
