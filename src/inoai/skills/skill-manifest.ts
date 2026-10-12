import { createHash } from "node:crypto";
import { lstat, readdir, readFile, writeFile } from "node:fs/promises";
import { join, relative, sep } from "node:path";

export const skillCapabilityTypes = [
  "filesystem",
  "network",
  "process/command",
  "external_mutation",
] as const;

export type SkillCapabilityType = (typeof skillCapabilityTypes)[number];
export type SkillCapabilityValue = string | boolean;
export type SkillCapabilities = Record<SkillCapabilityType, SkillCapabilityValue>;

export type SkillSource = {
  locator: string;
  skill: string;
  revision: string;
};

export type SkillManifest = {
  id: string;
  version: string;
  capabilities: SkillCapabilities;
  source?: SkillSource;
};

export type EnabledSkillRecord = {
  id: string;
  version: string;
  hash: string;
  capabilities: SkillCapabilities;
  approved_by: string;
  approved_at: string;
};

export type EnabledSkillsDocument = {
  version: 1;
  skills: EnabledSkillRecord[];
};

export class InvalidSkillManifestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidSkillManifestError";
  }
}

export class InvalidEnabledSkillsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidEnabledSkillsError";
  }
}

const capabilitySet = new Set<string>(skillCapabilityTypes);
const idPattern = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const versionPattern = /^[0-9A-Za-z][0-9A-Za-z.+_-]{0,63}$/;
const hashPattern = /^[a-f0-9]{64}$/;

