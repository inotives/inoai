import { randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import { pathToFileURL } from "node:url";
import { renderAppShell } from "./pages/app-shell.js";
import { roleFixtures } from "./pages/role-fixtures.js";

// Fixture-only preview of the role picker prototype (T-0007).
// It reads no runtime home, SQLite file, or .env, and it has no write routes.
// Run: npm run build && node dist/ui/role-preview.js [--port 8990]

export const ROLE_PREVIEW_DEFAULT_PORT = 8990;

const previewData = {
  profile: { agentInstanceId: "inoai-connect-role-preview", provider: "codex", transport: "discord", workspaceIds: [], status: "running" },
  agentMarkdown: "# Agent\n\nThis is the role picker preview. All data is fixture data.",
};

export async function launchRolePreview(port = ROLE_PREVIEW_DEFAULT_PORT): Promise<{ server: Server; port: number }> {
  const token = randomBytes(32).toString("hex");
  let boundPort = port;
  const server = createServer((request, response) => {
    const method = request.method ?? "GET";
    const path = (request.url ?? "/").split("?")[0]!;
    const json = (status: number, body: unknown, headers: Record<string, string> = {}) => {
      response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers });
      response.end(JSON.stringify(body));
    };
    if (![`127.0.0.1:${boundPort}`, `localhost:${boundPort}`].includes(request.headers.host ?? "")) { json(403, { error: "Forbidden." }); return; }
    if (path !== "/" && path !== "/api/ui-data") { json(404, { error: "Not found." }); return; }
    if (method !== "GET" && !(path === "/" && method === "HEAD")) { json(405, { error: "Method not allowed." }, { allow: path === "/" ? "GET, HEAD" : "GET" }); return; }
    if (path === "/api/ui-data") { json(200, previewData); return; }
    response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
    response.end(renderAppShell(token, roleFixtures));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => { server.removeListener("error", reject); resolve(); });
  });
  const address = server.address();
  if (address && typeof address === "object") boundPort = address.port;
  return { server, port: boundPort };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  const port = args[0] === "--port" && args.length === 2 ? Number(args[1]) : args.length === 0 ? ROLE_PREVIEW_DEFAULT_PORT : NaN;
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    console.error("Usage: node dist/ui/role-preview.js [--port 8990]");
    process.exitCode = 1;
  } else {
    const preview = await launchRolePreview(port);
    console.log(`Role picker prototype (fixture data only): http://127.0.0.1:${preview.port}/  Click the status chip to open the agent profile. Press Ctrl+C to stop.`);
  }
}
