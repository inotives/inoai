import { cp, lstat, mkdir, readdir, rename, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";

import {
  createSkillApproval,
  hashSkillPackage,
  isSkillApprovalCurrent,
  loadEnabledSkills,
  loadSkillManifest,
  saveEnabledSkills,
  type EnabledSkillRecord,
  type EnabledSkillsDocument,
  type SkillManifest,
} from "./skill-manifest.js";
import type { RuntimeHome } from "./runtime-home.js";

export class SkillLifecycleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SkillLifecycleError";
  }
}

export type InstalledSkill = {
  directory: string;
  manifest: SkillManifest;
  hash: string;
};

async function assertDirectory(directory: string, label: string): Promise<void> {
  let info;
  try {
    info = await lstat(directory);
  } catch (error: unknown) {
    throw new SkillLifecycleError(`${label} does not exist: ${directory}`);
  }
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new SkillLifecycleError(`${label} must be a real directory: ${directory}`);
  }
}

async function assertRegularFile(file: string, label: string): Promise<void> {
  let info;
  try {
    info = await lstat(file);
  } catch {
    throw new SkillLifecycleError(`${label} is required: ${file}`);
  }
  if (!info.isFile() || info.isSymbolicLink()) {
    throw new SkillLifecycleError(`${label} must be a regular file: ${file}`);
  }
}

export async function inspectInstalledSkill(directory: string): Promise<InstalledSkill> {
  await assertDirectory(directory, "Skill package");
  await assertRegularFile(join(directory, "SKILL.md"), "SKILL.md");
  await assertRegularFile(join(directory, "skill.yaml"), "skill.yaml");
  const manifest = await loadSkillManifest(join(directory, "skill.yaml"));
  const hash = await hashSkillPackage(directory);
  return { directory, manifest, hash };
}

function installedDirectory(home: RuntimeHome, id: string): string {
  if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(id)) throw new SkillLifecycleError(`Invalid skill id: ${id}`);
  return join(home.skillsDirectory, id);
}

async function readTrust(home: RuntimeHome): Promise<EnabledSkillsDocument> {
  try {
    return await loadEnabledSkills(home.skillsEnabledFile);
  } catch (error: unknown) {
    throw new SkillLifecycleError(error instanceof Error ? error.message : String(error));
  }
}

/**
 * Stage a package into one runtime home's skills directory. This operation
 * never enables the package. The source is a local directory prepared by the
 * owner, normally by the skills.sh CLI.
 */
export async function installSkillPackage(home: RuntimeHome, sourceDirectory: string, update = false): Promise<InstalledSkill> {
  const source = resolve(sourceDirectory);
  const inspected = await inspectInstalledSkill(source);
  const destination = installedDirectory(home, inspected.manifest.id);
  let destinationExists = true;
  try { await lstat(destination); } catch { destinationExists = false; }
  if (destinationExists && !update) {
    throw new SkillLifecycleError(`Skill is already installed: ${inspected.manifest.id}; use update to replace it`);
  }
  await mkdir(home.skillsDirectory, { recursive: true, mode: 0o700 });
  const staging = join(home.skillsDirectory, `.staging-${inspected.manifest.id}-${randomUUID()}`);
  try {
    await cp(source, staging, { recursive: true, errorOnExist: true, force: false });
    const staged = await inspectInstalledSkill(staging);
    if (staged.hash !== inspected.hash) throw new SkillLifecycleError("Staged skill hash changed during installation");
    if (destinationExists) await rm(destination, { recursive: true, force: true });
    await rename(staging, destination);
  } catch (error: unknown) {
    await rm(staging, { recursive: true, force: true }).catch(() => undefined);
    if (error instanceof SkillLifecycleError) throw error;
    throw new SkillLifecycleError(`Cannot install skill: ${error instanceof Error ? error.message : String(error)}`);
  }
  return { ...inspected, directory: destination };
}

/** Enable only after an explicit owner approval. A revision must be approved again. */
export async function enableSkill(home: RuntimeHome, skillId: string, approvedBy: string, approvedAt?: string): Promise<EnabledSkillRecord> {
  const installed = await inspectInstalledSkill(installedDirectory(home, skillId));
  const document = await readTrust(home);
  const record = createSkillApproval(installed.manifest, installed.hash, approvedBy, approvedAt);
  const next = document.skills.filter((item) => item.id !== skillId);
  next.push(record);
  await saveEnabledSkills(home.skillsEnabledFile, { version: 1, skills: next });
  return record;
}

export async function disableSkill(home: RuntimeHome, skillId: string): Promise<boolean> {
  const document = await readTrust(home);
  const next = document.skills.filter((item) => item.id !== skillId);
  if (next.length === document.skills.length) return false;
  await saveEnabledSkills(home.skillsEnabledFile, { version: 1, skills: next });
  return true;
}

/** Replace a staged package and revoke its prior approval. */
export async function updateSkillPackage(home: RuntimeHome, sourceDirectory: string): Promise<InstalledSkill> {
  const installed = await installSkillPackage(home, sourceDirectory, true);
  await disableSkill(home, installed.manifest.id);
  return installed;
}

export async function listInstalledSkills(home: RuntimeHome): Promise<Array<InstalledSkill & { enabled: boolean }>> {
  const trust = await readTrust(home);
  const enabled = new Map(trust.skills.map((record) => [record.id, record]));
  let entries;
  try { entries = await readdir(home.skillsDirectory, { withFileTypes: true }); }
  catch { return []; }
  const result: Array<InstalledSkill & { enabled: boolean }> = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
    const skill = await inspectInstalledSkill(join(home.skillsDirectory, entry.name));
    result.push({ ...skill, enabled: isSkillApprovalCurrent(enabled.get(skill.manifest.id), skill.manifest, skill.hash) });
  }
  return result;
}
