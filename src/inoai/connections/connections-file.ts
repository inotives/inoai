import { lstat, readFile } from "node:fs/promises";
import { parseEnvText } from "../agent-instance/config.js";
import { secretLike } from "../conversation/prompt-context.js";

export const connectionNamePattern = /^[a-z0-9][a-z0-9_-]{0,31}$/;
export const toolNamePattern = /^[A-Za-z0-9_-]{1,64}$/;
export const maxConnectionsBytes = 262_144;

const envNamePattern = /^[A-Za-z_][A-Za-z0-9_]*$/;
const headerNamePattern = /^[A-Za-z0-9!#$%&'*+.^_`|~-]{1,128}$/;
const referencePattern = /\$\{([^}]*)\}/g;
/** Stands in for a `${NAME}` reference during the secret-like check. `secretLike` cannot match it. */
const referenceMarker = "\u0000";

export type ConnectionAllow = string[] | "all";

export type StdioConnection = {
  name: string;
  type: "stdio";
  command: string;
  args?: string[];
  env?: Record<string, string>;
  allow: ConnectionAllow;
};

export type HttpConnection = {
  name: string;
  type: "http";
  url: string;
  headers?: Record<string, string>;
  allow: ConnectionAllow;
};

export type Connection = StdioConnection | HttpConnection;

/** The only connection fields that may be shown by the CLI or UI. */
export type ConnectionSummary = { name: string; type: Connection["type"]; allow: ConnectionAllow };

export type ClaudeMcpServer =
  | { type: "stdio"; command: string; args?: string[]; env?: Record<string, string> }
  | { type: "http"; url: string; headers?: Record<string, string> };

/** Holds filled-in secret values. Never log or print `mcpServers`. */
export type ResolvedConnections = {
  mcpServers: Record<string, ClaudeMcpServer>;
  allowedTools: string[];
};

/** A connections file that cannot be used. The message names the file and the problem, never a value. */
export class InvalidConnectionsError extends Error {
  readonly file: string;
  readonly reason: string;

  constructor(file: string, reason: string) {
    super(`Invalid connections file ${file}: ${reason}`);
    this.name = "InvalidConnectionsError";
    this.file = file;
    this.reason = reason;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Names a key in a message only when it is short letters, so a pasted value is never echoed. */
function describeKey(key: string): string {
  return /^[A-Za-z]{1,20}$/.test(key) ? `unknown key "${key}"` : "an unknown key";
}

function checkKeys(file: string, value: Record<string, unknown>, allowed: readonly string[], where: string): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) throw new InvalidConnectionsError(file, `${where} has ${describeKey(key)}`);
  }
}

function readStringMap(file: string, value: unknown, keyPattern: RegExp, where: string): Record<string, string> {
  if (!isRecord(value)) throw new InvalidConnectionsError(file, `${where} must be an object of strings`);
  const entries = Object.entries(value);
  for (const [key, item] of entries) {
    if (!keyPattern.test(key)) throw new InvalidConnectionsError(file, `${where} has an invalid key name`);
    if (secretLike.test(key)) throw new InvalidConnectionsError(file, `${where} has a secret-like key name`);
    if (typeof item !== "string") throw new InvalidConnectionsError(file, `${where} values must be strings`);
  }
  return Object.fromEntries(entries) as Record<string, string>;
}

function readAllow(file: string, value: unknown, where: string): ConnectionAllow {
  if (value === undefined) return [];
  if (value === "all") return "all";
  if (!Array.isArray(value)) throw new InvalidConnectionsError(file, `${where} allow must be a list of tool names or "all"`);
  for (const tool of value) {
    if (typeof tool !== "string" || !toolNamePattern.test(tool)) throw new InvalidConnectionsError(file, `${where} allow has an invalid tool name`);
  }
  return [...new Set(value as string[])];
}

function readConnection(file: string, name: string, value: unknown): Connection {
  const where = `connection "${name}"`;
  if (!isRecord(value)) throw new InvalidConnectionsError(file, `${where} must be an object`);
  const allow = readAllow(file, value.allow, where);
  if (value.type === "stdio") {
    checkKeys(file, value, ["type", "command", "args", "env", "allow"], where);
    if (typeof value.command !== "string" || value.command.trim() === "") throw new InvalidConnectionsError(file, `${where} command must be a non-empty string`);
    const connection: StdioConnection = { name, type: "stdio", command: value.command, allow };
    if (value.args !== undefined) {
      if (!Array.isArray(value.args) || !value.args.every((arg) => typeof arg === "string")) throw new InvalidConnectionsError(file, `${where} args must be a list of strings`);
      connection.args = [...value.args as string[]];
    }
    if (value.env !== undefined) connection.env = readStringMap(file, value.env, envNamePattern, `${where} env`);
    return connection;
  }
  if (value.type === "http") {
    checkKeys(file, value, ["type", "url", "headers", "allow"], where);
    if (typeof value.url !== "string" || value.url.trim() === "") throw new InvalidConnectionsError(file, `${where} url must be a non-empty string`);
    const connection: HttpConnection = { name, type: "http", url: value.url, allow };
    if (value.headers !== undefined) connection.headers = readStringMap(file, value.headers, headerNamePattern, `${where} headers`);
    return connection;
  }
  throw new InvalidConnectionsError(file, `${where} type must be "stdio" or "http"`);
}

