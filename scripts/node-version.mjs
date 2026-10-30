// Node.js lines patched by the 2026-10-21 security release. Keep in sync with package.json engines.
export const patchedNode = { 22: [22, 23, 4], 24: [24, 22, 1], 26: [26, 12, 1] };

export function isPatchedNode(version) {
  const parts = /^v?(\d+)\.(\d+)\.(\d+)/.exec(version)?.slice(1).map(Number);
  if (!parts) return false;
  const minimum = parts[0] > 26 ? patchedNode[26] : patchedNode[parts[0]];
  if (!minimum) return false;
  for (let index = 0; index < 3; index += 1) if (parts[index] !== minimum[index]) return parts[index] > minimum[index];
  return true;
}

export function assertPatchedNode(version = process.version) {
  if (!isPatchedNode(version)) throw new Error(`Node.js ${version} lacks the October 2026 security fixes; use ${Object.values(patchedNode).map((v) => v.join(".")).join(", ")} or newer on that line`);
}
