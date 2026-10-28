import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtemp, mkdir, rm, writeFile, access } from "node:fs/promises";
import { createServer as createTcpServer } from "node:net";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { test } from "node:test";
import { startForeground } from "../platform/foreground.js";
import { createAgent } from "../inoai/agent-instance/setup.js";

async function freePort(): Promise<number> {
  const server = createTcpServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

async function status(port: number, host: string): Promise<number> {
  return await new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, path: "/", headers: { host } }, (response) => {
      response.resume(); resolve(response.statusCode!);
    });
    req.on("error", reject); req.end();
  });
}

async function waitForFile(path: string): Promise<void> {
  for (let i = 0; i < 100; i += 1) {
    try { await access(path); return; } catch { await new Promise((resolve) => setTimeout(resolve, 20)); }
  }
  throw new Error(`File was not created: ${path}`);
}

test("foreground starts a separate UI, enforces Host, and stops agent with its lock released", async () => {
  const dir = await mkdtemp(join(tmpdir(), "inoai-foreground-"));
  const signals = new EventEmitter();
  const messages: string[] = [];
  try {
    for (const name of [".env", "agent.md", "skills-enabled.json"]) await writeFile(join(dir, name), "");
    const port = await freePort();
    const entry = fileURLToPath(new URL("../index.js", import.meta.url));
    const runtime = pathToFileURL(fileURLToPath(new URL("../inoai/agent-instance/runtime-home.js", import.meta.url))).href;
    const agent = `import { resolveRuntimeHome, acquireRuntimeHomeLock } from ${JSON.stringify(runtime)};
      const release = await acquireRuntimeHomeLock(resolveRuntimeHome(process.cwd(), ${JSON.stringify(`direct:${dir}`)}));
      process.on('SIGTERM', async () => { await release(); process.exit(0); });
      setInterval(() => {}, 1000);`;
    const result = startForeground({ connectDirectory: `direct:${dir}`, port, host: "127.0.0.1" }, {
      signals, report: (s) => messages.push(s), reportError: (s) => messages.push(s),
      spawnChild: (args) => args[0] === "ui"
        ? spawn(process.execPath, [entry, ...args], { stdio: ["ignore", "ignore", "ignore", "ipc"] })
        : spawn(process.execPath, ["--input-type=module", "-e", agent], { stdio: "ignore" }),
    });
    await waitForFile(join(dir, "inoai.lock"));
    assert.equal(await status(port, `127.0.0.1:${port}`), 200);
    assert.equal(await status(port, `example.com:${port}`), 403);
    assert.deepEqual(messages, [`UI: http://127.0.0.1:${port}`]);
    signals.emit("SIGINT");
    assert.equal(await result, 0);
    await assert.rejects(access(join(dir, "inoai.lock")));
    await assert.rejects(status(port, `127.0.0.1:${port}`));
  } finally { signals.emit("SIGTERM"); await rm(dir, { recursive: true, force: true }); }
});

test("occupied UI port fails without starting the agent", async () => {
  const blocker = createTcpServer();
  await new Promise<void>((resolve) => blocker.listen(0, "127.0.0.1", resolve));
  const port = (blocker.address() as { port: number }).port;
  const dir = await mkdtemp(join(tmpdir(), "inoai-foreground-"));
  try {
    for (const name of [".env", "agent.md", "skills-enabled.json"]) await writeFile(join(dir, name), "");
    const entry = fileURLToPath(new URL("../index.js", import.meta.url));
    let agentStarted = false;
    const errors: string[] = [];
    const code = await startForeground({ connectDirectory: `direct:${dir}`, port, host: "127.0.0.1" }, {
      signals: new EventEmitter(), report: () => {}, reportError: (s) => errors.push(s),
      spawnChild: (args) => {
        if (args[0] !== "ui") agentStarted = true;
        return spawn(process.execPath, [entry, ...args], { stdio: ["ignore", "ignore", "ignore", "ipc"] });
      },
    });
    assert.equal(code, 1);
    assert.equal(agentStarted, false);
    assert.deepEqual(errors, ["UI stopped unexpectedly."]);
  } finally {
    await new Promise<void>((resolve) => blocker.close(() => resolve()));
    await rm(dir, { recursive: true, force: true });
  }
});

test("start CLI accepts a direct folder and reports an occupied port", async () => {
  const blocker = createTcpServer();
  await new Promise<void>((resolve) => blocker.listen(0, "127.0.0.1", resolve));
  const port = (blocker.address() as { port: number }).port;
  const dir = await mkdtemp(join(tmpdir(), "inoai-foreground-"));
  try {
    for (const name of [".env", "agent.md", "skills-enabled.json"]) await writeFile(join(dir, name), "");
    const entry = fileURLToPath(new URL("../index.js", import.meta.url));
    const child = spawn(process.execPath, [entry, "start", "--dir", dir, "--port", String(port)], { stdio: ["ignore", "pipe", "pipe"] });
    let errors = "";
    child.stderr!.on("data", (data: Buffer) => { errors += data.toString(); });
    const code = await new Promise<number | null>((resolve, reject) => {
      child.once("error", reject); child.once("close", resolve);
    });
    assert.equal(code, 1);
    assert.match(errors, /EADDRINUSE|address already in use/i);
    await assert.rejects(access(join(dir, "inoai.lock")));
  } finally {
    await new Promise<void>((resolve) => blocker.close(() => resolve()));
    await rm(dir, { recursive: true, force: true });
  }
});

