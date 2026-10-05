/**
 * P12.3 completion reader, stage 2: writes one pack's natural
 * `horse-phase12-completion-v1` record from the stage 1 extract
 * (server/scripts/phase12-completion-extract.py, run read-only on the engine
 * host), counting with the authority's own `horsePhase12CompletionCounts`, so
 * the record means exactly what admission reads.
 *
 * The policy digest is computed from the release's own sources
 * (`git show <release>:server/<path>` for every
 * HORSE_PHASE12_POLICY_SOURCE_FILES entry), never from this checkout, so the
 * record binds the code that made the decisions.
 *
 * Usage: node --import tsx src/scripts/phase12CompletionRecord.ts
 *   --variant=flo8 --release=<sha40> --from=<iso> --to=<iso>
 *   --release-unchanged=true --source=<text> < extract.ndjson > record.json
 * Refuses by name (exit 2): unknown_variant, invalid_release, invalid_window,
 * release_unchanged_not_proven, release_sources_unavailable,
 * malformed_extract_line, decision_outside_window, no_records.
 */
import { execFileSync } from 'node:child_process';
import { createInterface } from 'node:readline';
import { pathToFileURL } from 'node:url';
import {
  HORSE_PHASE12_COMPLETION_DEFINITION,
  HORSE_PHASE12_COMPLETION_SCHEMA,
  HORSE_PHASE12_COMPLETION_STREETS,
  horsePhase12CompletionCounts,
  horsePhase12CompletionLowerBound,
  horsePhase12CompletionMeetsFloor,
  type HorsePhase12CompletionRecord,
} from '../engine/HorsePhase12Authority.js';
import {
  HORSE_PHASE12_POLICY_DIGEST_DEFINITION,
  horsePhase12PolicyDigestOf,
  type HorsePhase12PolicySourceReader,
} from '../engine/HorsePhase12PolicyDigest.js';
import {
  isRemainingPolicyVariant,
  REMAINING_VARIANT_PACKS,
} from '../engine/remainingVariants/RemainingVariantPolicyPack.js';

export type Phase12CompletionRefusal =
  | 'unknown_variant'
  | 'invalid_release'
  | 'invalid_window'
  | 'release_unchanged_not_proven'
  | 'release_sources_unavailable'
  | 'malformed_extract_line'
  | 'decision_outside_window'
  | 'no_records';

export interface Phase12CompletionInput {
  variant: string | undefined;
  release: string | undefined;
  from: string | undefined;
  to: string | undefined;
  releaseUnchanged: string | undefined;
  source?: string;
  /** Stage 1 output, one JSON object per line. */
  lines: Iterable<string>;
  /** Reads `server/<path>` at `release`; defaults to `git show`. */
  readReleaseFile?: (release: string) => HorsePhase12PolicySourceReader;
}

/** `git show <release>:server/<path>` from the checkout this runs in. */
export const gitReleaseReader =
  (release: string): HorsePhase12PolicySourceReader =>
  (path) =>
    execFileSync('git', ['show', `${release}:server/${path}`], {
      maxBuffer: 64 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'ignore'],
    });

/** Build the record, or the name of the reason it cannot be built. Pure apart
 * from the release reader. */
export function phase12CompletionRecordFrom(
  input: Phase12CompletionInput
):
  | { refused: Phase12CompletionRefusal }
  | { record: HorsePhase12CompletionRecord; records: number } {
  const { variant } = input;
  if (!isRemainingPolicyVariant(variant)) return { refused: 'unknown_variant' };
  const release = input.release ?? '';
  if (!/^[0-9a-f]{40}$/.test(release)) return { refused: 'invalid_release' };
  const from = input.from ?? '';
  const to = input.to ?? '';
  const fromMs = Date.parse(from);
  const toMs = Date.parse(to);
  if (!(fromMs < toMs)) return { refused: 'invalid_window' };
  if (input.releaseUnchanged !== 'true') return { refused: 'release_unchanged_not_proven' };
  const policyDigest = horsePhase12PolicyDigestOf(
    variant,
    (input.readReleaseFile ?? gitReleaseReader)(release)
  );
  if (!policyDigest) return { refused: 'release_sources_unavailable' };

  const receipts: unknown[] = [];
  for (const line of input.lines) {
    if (!line.trim()) continue;
    let row: unknown;
    try {
      row = JSON.parse(line);
    } catch {
      return { refused: 'malformed_extract_line' };
    }
    if (
      row === null ||
      typeof row !== 'object' ||
      Array.isArray(row) ||
      !Object.hasOwn(row, 'receipt') ||
      !Number.isSafeInteger((row as { decisionTimeMs?: unknown }).decisionTimeMs)
    )
      return { refused: 'malformed_extract_line' };
    const at = (row as { decisionTimeMs: number }).decisionTimeMs;
    if (at < fromMs || at >= toMs) return { refused: 'decision_outside_window' };
    receipts.push((row as { receipt: unknown }).receipt);
  }
  if (!receipts.length) return { refused: 'no_records' };
  return {
    records: receipts.length,
    record: {
      schema: HORSE_PHASE12_COMPLETION_SCHEMA,
      definition: HORSE_PHASE12_COMPLETION_DEFINITION,
      variant,
      packVersion: REMAINING_VARIANT_PACKS[variant].version,
      releaseSha: release,
      policyDigestDefinition: HORSE_PHASE12_POLICY_DIGEST_DEFINITION,
      policyDigest,
      gameMode: 'cash',
      window: {
        from,
        to,
        releaseUnchanged: true,
        source: input.source ?? 'journal archive segments',
      },
      streets: horsePhase12CompletionCounts(variant, receipts),
    },
  };
}

async function main(): Promise<void> {
  const arg = (name: string) =>
    process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
  const lines: string[] = [];
  for await (const line of createInterface({ input: process.stdin })) lines.push(line);
  const outcome = phase12CompletionRecordFrom({
    variant: arg('variant'),
    release: arg('release'),
    from: arg('from'),
    to: arg('to'),
    releaseUnchanged: arg('release-unchanged'),
    source: arg('source'),
    lines,
  });
  if ('refused' in outcome) {
    process.stderr.write(`refused: ${outcome.refused}\n`);
    process.exit(2);
  }
  const { record } = outcome;
  process.stdout.write(`${JSON.stringify(record, null, 2)}\n`);
  process.stderr.write(
    `${JSON.stringify({
      records: outcome.records,
      lowerBounds: Object.fromEntries(
        HORSE_PHASE12_COMPLETION_STREETS.map((s) => [
          s,
          horsePhase12CompletionLowerBound(record.streets[s].completed, record.streets[s].eligible),
        ])
      ),
      meetsFloor: horsePhase12CompletionMeetsFloor(record.streets),
    })}\n`
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
