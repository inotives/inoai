import { lstat, readdir, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

import { buildEnabledSkillIndex, selectEnabledSkill, type SkillHome } from "./skill-loader.js";

/**
 * A provider-facing script location. This value is descriptive only. The
 * selected provider remains responsible for spawning the command and enforcing
 * its sandbox, network, and approval policy.
 */
export type SkillScriptInvocation = {
  skillId: string;
  scriptPath: string;
  cwd: string;
};

export class SkillScriptError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SkillScriptError";
  }
}

function isWithin(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path === "" || (path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path));
}

/**
 * Resolve an approved skill script without executing it.
 *
 * The package stays in the runtime home. The provider executes the returned
 * script with the Agent Runtime project workspace as cwd. No environment or
 * credential values are copied into this invocation.
 */
export async function prepareSkillScript(
  home: SkillHome,
  projectDirectory: string,
  request: { skillId: string; scriptPath: string },
): Promise<SkillScriptInvocation> {
  const index = await buildEnabledSkillIndex(home);
  const selected = selectEnabledSkill(index, { skillId: request.skillId });
  if (!selected) throw new SkillScriptError(`Skill is unknown or disabled: ${request.skillId}`);
  if (!request.scriptPath || isAbsolute(request.scriptPath)) {
    throw new SkillScriptError("Skill script path must be relative");
  }

  const packageDirectory = resolve(home.skillsDirectory, selected.id);
  const scriptsDirectory = resolve(packageDirectory, "scripts");
  const scriptCandidate = resolve(scriptsDirectory, request.scriptPath);
  if (!isWithin(scriptsDirectory, scriptCandidate)) {
    throw new SkillScriptError("Skill script path escapes the package scripts directory");
  }

  const scriptInfo = await lstat(scriptCandidate).catch(() => undefined);
  if (!scriptInfo?.isFile() || scriptInfo.isSymbolicLink()) {
    throw new SkillScriptError(`Skill script is not a regular file: ${request.scriptPath}`);
  }
  const [realScriptsDirectory, realScript] = await Promise.all([realpath(scriptsDirectory), realpath(scriptCandidate)]);
  if (!isWithin(realScriptsDirectory, realScript)) {
    throw new SkillScriptError("Skill script path resolves outside the package scripts directory");
  }

  const cwd = resolve(projectDirectory);
  const cwdInfo = await lstat(cwd).catch(() => undefined);
  if (!cwdInfo?.isDirectory() || cwdInfo.isSymbolicLink()) {
    throw new SkillScriptError("Agent Runtime project workspace must be a real directory");
  }
  return { skillId: selected.id, scriptPath: realScript, cwd };
}

async function scriptPaths(directory: string, current = directory): Promise<string[]> {
  const entries = await readdir(current, { withFileTypes: true });
  const paths: string[] = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const candidate = join(current, entry.name);
    const info = await lstat(candidate);
    if (info.isSymbolicLink()) throw new SkillScriptError(`Skill script entry is a symbolic link: ${entry.name}`);
    if (info.isDirectory()) paths.push(...await scriptPaths(directory, candidate));
    else if (info.isFile()) paths.push(relative(directory, candidate));
    else throw new SkillScriptError(`Unsupported skill script entry: ${entry.name}`);
  }
  return paths;
}

/** Prepare every regular script in an enabled skill for provider-facing instructions. */
export async function prepareSkillScripts(
  home: SkillHome,
  projectDirectory: string,
  request: { skillId: string },
): Promise<SkillScriptInvocation[]> {
  const index = await buildEnabledSkillIndex(home);
  const selected = selectEnabledSkill(index, request);
  if (!selected) throw new SkillScriptError(`Skill is unknown or disabled: ${request.skillId}`);
  const scriptsDirectory = resolve(home.skillsDirectory, selected.id, "scripts");
  const info = await lstat(scriptsDirectory).catch(() => undefined);
  if (!info) return [];
  if (!info.isDirectory() || info.isSymbolicLink()) throw new SkillScriptError("Skill scripts directory must be a real directory");
  const paths = await scriptPaths(scriptsDirectory);
  return Promise.all(paths.map((scriptPath) => prepareSkillScript(home, projectDirectory, { skillId: selected.id, scriptPath })));
}

/**
 * Add the execution boundary to selected skill instructions. This text does
 * not grant permissions and contains no runtime-home secrets.
 */
export function skillExecutionInstructions(invocation: SkillScriptInvocation): string {
  return [
    "",
    "[Skill execution policy]",
    `If this skill needs its script, use ${invocation.scriptPath} with the Agent Runtime project workspace as the current working directory: ${invocation.cwd}.`,
    "Use the provider's normal command tools. The provider sandbox, network policy, and approval policy remain authoritative.",
    "Do not read runtime-home .env files or copy credentials into command arguments, files, prompts, logs, or replies.",
    "Do not install, enable, update, or approve skills from a Turn.",
    "[End skill execution policy]",
  ].join("\n");
}
