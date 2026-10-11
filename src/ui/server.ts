import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { resolveRuntimeHome } from "../inoai/agent-instance/runtime-home.js";
import { loadUiData } from "./api/read-model.js";
import { renderAppShell } from "./pages/app-shell.js";
import { UI_DEFAULT_PORT } from "./common/options.js";

export type UiServer = { server: Server; port: number };

function respond(response: ServerResponse<IncomingMessage>, status: number, body: string): void {
  response.writeHead(status, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
  response.end(body);
}

function respondJson(response: ServerResponse<IncomingMessage>, status: number, body: unknown): void {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  response.end(JSON.stringify(body));
}

export async function launchUi(launchDirectory: string, connectDirectory?: string, port = UI_DEFAULT_PORT): Promise<UiServer> {
  const home = resolveRuntimeHome(launchDirectory, connectDirectory);
  const server = createServer(async (request, response) => {
    if (request.url === "/api/ui-data") {
      try { respondJson(response, 200, await loadUiData(home)); } catch { respondJson(response, 200, { error: "Runtime data unavailable" }); }
      return;
    }
    respond(response, 200, renderAppShell());
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", (error) => { server.close(); reject(error); });
    server.listen(port, "127.0.0.1", () => { server.removeListener("error", reject); resolve(); });
  });
  return { server, port };
}