/** Validates the file's JSON text against the schema. It does not check `${NAME}` references against `.env`. */
export function parseConnections(file: string, text: string): Connection[] {
  let document: unknown;
  try {
    document = JSON.parse(text);
  } catch {
    throw new InvalidConnectionsError(file, "not valid JSON");
  }
  if (!isRecord(document)) throw new InvalidConnectionsError(file, "top level must be an object");
  checkKeys(file, document, ["version", "connections"], "top level");
  if (document.version !== 1) throw new InvalidConnectionsError(file, "version must be 1");
  if (!isRecord(document.connections)) throw new InvalidConnectionsError(file, "connections must be an object");
  return Object.entries(document.connections).map(([name, value]) => {
    if (!connectionNamePattern.test(name) || name.includes("__")) {
      throw new InvalidConnectionsError(file, "a connection name is invalid; use 1-32 of a-z, 0-9, '-', '_', starting with a letter or digit, with no '__'");
    }
    return readConnection(file, name, value);
  });
}

/** Reads `connections.json`. An absent file means no connections. Symlinks and other non-regular files are refused. */
export async function loadConnections(file: string): Promise<Connection[]> {
  let text: string;
  try {
    const stats = await lstat(file);
    if (!stats.isFile()) throw new InvalidConnectionsError(file, "not a regular file");
    if (stats.size > maxConnectionsBytes) throw new InvalidConnectionsError(file, `larger than ${maxConnectionsBytes} bytes`);
    text = await readFile(file, "utf8");
  } catch (error: unknown) {
    if (error instanceof InvalidConnectionsError) throw error;
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw new InvalidConnectionsError(file, "cannot be read");
  }
  return parseConnections(file, text);
}

/** Reads `.env` values. An absent file has no values. Callers must never print the values. */
export async function readEnvValues(envFile: string): Promise<Record<string, string>> {
  try {
    return parseEnvText(await readFile(envFile, "utf8"));
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return Object.create(null) as Record<string, string>;
    throw error;
  }
}

function isRefusedKey(name: string): boolean {
  return name.startsWith("DISCORD_") || name === "ANTHROPIC_API_KEY" || name.startsWith("POSTGRES_");
}

/**
 * A literal is secret-like when `secretLike` matches it with every `${NAME}` replaced by a marker.
 * A `key=`, `key:`, or `key is` match is accepted only when a reference follows it, and a `Bearer` match only when
 * its token is exactly one reference.
 */
