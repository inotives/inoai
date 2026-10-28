import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFile, mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { once } from "node:events";
import { createAgent } from "../dist/inoai/agent-instance/setup.js";

const root = await mkdtemp(join(tmpdir(), "inoai-standalone-test-"));
const executable = join(root, "inoai");
const agent = join(root, "agent");
const env = { ...process.env, PATH: "/usr/bin:/bin:/usr/sbin:/sbin", DISABLE_TELEMETRY: "1" };
const run = (args, customEnv = env) => spawnSync(executable, args, { cwd: root, env: customEnv, encoding: "utf8", timeout: 30_000 });
try {
  await copyFile(resolve("dist/standalone/inoai"), executable);
  const licenses = run(["--licenses"]);
  assert.equal(licenses.status, 0, licenses.stderr);
  assert.equal(licenses.stdout.trimEnd(), (await readFile(resolve("dist/standalone/THIRD_PARTY_NOTICES.txt"), "utf8")).trimEnd());
  for (const text of ["Node.js", "@sapphire/async-queue", "@sapphire/snowflake", "skills 1.7.4", "ThirdPartyNoticeText.txt", "discord.js"]) assert.ok(licenses.stdout.includes(text), `Missing notice for ${text}`);
  const answers = ["demo", agent, root, "codex", "fake.token", "123", "456", "789"];
  await createAgent(async () => answers.shift(), async () => true);
  for (const args of [["validate", "--dir", agent], ["skills", "list", "--dir", agent], ["memory", "list", "--dir", agent]]) {
    const result = run(args);
    assert.equal(result.status, 0, result.stderr);
  }
  const noGit = run(["skills", "add", "https://github.com/example/repository", "--skill", "example", "--dir", agent], { ...env, PATH: root });
  assert.notEqual(noGit.status, 0);
  assert.match(noGit.stderr, /Git is required.*xcode-select --install/);
  assert.deepEqual(JSON.parse(run(["skills", "list", "--dir", agent]).stdout), []);
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = server.address().port;
  const child = run(["start", "--dir", agent, "--port", String(port)]);
  assert.notEqual(child.status, 0);
  await new Promise((done) => server.close(done));
  console.log("Standalone notices, validation, management, missing Git and occupied-port checks passed.");
} finally {
  await rm(root, { recursive: true, force: true });
}
