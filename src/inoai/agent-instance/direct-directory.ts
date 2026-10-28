import { resolve } from "node:path";

export function normalizeDirectoryArgs(args: string[]): string[] {
  const index = args.indexOf("--dir");
  if (index < 0) return args;
  const value = args[index + 1];
  if (!value || value.startsWith("--") || args.indexOf("--dir", index + 1) >= 0 || args.includes("--connect-dir") || args.includes("--agent")) {
    throw new Error("Use --dir <agent-folder> once and without --connect-dir or --agent");
  }
  const result = [...args];
  result.splice(index, 2, "--connect-dir", `direct:${resolve(value)}`);
  return result;
}
