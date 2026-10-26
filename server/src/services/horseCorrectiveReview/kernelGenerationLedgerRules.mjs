/** Shared immutable release-data rules, used by runtime and publication guard. */
import { createHash } from 'node:crypto';
export const PHASE14_GENERATION_LEDGER_PATH = 'docs/evidence/phase14/generation-ledger.json';
export const PHASE14_GENERATION_LEDGER_SCHEMA = 'horse-phase14-generation-ledger-v1';
export const PHASE14_GENERATION_DOMAINS = Object.freeze(
  ['nlh', 'plo4', 'plo5', 'plo6', 'plo8', 'short_deck', 'pineapple', 'flh', 'flo8']
    .flatMap((variant) =>
      ['cash', 'mtt', 'sng', 'spin', 'hu_sng'].map((format) => variant + '-' + format)
    )
    .sort()
);
const object = (value) => !!value && typeof value === 'object' && !Array.isArray(value);
const exact = (value, keys) =>
  object(value) && Object.keys(value).sort().join(',') === [...keys].sort().join(',');
function canonical(value) {
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'boolean' ||
    (typeof value === 'number' && Number.isFinite(value))
  )
    return value;
  if (Array.isArray(value)) return value.map(canonical);
  if (!object(value)) throw Error('generation_value_invalid');
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .filter((key) => value[key] !== undefined)
      .map((key) => [key, canonical(value[key])])
  );
}
export function phase14SelectionIdentityDigest(selection) {
  const { withdrawn, ...identity } = selection;
  return createHash('sha256')
    .update(JSON.stringify(canonical(identity)))
    .digest('hex');
}
export function parsePhase14GenerationLedger(value) {
  if (
    !exact(value, ['schema', 'domains']) ||
    value.schema !== PHASE14_GENERATION_LEDGER_SCHEMA ||
    !exact(value.domains, PHASE14_GENERATION_DOMAINS)
  )
    return null;
  const domains = {};
  for (const domain of PHASE14_GENERATION_DOMAINS) {
    const entry = value.domains[domain];
    if (
      !exact(entry, ['highestPublishedGeneration', 'authorityDigest', 'retiredGenerations']) ||
      !Number.isSafeInteger(entry.highestPublishedGeneration) ||
      entry.highestPublishedGeneration < 0 ||
      !Array.isArray(entry.retiredGenerations) ||
      entry.retiredGenerations.length > 10000
    )
      return null;
    if (
      entry.highestPublishedGeneration === 0
        ? entry.authorityDigest !== null || entry.retiredGenerations.length !== 0
        : typeof entry.authorityDigest !== 'string' || !/^[a-f0-9]{64}$/.test(entry.authorityDigest)
    )
      return null;
    let last = 0;
    for (const retired of entry.retiredGenerations) {
      if (
        !Number.isSafeInteger(retired) ||
        retired <= last ||
        retired > entry.highestPublishedGeneration
      )
        return null;
      last = retired;
    }
    domains[domain] = Object.freeze({
      ...entry,
      retiredGenerations: Object.freeze([...entry.retiredGenerations]),
    });
  }
  return Object.freeze({
    schema: PHASE14_GENERATION_LEDGER_SCHEMA,
    domains: Object.freeze(domains),
  });
}
export function phase14LedgerSelectionAllowed(ledger, domain, selection) {
  if (!ledger || !PHASE14_GENERATION_DOMAINS.includes(domain)) return false;
  if (selection === null) return true;
  const entry = ledger.domains[domain];
  if (
    !object(selection) ||
    selection.domain !== domain ||
    selection.approvalGeneration !== entry.highestPublishedGeneration ||
    entry.highestPublishedGeneration < 1 ||
    phase14SelectionIdentityDigest(selection) !== entry.authorityDigest
  )
    return false;
  const retired = entry.retiredGenerations.includes(selection.approvalGeneration);
  if (selection.withdrawn === null) return !retired;
  return (
    object(selection.withdrawn) &&
    typeof selection.withdrawn.at === 'string' &&
    Number.isFinite(Date.parse(selection.withdrawn.at)) &&
    typeof selection.withdrawn.reason === 'string' &&
    selection.withdrawn.reason.length > 0 &&
    retired
  );
}
export function phase14GenerationTransitionAllowed(before, after) {
  if (!after) return false;
  if (before === null)
    return PHASE14_GENERATION_DOMAINS.every(
      (domain) => after.domains[domain].highestPublishedGeneration === 0
    );
  return PHASE14_GENERATION_DOMAINS.every((domain) => {
    const a = before.domains[domain],
      b = after.domains[domain];
    return (
      b.highestPublishedGeneration >= a.highestPublishedGeneration &&
      a.retiredGenerations.every((generation) => b.retiredGenerations.includes(generation)) &&
      (a.highestPublishedGeneration !== b.highestPublishedGeneration ||
        a.authorityDigest === b.authorityDigest)
    );
  });
}