function scalar(value: string): SkillCapabilityValue {
  if (value === "true") return true;
  if (value === "false") return false;
  if (!value || /[:#{}\[\],]/.test(value) || /[\"']/.test(value)) {
    throw new InvalidSkillManifestError(`Invalid capability value: ${value}`);
  }
  return value;
}

function sourceScalar(value: string): string {
  if (!value || value !== value.trim() || /["'{}\[\],]/.test(value) || /[\x00-\x1f\x7f]/.test(value) || /:\s/.test(value)) {
    throw new InvalidSkillManifestError(`Invalid source value: ${value}`);
  }
  return value;
}

function validateSource(source: unknown): SkillSource {
  if (!source || typeof source !== "object" || Array.isArray(source)) throw new InvalidSkillManifestError("Invalid source block");
  const value = source as Record<string, unknown>;
  if (Object.keys(value).sort().join(",") !== "locator,revision,skill"
    || typeof value.locator !== "string" || typeof value.skill !== "string" || typeof value.revision !== "string"
    || !value.locator || !value.skill || !value.revision || !/^[a-z0-9][a-z0-9._-]{0,63}$/.test(value.skill)
    || /[\x00-\x1f\x7f]/.test(value.locator) || /(?:password|secret|token|api[_-]?key)=/i.test(value.locator)
    || /^[a-z][a-z0-9+.-]*:\/\/[^/]*@/i.test(value.locator)) {
    throw new InvalidSkillManifestError("Malformed source block");
  }
  sourceScalar(value.locator);
  sourceScalar(value.skill);
  sourceScalar(value.revision);
  return value as unknown as SkillSource;
}

/** Parse the deliberately small, strict YAML subset used by skill.yaml. */
export function parseSkillManifest(sourceText: string): SkillManifest {
  if (typeof sourceText !== "string" || !sourceText.trim()) throw new InvalidSkillManifestError("Manifest is empty");
  const lines = sourceText.replace(/\r\n/g, "\n").split("\n");
  let id: string | undefined;
  let version: string | undefined;
  let inCapabilities = false;
  let inSource = false;
  let capabilitiesSectionSeen = false;
  let sourceSectionSeen = false;
  const capabilities: Partial<SkillCapabilities> = {};
  const sourceFields: Partial<SkillSource> = {};
  for (const [index, line] of lines.entries()) {
    if (!line.trim() || line.trimStart().startsWith("#")) continue;
    if (line.includes("\t")) throw new InvalidSkillManifestError(`Tabs are not allowed on line ${index + 1}`);
    const indent = line.length - line.trimStart().length;
    const match = line.trim().match(/^([^:]+):\s*(.*)$/);
    if (!match || (indent !== 0 && !((inCapabilities || inSource) && indent === 2))) {
      throw new InvalidSkillManifestError(`Malformed manifest line ${index + 1}`);
    }
    const key = match[1].trim();
    const value = match[2].trim();
    if (indent === 0) {
      if (key === "capabilities") {
        if (value || capabilitiesSectionSeen) throw new InvalidSkillManifestError("capabilities must be a single mapping");
        capabilitiesSectionSeen = true;
        inCapabilities = true;
        inSource = false;
      } else if (key === "source") {
        if (value || sourceSectionSeen) throw new InvalidSkillManifestError("source must be a single mapping");
        sourceSectionSeen = true;
        inSource = true;
        inCapabilities = false;
      } else {
        inCapabilities = false;
        inSource = false;
        if (key === "id") {
          if (id !== undefined || !idPattern.test(value)) throw new InvalidSkillManifestError("Invalid or duplicate skill id");
          id = value;
        } else if (key === "version") {
          if (version !== undefined || !versionPattern.test(value)) throw new InvalidSkillManifestError("Invalid or duplicate skill version");
          version = value;
        } else {
          throw new InvalidSkillManifestError(`Unknown manifest field: ${key}`);
        }
      }
    } else {
      if (inCapabilities) {
        if (!capabilitySet.has(key) || !value || capabilities[key as SkillCapabilityType] !== undefined) {
          throw new InvalidSkillManifestError(`Invalid or duplicate capability: ${key}`);
        }
        capabilities[key as SkillCapabilityType] = scalar(value);
      } else if (inSource) {
        if (!(key === "locator" || key === "skill" || key === "revision") || !value || sourceFields[key as keyof SkillSource] !== undefined) {
          throw new InvalidSkillManifestError(`Invalid or duplicate source field: ${key}`);
        }
        sourceFields[key as keyof SkillSource] = sourceScalar(value);
      } else {
        throw new InvalidSkillManifestError(`Invalid or duplicate capability: ${key}`);
      }
    }
  }
  if (!id || !version || !capabilitiesSectionSeen) throw new InvalidSkillManifestError("Manifest requires id, version, and capabilities");
  const missing = skillCapabilityTypes.filter((type) => capabilities[type] === undefined);
  if (missing.length) throw new InvalidSkillManifestError(`Manifest is missing capabilities: ${missing.join(", ")}`);
  const manifest: SkillManifest = { id, version, capabilities: capabilities as SkillCapabilities };
  if (sourceSectionSeen) manifest.source = validateSource(sourceFields);
  return manifest;
}

export function serializeSkillManifest(manifest: SkillManifest): string {
  validateSkillManifest(manifest);
  return [
    `id: ${manifest.id}`,
    `version: ${manifest.version}`,
    ...(manifest.source ? ["source:", `  locator: ${manifest.source.locator}`, `  skill: ${manifest.source.skill}`, `  revision: ${manifest.source.revision}`] : []),
    "capabilities:",
    ...skillCapabilityTypes.map((type) => `  ${type}: ${String(manifest.capabilities[type])}`),
    "",
  ].join("\n");
}

export function validateSkillManifest(manifest: SkillManifest): SkillManifest {
  if (!manifest || typeof manifest !== "object" || !idPattern.test(manifest.id) || !versionPattern.test(manifest.version)) {
    throw new InvalidSkillManifestError("Invalid skill identity");
  }
  if (!manifest.capabilities || typeof manifest.capabilities !== "object") throw new InvalidSkillManifestError("Capabilities are required");
  const keys = Object.keys(manifest.capabilities);
  if (keys.length !== skillCapabilityTypes.length || keys.some((key) => !capabilitySet.has(key))) {
    throw new InvalidSkillManifestError("Unknown or incomplete capabilities");
  }
  for (const type of skillCapabilityTypes) {
    const value = manifest.capabilities[type];
    if ((typeof value !== "string" && typeof value !== "boolean") || value === "") {
      throw new InvalidSkillManifestError(`Invalid capability value: ${type}`);
    }
  }
  if (manifest.source !== undefined) validateSource(manifest.source);
  return manifest;
}

export function createGeneratedSkillManifest(id: string, source: SkillSource): SkillManifest {
  const manifest: SkillManifest = {
    id,
    version: "0.0.0",
    capabilities: {
      filesystem: "none",
      network: "none",
      "process/command": "none",
      external_mutation: "none",
    },
    source,
  };
  return validateSkillManifest(manifest);
}

export async function loadSkillManifest(file: string): Promise<SkillManifest> {
  return parseSkillManifest(await readFile(file, "utf8"));
}

async function packageFiles(directory: string, current = directory): Promise<string[]> {
  const entries = await readdir(current, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const full = join(current, entry.name);
    const info = await lstat(full);
    if (info.isSymbolicLink()) throw new Error(`Skill package cannot contain symlinks: ${entry.name}`);
    if (info.isDirectory()) files.push(...await packageFiles(directory, full));
    else if (info.isFile()) files.push(full);
    else throw new Error(`Unsupported skill package entry: ${entry.name}`);
  }
  return files;
}

export async function hashSkillPackage(directory: string): Promise<string> {
  const hash = createHash("sha256");
  for (const file of (await packageFiles(directory)).sort()) {
    const name = relative(directory, file).split(sep).join("/");
    hash.update(name).update("\0").update(await readFile(file)).update("\0");
  }
  return hash.digest("hex");
}

function isCapabilitySnapshot(value: unknown): value is SkillCapabilities {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return Object.keys(record).length === skillCapabilityTypes.length
    && skillCapabilityTypes.every((key) => (typeof record[key] === "string" || typeof record[key] === "boolean") && record[key] !== "");
}

export function validateEnabledSkills(document: unknown): EnabledSkillsDocument {
  if (!document || typeof document !== "object") throw new InvalidEnabledSkillsError("Enabled skills document must be an object");
  const value = document as { version?: unknown; skills?: unknown };
  if (value.version !== 1 || !Array.isArray(value.skills)) throw new InvalidEnabledSkillsError("Invalid enabled skills document");
  const ids = new Set<string>();
  const skills = value.skills.map((record) => {
    if (!record || typeof record !== "object") throw new InvalidEnabledSkillsError("Invalid enabled skill record");
    const item = record as Record<string, unknown>;
    const keys = Object.keys(item).sort();
    if (keys.join(",") !== "approved_at,approved_by,capabilities,hash,id,version") {
      throw new InvalidEnabledSkillsError("Enabled skill record contains unknown fields");
    }
    if (typeof item.id !== "string" || !idPattern.test(item.id) || ids.has(item.id)
      || typeof item.version !== "string" || !versionPattern.test(item.version)
      || typeof item.hash !== "string" || !hashPattern.test(item.hash)
      || typeof item.approved_by !== "string" || !item.approved_by
      || typeof item.approved_at !== "string" || Number.isNaN(Date.parse(item.approved_at))
      || !isCapabilitySnapshot(item.capabilities)) {
      throw new InvalidEnabledSkillsError("Malformed enabled skill record");
    }
    ids.add(item.id);
    return item as unknown as EnabledSkillRecord;
  });
  return { version: 1, skills };
}

export async function loadEnabledSkills(file: string): Promise<EnabledSkillsDocument> {
  try {
    return validateEnabledSkills(JSON.parse(await readFile(file, "utf8")));
  } catch (error) {
    if (error instanceof InvalidEnabledSkillsError) throw error;
    throw new InvalidEnabledSkillsError(`Cannot load enabled skills: ${String(error)}`);
  }
}

export async function saveEnabledSkills(file: string, document: EnabledSkillsDocument): Promise<void> {
  validateEnabledSkills(document);
  await writeFile(file, `${JSON.stringify(document, null, 2)}\n`, { mode: 0o600 });
}

export function isSkillApprovalCurrent(record: EnabledSkillRecord | undefined, manifest: SkillManifest, hash: string): boolean {
  return !!record && record.id === manifest.id && record.version === manifest.version && record.hash === hash
    && JSON.stringify(record.capabilities) === JSON.stringify(manifest.capabilities);
}

export function createSkillApproval(
  manifest: SkillManifest,
  hash: string,
  approvedBy: string,
  approvedAt = new Date().toISOString(),
): EnabledSkillRecord {
  validateSkillManifest(manifest);
  if (!hashPattern.test(hash)) throw new InvalidEnabledSkillsError("Skill approval requires a SHA-256 package hash");
  if (!approvedBy || approvedBy.includes("\n") || approvedBy.includes("\r")) {
    throw new InvalidEnabledSkillsError("Skill approval requires a valid approver");
  }
  if (Number.isNaN(Date.parse(approvedAt))) throw new InvalidEnabledSkillsError("Skill approval requires a valid timestamp");
  return {
    id: manifest.id,
    version: manifest.version,
    hash,
    capabilities: { ...manifest.capabilities },
    approved_by: approvedBy,
    approved_at: approvedAt,
  };
}