test("unexpected agent exit stops the UI and returns failure", async () => {
  const dir = await mkdtemp(join(tmpdir(), "inoai-foreground-"));
  try {
    for (const name of [".env", "agent.md", "skills-enabled.json"]) await writeFile(join(dir, name), "");
    const port = await freePort();
    const entry = fileURLToPath(new URL("../index.js", import.meta.url));
    const errors: string[] = [];
    const code = await startForeground({ connectDirectory: `direct:${dir}`, port, host: "127.0.0.1" }, {
      signals: new EventEmitter(), report: () => {}, reportError: (s) => errors.push(s),
      spawnChild: (args) => args[0] === "ui"
        ? spawn(process.execPath, [entry, ...args], { stdio: ["ignore", "ignore", "ignore", "ipc"] })
        : spawn(process.execPath, ["-e", "process.exit(5)"], { stdio: "ignore" }),
    });
    assert.equal(code, 1);
    assert.deepEqual(errors, ["Agent stopped unexpectedly."]);
    await assert.rejects(status(port, `127.0.0.1:${port}`));
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("unexpected UI exit stops the running agent and releases its lock", async () => {
  const dir = await mkdtemp(join(tmpdir(), "inoai-foreground-"));
  try {
    for (const name of [".env", "agent.md", "skills-enabled.json"]) await writeFile(join(dir, name), "");
    const port = await freePort();
    const entry = fileURLToPath(new URL("../index.js", import.meta.url));
    const runtime = pathToFileURL(fileURLToPath(new URL("../inoai/agent-instance/runtime-home.js", import.meta.url))).href;
    const agent = `import { resolveRuntimeHome, acquireRuntimeHomeLock } from ${JSON.stringify(runtime)};
      const release = await acquireRuntimeHomeLock(resolveRuntimeHome(process.cwd(), ${JSON.stringify(`direct:${dir}`)}));
      process.on('SIGTERM', async () => { await release(); process.exit(0); });
      setInterval(() => {}, 1000);`;
    let ui: ReturnType<typeof spawn> | undefined;
    const errors: string[] = [];
    const result = startForeground({ connectDirectory: `direct:${dir}`, port, host: "127.0.0.1" }, {
      signals: new EventEmitter(), report: () => {}, reportError: (s) => errors.push(s),
      spawnChild: (args) => {
        if (args[0] === "ui") return ui = spawn(process.execPath, [entry, ...args], { stdio: ["ignore", "ignore", "ignore", "ipc"] });
        return spawn(process.execPath, ["--input-type=module", "-e", agent], { stdio: "ignore" });
      },
    });
    await waitForFile(join(dir, "inoai.lock"));
    ui!.kill("SIGKILL");
    assert.equal(await result, 1);
    assert.deepEqual(errors, ["UI stopped unexpectedly."]);
    await assert.rejects(access(join(dir, "inoai.lock")));
  } finally { await rm(dir, { recursive: true, force: true }); }
});

for (const provider of ["codex", "claude", "opencode"]) test(`Ctrl+C during slow ${provider} startup releases the actual runtime lock`, async () => {
  const root = await mkdtemp(join(tmpdir(), "inoai-slow-start-"));
  const folder = join(root, "agent");
  const marker = join(root, "provider-started");
  const bin = join(root, "bin");
  let child: ReturnType<typeof spawn> | undefined;
  try {
    await mkdir(bin);
    await writeFile(join(bin, provider), `#!/bin/sh\ntouch '${marker}'\nexec sleep 30\n`, { mode: 0o755 });
    const values = ["review", folder, root, provider, "fake.token", "123", "456", "789"];
    await createAgent(async () => values.shift()!, async () => true);
    const entry = fileURLToPath(new URL("../index.js", import.meta.url));
    const port = await freePort();
    child = spawn(process.execPath, [entry, "start", "--dir", folder, "--port", String(port)], {
      env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ""}` }, stdio: ["ignore", "ignore", "pipe"],
    });
    let errors = "";
    child.stderr!.on("data", (chunk: Buffer) => { errors += chunk.toString(); });
    const closed = new Promise<number | null>((resolve, reject) => {
      child!.once("error", reject); child!.once("close", resolve);
    });
    await waitForFile(marker);
    await access(join(folder, "inoai.lock"));
    child.kill("SIGINT");
    assert.equal(await closed, 0, errors);
    await assert.rejects(access(join(folder, "inoai.lock")));
    await assert.rejects(status(port, `127.0.0.1:${port}`));
  } finally {
    if (child && child.exitCode === null) child.kill("SIGKILL");
    await rm(root, { recursive: true, force: true });
  }
});
