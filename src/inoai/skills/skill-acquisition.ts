import { spawn } from "node:child_process";
import { isSea } from "node:sea";
import { cp, lstat, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";

import {
  createGeneratedSkillManifest,
  loadSkillManifest,
  serializeSkillManifest,
  type SkillSource,
} from "./skill-manifest.js";
import { installSkillPackage, listInstalledSkills, updateSkillPackage, type InstalledSkill } from "./skill-lifecycle.js";
import type { RuntimeHome } from "../agent-instance/runtime-home.js";

export class SkillAcquisitionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SkillAcquisitionError";
  }
}

export type SkillAcquisitionOptions = {
  source: string;
  skill?: string;
  revision?: string;
  update?: boolean;
  stagingDirectory?: string;
};

function remoteSource(source: string): boolean {
  return /^https?:\/\//i.test(source);
}

function resolveSkillsPage(source: string): { repository: string; skill: string } | undefined {
  const url = new URL(source);
  if (url.hostname !== "skills.sh") return undefined;
  const parts = url.pathname.split("/").filter(Boolean);
  if (parts.length < 3) throw new SkillAcquisitionError("skills.sh URL must include owner, repository, and skill");
  return { repository: `https://github.com/${parts[0]}/${parts[1]}`, skill: parts[2] };
}

async function assertTree(directory: string): Promise<void> {
  const rootInfo = await lstat(directory);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) throw new SkillAcquisitionError(`Skill package must be a real directory: ${directory}`);
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    const path = join(directory, entry.name);
    const info = await lstat(path);
    if (info.isSymbolicLink()) throw new SkillAcquisitionError(`Skill package cannot contain symlinks: ${entry.name}`);
    if (info.isDirectory()) await assertTree(path);
    else if (!info.isFile()) throw new SkillAcquisitionError(`Unsupported skill package entry: ${entry.name}`);
  }
}

async function packageCandidates(root: string): Promise<string[]> {
  const result: string[] = [];
  async function visit(directory: string): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true });
    if (entries.some((entry) => entry.name === "SKILL.md" && entry.isFile())) result.push(directory);
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name === ".git" || entry.name === "node_modules") continue;
      await visit(join(directory, entry.name));
    }
  }
  await visit(root);
  return result;
}

async function selectPackage(root: string, skill: string | undefined): Promise<string> {
  const candidates = await packageCandidates(root);
  if (!candidates.length) throw new SkillAcquisitionError("Source does not contain a SKILL.md package");
  if (!skill && candidates.length > 1) throw new SkillAcquisitionError("Source contains multiple skills; select one with --skill");
  if (!skill) return candidates[0];
  if (candidates.length === 1) return candidates[0];
  const matches = [] as string[];
  for (const candidate of candidates) {
    if (basename(candidate) === skill) matches.push(candidate);
    try {
      if ((await loadSkillManifest(join(candidate, "skill.yaml"))).id === skill) matches.push(candidate);
    } catch {
      // A missing manifest is valid; validation happens after selection.
    }
  }
  const unique = [...new Set(matches)];
  if (unique.length !== 1) throw new SkillAcquisitionError(`Skill was not found or is not unique: ${skill}`);
  return unique[0];
}

function runRemote(cwd: string, source: string, skill: string | undefined): Promise<void> {
  const args = isSea() ? ["--internal-skills", "add", source] : ["--yes", "skills", "add", source];
  if (skill) args.push("--skill", skill);
  args.push("--agent", "codex", "-y");
  return new Promise((resolveProcess, reject) => {
    const child = spawn(isSea() ? process.execPath : "npx", args, {
      cwd,
      env: { ...process.env, DISABLE_TELEMETRY: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    let stdout = "";
    child.stdout?.on("data", (chunk: Buffer) => { stdout = `${stdout}${chunk}`.slice(-4000); });
    child.stderr?.on("data", (chunk: Buffer) => { stderr = `${stderr}${chunk}`.slice(-2000); });
    child.once("error", reject);
    child.once("close", (code) => code === 0 ? resolveProcess() : reject(new SkillAcquisitionError(/spawn git ENOENT/i.test(stdout) ? "Git is required for this skill source. Install the macOS Command Line Tools (xcode-select --install), then retry." : `Remote skill acquisition failed (${code}): ${stderr.trim()}`)));
  });
}

async function preparePackage(sourceDirectory: string, staging: string, provenance: SkillSource): Promise<string> {
  await assertTree(sourceDirectory);
  const packageDirectory = join(staging, "package");
  await cp(sourceDirectory, packageDirectory, { recursive: true, errorOnExist: true, force: false });
  let manifest;
  try {
    manifest = await loadSkillManifest(join(packageDirectory, "skill.yaml"));
  } catch (error) {
    if (!(error instanceof Error) || !error.message.includes("ENOENT")) throw new SkillAcquisitionError(`Invalid skill manifest: ${String(error)}`);
    manifest = createGeneratedSkillManifest(provenance.skill, provenance);
  }
  manifest.source = provenance;
  await writeFile(join(packageDirectory, "skill.yaml"), serializeSkillManifest(manifest), { mode: 0o600 });
  return packageDirectory;
}

export async function acquireSkillPackage(home: RuntimeHome, options: SkillAcquisitionOptions): Promise<InstalledSkill> {
  const page = remoteSource(options.source) ? resolveSkillsPage(options.source) : undefined;
  const source = page?.repository ?? options.source;
  const skill = options.skill ?? page?.skill;
  if (remoteSource(source) && !skill) throw new SkillAcquisitionError("Remote repository sources require --skill");
  const staging = options.stagingDirectory ? resolve(options.stagingDirectory) : await mkdtemp(join(tmpdir(), "inoai-skill-acquire-"));
  const cleanup = !options.stagingDirectory;
  try {
    await mkdir(staging, { recursive: true, mode: 0o700 });
    const sourceRoot = remoteSource(source) ? staging : join(staging, "source");
    if (remoteSource(source)) await runRemote(staging, source, skill);
    else await cp(resolve(source), sourceRoot, { recursive: true, errorOnExist: true, force: false });
    const selected = await selectPackage(sourceRoot, skill);
    const provenance: SkillSource = { locator: options.source, skill: skill ?? basename(selected), revision: options.revision ?? (remoteSource(source) ? "resolved" : "working-tree") };
    const prepared = await preparePackage(selected, staging, provenance);
    return options.update
      ? await updateSkillPackage(home, prepared)
      : await installSkillPackage(home, prepared);
  } catch (error) {
    if (error instanceof SkillAcquisitionError) throw error;
    throw new SkillAcquisitionError(error instanceof Error ? error.message : String(error));
  } finally {
    if (cleanup) await rm(staging, { recursive: true, force: true }).catch(() => undefined);
  }
}

export async function updateAcquiredSkillPackage(home: RuntimeHome, skillId: string): Promise<InstalledSkill> {
  const installed = (await listInstalledSkills(home)).find((skill) => skill.manifest.id === skillId);
  if (!installed) throw new SkillAcquisitionError(`Skill is not installed: ${skillId}`);
  if (!installed.manifest.source) throw new SkillAcquisitionError(`Skill has no remembered source: ${skillId}`);
  const updated = await acquireSkillPackage(home, {
    source: installed.manifest.source.locator,
    skill: installed.manifest.source.skill,
    revision: installed.manifest.source.revision,
    update: true,
  });
  return updated;
}