function hasLiteralSecret(literal: string): boolean {
  const masked = literal.replace(referencePattern, referenceMarker);
  const pattern = new RegExp(secretLike.source, "gi");
  for (const match of masked.matchAll(pattern)) {
    const text = match[0];
    const after = masked.slice(match.index + text.length).replace(/^["'\s]*/, "");
    if (/(?:[:=]|\bis)$/i.test(text) && after.startsWith(referenceMarker)) continue;
    if (/^Bearer\s+/i.test(text) && text.replace(/^Bearer\s+/i, "") === referenceMarker) continue;
    return true;
  }
  return false;
}

function fillIn(file: string, where: string, literal: string, env: Record<string, string>): string {
  if (hasLiteralSecret(literal)) throw new InvalidConnectionsError(file, `${where} has a secret-like literal value; use a \${NAME} reference to .env`);
  return literal.replace(referencePattern, (_whole, name: string) => {
    if (secretLike.test(name)) throw new InvalidConnectionsError(file, `${where} has a secret-like reference name`);
    if (!envNamePattern.test(name)) throw new InvalidConnectionsError(file, `${where} has an unsupported reference form; use \${NAME}`);
    if (isRefusedKey(name)) throw new InvalidConnectionsError(file, `${where} refers to ${name}, an inoai key that cannot be shared`);
    const value = Object.hasOwn(env, name) ? env[name]! : "";
    if (value === "") throw new InvalidConnectionsError(file, `${where} refers to ${name}, which is missing or empty in .env`);
    if (value.includes("${")) throw new InvalidConnectionsError(file, `${where} refers to ${name}, whose .env value contains "\${"`);
    return value;
  });
}

/** A map key that names a secret. Its value must be one `${NAME}` reference, optionally after one auth scheme word. */
const secretKeyPattern = /password|passwd|secret|token|api[_-]?key|authorization/i;
const secretValuePattern = /^(?:(?:Bearer|Basic|token) )?\$\{[A-Za-z_][A-Za-z0-9_]*\}$/;

function fillInMap(file: string, where: string, map: Record<string, string>, env: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(map).map(([key, value]) => {
    if (secretKeyPattern.test(key) && !secretValuePattern.test(value)) {
      throw new InvalidConnectionsError(file, `${where} ${key} has a secret-like literal value; use a \${NAME} reference to .env`);
    }
    return [key, fillIn(file, `${where} ${key}`, value, env)];
  }));
}

function containsReferenceText(value: unknown): boolean {
  if (typeof value === "string") return value.includes("${");
  if (Array.isArray(value)) return value.some(containsReferenceText);
  if (isRecord(value)) return Object.entries(value).some(([key, item]) => key.includes("${") || containsReferenceText(item));
  return false;
}

/**
 * Fills in `${NAME}` references from `.env` values and builds Claude's `mcpServers` object and the extra
 * `--allowedTools` entries for one Turn. Throws `InvalidConnectionsError` for a missing, empty, or refused reference,
 * a secret-like literal, or any `${` left after the fill-in (Claude would expand it from its own environment).
 */
export function resolveConnections(file: string, connections: Connection[], env: Record<string, string>): ResolvedConnections {
  const mcpServers: Record<string, ClaudeMcpServer> = {};
  const allowedTools: string[] = [];
  for (const connection of connections) {
    const where = `connection "${connection.name}"`;
    let server: ClaudeMcpServer;
    if (connection.type === "stdio") {
      if (hasLiteralSecret(connection.command)) throw new InvalidConnectionsError(file, `${where} command has a secret-like literal value`);
      server = { type: "stdio", command: connection.command };
      if (connection.args) server.args = connection.args.map((arg, index) => fillIn(file, `${where} args[${index}]`, arg, env));
      if (connection.env) server.env = fillInMap(file, `${where} env`, connection.env, env);
    } else {
      server = { type: "http", url: fillIn(file, `${where} url`, connection.url, env) };
      if (connection.headers) server.headers = fillInMap(file, `${where} headers`, connection.headers, env);
    }
    if (containsReferenceText(server)) throw new InvalidConnectionsError(file, `${where} still contains "\${" after references are filled in`);
    mcpServers[connection.name] = server;
    if (connection.allow === "all") allowedTools.push(`mcp__${connection.name}`);
    else for (const tool of connection.allow) allowedTools.push(`mcp__${connection.name}__${tool}`);
  }
  return { mcpServers, allowedTools };
}

/** Loads and fully checks a home's connections. An absent file gives no connections. */
export async function loadResolvedConnections(home: { connectionsFile: string; envFile: string }): Promise<ResolvedConnections & { connections: Connection[] }> {
  const connections = await loadConnections(home.connectionsFile);
  if (connections.length === 0) return { connections, mcpServers: {}, allowedTools: [] };
  return { connections, ...resolveConnections(home.connectionsFile, connections, await readEnvValues(home.envFile)) };
}

export function summarizeConnections(connections: Connection[]): ConnectionSummary[] {
  return connections.map(({ name, type, allow }) => ({ name, type, allow: allow === "all" ? "all" : [...allow] }));
}

/**
 * The offline check behind `inoai connections validate|list`. It reads only `connections.json` and `.env`, never SQLite.
 * The result holds names, types, allow lists, and warnings only.
 */
export async function inspectConnections(home: { directory: string; connectionsFile: string; envFile: string }): Promise<{ present: boolean; connections: ConnectionSummary[]; warnings: string[] }> {
  const folder = await lstat(home.directory).catch(() => undefined);
  if (!folder?.isDirectory()) throw new Error(`Runtime home not found: ${home.directory}`);
  const present = await lstat(home.connectionsFile).then(() => true, () => false);
  const { connections } = await loadResolvedConnections(home);
  const warnings = connections.flatMap(({ name, allow }) =>
    allow === "all" ? [`connection "${name}" allows all of its tools; prefer a list of tool names`]
      : allow.length === 0 ? [`connection "${name}" allows no tools; its tool calls will be denied`] : []);
  return { present, connections: summarizeConnections(connections), warnings };
}
