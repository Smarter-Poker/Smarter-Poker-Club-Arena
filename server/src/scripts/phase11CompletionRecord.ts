/**
 * P11.3 completion reader, stage 2: writes one pack's natural
 * `horse-phase11-completion-v1` record from the stage 1 extract
 * (server/scripts/phase11-completion-extract.py, run read-only on the engine
 * host), counting with the authority's own `horsePhase11CompletionCounts`, so
 * the record means exactly what admission reads.
 *
 * The policy digest is computed from the release's own sources
 * (`git show <release>:server/<path>`), never from this checkout, so the
 * record binds the code that made the decisions.
 *
 * Usage: node --import tsx src/scripts/phase11CompletionRecord.ts
 *   --variant=plo8 --release=<sha40> --from=<iso> --to=<iso>
 *   --release-unchanged=true --source=<text> < extract.ndjson > record.json
 * Refuses by name: unknown_variant, invalid_release, invalid_window,
 * release_unchanged_not_proven, release_sources_unavailable, no_records.
 */
import { execFileSync } from 'node:child_process';
import { createInterface } from 'node:readline';
import {
  HORSE_PHASE11_COMPLETION_DEFINITION,
  HORSE_PHASE11_COMPLETION_SCHEMA,
  horsePhase11CompletionCounts,
  horsePhase11CompletionLowerBound,
  horsePhase11CompletionMeetsFloor,
  HORSE_PHASE11_COMPLETION_STREETS,
} from '../engine/HorsePhase11Authority.js';
import {
  HORSE_PHASE11_POLICY_DIGEST_DEFINITION,
  horsePhase11PolicyDigestOf,
} from '../engine/HorsePhase11PolicyDigest.js';
import {
  isOmahaPolicyVariant,
  OMAHA_VARIANT_PACKS,
} from '../engine/omaha/OmahaVariantPolicyPack.js';

const arg = (name: string) =>
  process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const refuse = (reason: string): never => {
  process.stderr.write(`refused: ${reason}\n`);
  process.exit(2);
};
const variant = arg('variant');
if (!isOmahaPolicyVariant(variant)) refuse('unknown_variant');
const pack = variant as 'plo5' | 'plo6' | 'plo8';
const release = arg('release') ?? '';
if (!/^[0-9a-f]{40}$/.test(release)) refuse('invalid_release');
const from = arg('from') ?? '';
const to = arg('to') ?? '';
if (!(Date.parse(from) < Date.parse(to))) refuse('invalid_window');
if (arg('release-unchanged') !== 'true') refuse('release_unchanged_not_proven');
const source = arg('source') ?? 'journal archive segments';

const policyDigest = horsePhase11PolicyDigestOf(pack, (path) =>
  execFileSync('git', ['show', `${release}:server/${path}`], { maxBuffer: 64 * 1024 * 1024 })
);
if (!policyDigest) refuse('release_sources_unavailable');

const receipts: unknown[] = [];
for await (const line of createInterface({ input: process.stdin })) {
  if (!line.trim()) continue;
  const row = JSON.parse(line) as { receipt: unknown };
  receipts.push(row.receipt);
}
if (!receipts.length) refuse('no_records');
const streets = horsePhase11CompletionCounts(pack, receipts);
const record = {
  schema: HORSE_PHASE11_COMPLETION_SCHEMA,
  definition: HORSE_PHASE11_COMPLETION_DEFINITION,
  variant: pack,
  packVersion: OMAHA_VARIANT_PACKS[pack].version,
  releaseSha: release,
  policyDigestDefinition: HORSE_PHASE11_POLICY_DIGEST_DEFINITION,
  policyDigest,
  gameMode: 'cash',
  window: { from, to, releaseUnchanged: true, source },
  streets,
};
process.stdout.write(`${JSON.stringify(record, null, 2)}\n`);
process.stderr.write(
  `${JSON.stringify({
    records: receipts.length,
    lowerBounds: Object.fromEntries(
      HORSE_PHASE11_COMPLETION_STREETS.map((s) => [
        s,
        horsePhase11CompletionLowerBound(streets[s].completed, streets[s].eligible),
      ])
    ),
    meetsFloor: horsePhase11CompletionMeetsFloor(streets),
  })}\n`
);
