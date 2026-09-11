/**
 * A caller introduced on this branch may merge only after its schema object is
 * already present in the comparison tree's generated base snapshot or the live
 * database proves it. The only base exemptions are genuine non-public table
 * targets. Schema fragments and unbuilt-feature allowlists are declarations,
 * not deployment authority, so they never certify a newly introduced caller.
 */
export const FROM_REFERENCE = /(?<!storage)\.from\s*\(\s*['"`]([a-z_][a-z0-9_]*)['"`]/g;
export const RPC_REFERENCE = /\.rpc\s*\(\s*['"`]([a-z_][a-z0-9_]*)['"`]/g;

export function namesNeedingLiveProof({
  currentNames,
  baseSourceNames,
  baseManifestNames,
  baseAllowNames,
}) {
  const inherited = new Set(baseSourceNames);
  const schemaFirst = new Set(baseManifestNames);
  const inheritedAllow = new Set(baseAllowNames);
  return [...new Set(currentNames)]
    .filter((name) => !inherited.has(name) && !schemaFirst.has(name) && !inheritedAllow.has(name))
    .sort();
}

export function namesMissingFromLive(pendingNames, liveNames) {
  const live = new Set(liveNames);
  return [...new Set(pendingNames)].filter((name) => !live.has(name)).sort();
}
