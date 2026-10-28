import { constants } from "node:fs";
import { access, mkdir, realpath, stat, writeFile } from "node:fs/promises";
import { delimiter, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { Writable } from "node:stream";
import { validateConfiguration } from "./config.js";
import { defaultAgentProfile } from "./profile.js";

type Ask = (prompt: string, secret?: boolean) => Promise<string>;

async function providerAvailable(provider: string): Promise<boolean> {
  for (const directory of (process.env.PATH ?? "").split(delimiter).filter(Boolean)) {
    try {
      const candidate = join(directory, provider);
      await access(candidate, constants.X_OK);
      if ((await stat(candidate)).isFile()) return true;
    } catch { /* Try the next PATH entry. */ }
  }
  return false;
}

export async function createAgent(ask: Ask, available = providerAvailable): Promise<string> {
  const name = (await ask("Agent name (lowercase letters, digits and hyphens): ")).trim();
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name) || name.length > 57) throw new Error("Agent name must be a lowercase slug of at most 57 characters");
  const folderInput = (await ask("New agent data folder: ")).trim();
  if (!folderInput || /[\r\n]/.test(folderInput)) throw new Error("Enter a valid new agent data folder");
  const folder = resolve(folderInput);
  const projectInput = (await ask("Existing agent working folder: ")).trim();
  if (!projectInput || /[\r\n]/.test(projectInput)) throw new Error("Enter a valid agent working folder");
  const project = await realpath(resolve(projectInput));
  if (/[\r\n]/.test(project)) throw new Error("Agent working folder must not contain a newline");
  if (!(await stat(project)).isDirectory()) throw new Error("Agent working folder must be a directory");
  const provider = (await ask("Coding agent (codex, claude, opencode): ")).trim();
  if (!["codex", "claude", "opencode"].includes(provider)) throw new Error("Choose codex, claude, or opencode");
  if (!(await available(provider))) throw new Error(`${provider} was not found on PATH. Install and sign in to ${provider}, then run setup again.`);
  const token = (await ask("Discord bot token (hidden): ", true)).trim();
  if (!/^[A-Za-z0-9._-]+$/.test(token)) throw new Error("Enter a valid Discord bot token without whitespace");
  const guild = (await ask("Discord server ID: ")).trim();
  const owner = (await ask("Discord owner user ID: ")).trim();
  const channel = (await ask("Discord status channel ID: ")).trim();
  if (![guild, owner, channel].every((id) => /^\d+$/.test(id))) throw new Error("Discord server, owner and channel IDs must contain only digits");
  const values: Record<string, string> = {
    DISCORD_BOT_TOKEN: token, DISCORD_GUILD_ID: guild, DISCORD_OWNER_USER_ID: owner,
    DISCORD_STATUS_CHANNEL_ID: channel, CHAT_PROVIDER: "discord", AGENT_PROVIDER: provider,
    AGENT_INSTANCE_ID: `agent-${name}`, PROJECT_DIRECTORY: project,
    MEMORY_REVIEW_TIME: "06:00", MEMORY_REVIEW_MAX_CHARS: "20000",
  };
  validateConfiguration(values);
  try { await mkdir(folder, { mode: 0o700 }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new Error(`Agent folder already exists: ${folder}. Choose a new folder.`);
    throw error;
  }
  await writeFile(join(folder, ".env"), Object.entries(values).map(([key, value]) => `${key}=${value}\n`).join(""), { flag: "wx", mode: 0o600 });
  await writeFile(join(folder, "agent.md"), defaultAgentProfile, { flag: "wx", mode: 0o600 });
  await writeFile(join(folder, "skills-enabled.json"), `${JSON.stringify({ version: 1, skills: [] })}\n`, { flag: "wx", mode: 0o600 });
  await mkdir(join(folder, "skills"), { mode: 0o700 });
  return folder;
}

export async function runSetup(): Promise<void> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error("Agent setup requires an interactive terminal");
  let muted = false;
  const output = new Writable({ write(chunk: Buffer, _encoding, callback) { if (!muted) process.stdout.write(chunk); callback(); } });
  const readline = createInterface({ input: process.stdin, output, terminal: true });
  const ask: Ask = (prompt, secret) => new Promise((resolveAnswer) => {
    if (secret) { process.stdout.write(prompt); muted = true; }
    readline.question(secret ? "" : prompt, (answer) => {
      if (secret) { muted = false; process.stdout.write("\n"); }
      resolveAnswer(answer);
    });
  });
  try {
    const folder = await createAgent(ask);
    console.log(`Agent created: ${folder}\nEdit ${join(folder, "agent.md")} to customize its profile.`);
  } finally { readline.close(); }
}
