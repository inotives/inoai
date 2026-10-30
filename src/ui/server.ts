import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { resolveRuntimeHome, type RuntimeHome } from "../inoai/agent-instance/runtime-home.js";
import { loadUiData } from "./api/read-model.js";
import { applyUiTaskAction, createUiTask, editUiTask, TaskWriteError, type TaskAction } from "./api/task-writes.js";
import { renderAppShell } from "./pages/app-shell.js";
import { UI_DEFAULT_HOST, UI_DEFAULT_PORT } from "./common/options.js";

export type UiServer = { server: Server; port: number };

export const uiTokenHeader = "x-inoai-token";
const bodyLimitBytes = 32 * 1024;

function respond(response: ServerResponse<IncomingMessage>, status: number, body: string): void {
  response.writeHead(status, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
  response.end(body);
}

function respondJson(response: ServerResponse<IncomingMessage>, status: number, body: unknown): void {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  response.end(JSON.stringify(body));
}

function respondMethodNotAllowed(response: ServerResponse<IncomingMessage>, allow: string): void {
  response.setHeader("allow", allow);
  respondJson(response, 405, { error: "Method not allowed." });
}

class RequestRejected extends Error {
  constructor(readonly status: 400 | 403 | 404 | 405, readonly reason: string, readonly publicMessage: string, readonly allow?: string) {
    super(reason);
  }
}

function digest(value: string): Buffer {
  return createHash("sha256").update(value).digest();
}

// Compares fixed-length digests so the comparison time does not depend on the token.
function tokenMatches(supplied: string | string[] | undefined, token: string): boolean {
  return typeof supplied === "string" && timingSafeEqual(digest(supplied), digest(token));
}

function checkWriteRequest(request: IncomingMessage, hosts: string[], token: string): void {
  const forbidden = (reason: string) => new RequestRejected(403, reason, "Forbidden.");
  if (!hosts.includes(request.headers.host ?? "")) throw forbidden("host");
  if (!hosts.some((host) => request.headers.origin === `http://${host}`)) throw forbidden("origin");
  if ((request.headers["content-type"] ?? "").split(";")[0]!.trim().toLowerCase() !== "application/json") throw forbidden("content-type");
  if (!tokenMatches(request.headers[uiTokenHeader], token)) throw forbidden("token");
  if (Number(request.headers["content-length"] ?? 0) > bodyLimitBytes) throw forbidden("body-size");
}

function readJsonBody(request: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    request.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > bodyLimitBytes) { reject(new RequestRejected(403, "body-size", "Forbidden.")); request.pause(); return; }
      chunks.push(chunk);
    });
    request.on("error", reject);
    request.on("end", () => {
      const text = Buffer.concat(chunks).toString("utf8");
      if (!text.trim()) { resolve({}); return; }
      try { resolve(JSON.parse(text)); } catch { reject(new RequestRejected(400, "json", "Request body must be valid JSON.")); }
    });
  });
}

type TaskRoute = { kind: "create" } | { kind: "edit"; id: number } | { kind: "action"; id: number; action: TaskAction };

function taskRoute(method: string, path: string): TaskRoute | undefined {
  if (path === "/api/tasks") {
    if (method !== "POST") throw new RequestRejected(405, "method", "Method not allowed.", "POST");
    return { kind: "create" };
  }
  const match = /^\/api\/tasks\/(\d{1,15})(?:\/(run|pause|resume|cancel))?$/.exec(path);
  if (!match) {
    if (path.startsWith("/api/tasks/")) throw new RequestRejected(404, "route", "Not found.");
    return undefined;
  }
  const id = Number(match[1]);
  if (match[2] === undefined) {
    if (method !== "PATCH") throw new RequestRejected(405, "method", "Method not allowed.", "PATCH");
    return { kind: "edit", id };
  }
  if (method !== "POST") throw new RequestRejected(405, "method", "Method not allowed.", "POST");
  return { kind: "action", id, action: match[2] as TaskAction };
}

// Logs only the method, path, and reason. Never the token, headers, or body.
function logRejection(method: string, path: string, reason: string): void {
  console.warn(`ui task write rejected: ${method} ${path} ${reason}`);
}

async function handleTaskWrite(request: IncomingMessage, response: ServerResponse<IncomingMessage>, home: RuntimeHome,
  route: TaskRoute, hosts: string[], token: string, method: string, path: string): Promise<void> {
  try {
    checkWriteRequest(request, hosts, token);
    const body = await readJsonBody(request);
    const task = route.kind === "create" ? createUiTask(home, body)
      : route.kind === "edit" ? editUiTask(home, route.id, body)
        : applyUiTaskAction(home, route.id, route.action);
    respondJson(response, route.kind === "create" ? 201 : 200, { task });
  } catch (error) {
    if (error instanceof RequestRejected) {
      logRejection(method, path, error.reason);
      response.setHeader("connection", "close");
      respondJson(response, error.status, { error: error.publicMessage });
    } else if (error instanceof TaskWriteError) {
      if (error.status >= 500) logRejection(method, path, error.retryable ? "busy" : "unavailable");
      respondJson(response, error.status, { error: error.message, ...(error.fields ? { fields: error.fields } : {}), ...(error.retryable ? { retryable: true } : {}) });
    } else {
      logRejection(method, path, "write-failed");
      respondJson(response, 500, { error: "Task write failed." });
    }
  }
}

export async function launchUi(launchDirectory: string, connectDirectory?: string, port = UI_DEFAULT_PORT, host = UI_DEFAULT_HOST): Promise<UiServer> {
  const home = resolveRuntimeHome(launchDirectory, connectDirectory);
  const token = randomBytes(32).toString("hex");
  let boundPort = port;
  const server = createServer(async (request, response) => {
    const method = request.method ?? "GET";
    const path = (request.url ?? "/").split("?")[0]!;
    const hosts = host === UI_DEFAULT_HOST ? [`127.0.0.1:${boundPort}`, `localhost:${boundPort}`] : [`${host}:${boundPort}`];
    // Every path needs the server's own Host, so a DNS-rebinding page cannot read the page, token, or data.
    if (!hosts.includes(request.headers.host ?? "")) {
      if (path === "/api/tasks" || path.startsWith("/api/tasks/")) logRejection(method, path, "host");
      response.setHeader("connection", "close");
      respondJson(response, 403, { error: "Forbidden." });
      return;
    }
    if (path === "/api/ui-data") {
      if (method !== "GET") { respondMethodNotAllowed(response, "GET"); return; }
      try { respondJson(response, 200, await loadUiData(home)); } catch { respondJson(response, 200, { error: "Runtime data unavailable" }); }
      return;
    }
    if (path === "/") {
      if (method !== "GET" && method !== "HEAD") { respondMethodNotAllowed(response, "GET, HEAD"); return; }
      respond(response, 200, renderAppShell(token));
      return;
    }
    let route: TaskRoute | undefined;
    try {
      route = taskRoute(method, path);
    } catch (error) {
      const rejected = error as RequestRejected;
      logRejection(method, path, rejected.reason);
      if (rejected.allow) response.setHeader("allow", rejected.allow);
      respondJson(response, rejected.status, { error: rejected.publicMessage });
      return;
    }
    if (route) { await handleTaskWrite(request, response, home, route, hosts, token, method, path); return; }
    respondJson(response, 404, { error: "Not found." });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", (error) => { server.close(); reject(error); });
    server.listen(port, host, () => { server.removeListener("error", reject); resolve(); });
  });
  const address = server.address();
  if (address && typeof address === "object") boundPort = address.port;
  return { server, port: boundPort };
}
