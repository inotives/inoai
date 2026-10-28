import { build } from "esbuild";
import { spawnSync } from "node:child_process";
import { copyFile, mkdtemp, mkdir, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

if (process.platform !== "darwin" || process.arch !== "arm64") throw new Error("Build requires Apple Silicon macOS");
const root = resolve(import.meta.dirname, "..");
const temporary = await mkdtemp(join(tmpdir(), "inoai-standalone-"));
const output = join(root, "dist", "standalone", "inoai");
const command = (program, args) => {
  const result = spawnSync(program, args, { stdio: "inherit" });
  if (result.error || result.status !== 0) throw result.error ?? new Error(`${program} failed (${result.status})`);
};
try {
  const banner = 'import { createRequire as __createRequire } from "node:module"; import { pathToFileURL as __pathToFileURL } from "node:url"; const require = __createRequire(process.execPath); const __inoaiModuleUrl = __pathToFileURL(process.execPath).href;';
  const packageDirectories = new Set();
  for (const [entry, outfile] of [["src/index.ts", "app.mjs"], ["node_modules/skills/dist/cli.mjs", "skills.mjs"]]) {
    const result = await build({ absWorkingDir: root, entryPoints: [join(root, entry)], outfile: join(temporary, outfile), bundle: true, platform: "node", format: "esm", target: "node22", banner: { js: banner }, metafile: true, ...(outfile === "skills.mjs" ? { define: { "import.meta.url": "__inoaiModuleUrl" } } : {}) });
    for (const input of Object.keys(result.metafile.inputs)) {
      if (!input.includes("node_modules/")) continue;
      let directory = dirname(resolve(root, input));
      let found = false;
      while (directory.startsWith(join(root, "node_modules"))) {
        try {
          const metadata = JSON.parse(await readFile(join(directory, "package.json"), "utf8"));
          if (metadata.name && metadata.version) { packageDirectories.add(directory); found = true; break; }
        } catch { /* Search the parent directory. */ }
        directory = dirname(directory);
      }
      if (!found) throw new Error(`Cannot identify bundled dependency for ${input}`);
    }
  }
  await build({ entryPoints: [join(root, "src/inoai/heartbeat/sqlite-probe.ts")], outfile: join(temporary, "sqlite-probe.cjs"), bundle: true, platform: "node", format: "cjs", target: "node22" });
  const nodeLicense = process.env.INOAI_NODE_LICENSE ?? join(dirname(dirname(await realpath(process.execPath))), "LICENSE");
  let notices = `Node.js ${process.version}\n\n${await readFile(nodeLicense, "utf8")}\n`;
  for (const directory of [...packageDirectories].sort()) {
    const metadata = JSON.parse(await readFile(join(directory, "package.json"), "utf8"));
    const files = (await readdir(directory)).filter((name) => /^(licen[sc]e|copying|notice|thirdparty)/i.test(name)).sort();
    if (!files.length && ["@sapphire/async-queue", "@sapphire/snowflake"].includes(metadata.name)) {
      notices += `\n\n${metadata.name} ${metadata.version}\n\n${await readFile(join(root, "licenses/sapphire-utilities-LICENSE.md"), "utf8")}\n`;
    } else {
      if (!files.length) throw new Error(`No license file for bundled dependency ${metadata.name} (${directory})`);
      for (const file of files) notices += `\n\n${metadata.name} ${metadata.version} — ${file}\n\n${await readFile(join(directory, file), "utf8")}\n`;
    }
  }
  const noticesFile = join(temporary, "THIRD_PARTY_NOTICES.txt");
  await writeFile(noticesFile, notices);
  const main = join(temporary, "main.cjs");
  await writeFile(main, `const { getAsset } = require('node:sea');\nif (process.argv[2] === '--licenses') { console.log(getAsset('THIRD_PARTY_NOTICES.txt', 'utf8')); }\nelse { const skills = process.argv[2] === '--internal-skills';\nif (skills) process.argv.splice(2, 1);\nconst asset = skills ? 'skills.mjs' : 'app.mjs';\nimport('data:text/javascript;base64,' + Buffer.from(getAsset(asset)).toString('base64')).catch(error => { console.error(error.message); process.exitCode = 1; }); }\n`);
  const blob = join(temporary, "sea.blob");
  const config = join(temporary, "sea.json");
  await writeFile(config, JSON.stringify({ main, output: blob, assets: { "app.mjs": join(temporary, "app.mjs"), "skills.mjs": join(temporary, "skills.mjs"), "sqlite-probe.cjs": join(temporary, "sqlite-probe.cjs"), "THIRD_PARTY_NOTICES.txt": noticesFile } }));
  command(process.execPath, ["--experimental-sea-config", config]);
  await mkdir(join(root, "dist", "standalone"), { recursive: true });
  await copyFile(process.execPath, output);
  command("/usr/bin/codesign", ["--remove-signature", output]);
  command(process.execPath, [join(root, "node_modules/postject/dist/cli.js"), output, "NODE_SEA_BLOB", blob, "--sentinel-fuse", "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2", "--macho-segment-name", "NODE_SEA"]);
  command("/usr/bin/codesign", ["--sign", "-", output]);
  await copyFile(noticesFile, join(root, "dist", "standalone", "THIRD_PARTY_NOTICES.txt"));
  console.log(`Standalone executable: ${output}`);
} finally {
  await rm(temporary, { recursive: true, force: true });
}
