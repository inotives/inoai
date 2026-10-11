import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import process from "node:process";

const sourceRoot = join(process.cwd(), "src");
const allowedRootFiles = new Set(["index.ts"]);
const violations = [];

for (const entry of await readdir(sourceRoot, { withFileTypes: true })) {
  if (entry.isFile() && entry.name.endsWith(".ts") && !allowedRootFiles.has(entry.name)) {
    violations.push(`production file directly under src/: ${entry.name}`);
  }
}

async function walk(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) await walk(path);
    if (!entry.isFile() || !entry.name.endsWith(".ts")) continue;
    const source = await readFile(path, "utf8");
    if (/from\s+["'][^"']*(?:^|\/)ui(?:\/|["'])|import\s*\(\s*["'][^"']*(?:^|\/)ui(?:\/|["'])/.test(source)) {
      violations.push(`inoai module imports UI: ${relative(process.cwd(), path)}`);
    }
  }
}

const inoaiRoot = join(sourceRoot, "inoai");
try {
  await walk(inoaiRoot);
} catch (error) {
  if (error?.code !== "ENOENT") throw error;
}

if (violations.length > 0) {
  console.error("Source architecture violations:");
  for (const violation of violations) console.error(`- ${violation}`);
  process.exitCode = 1;
} else {
  console.log("Source architecture checks passed.");
}
