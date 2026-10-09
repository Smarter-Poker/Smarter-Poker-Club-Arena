/**
 * P13.3 completion reader, stage 2: writes one joint variant's natural
 * `horse-phase13-completion-v1` record from the stage 1 extract
 * (server/scripts/phase13-completion-extract.py, run read-only on the engine
 * host), counting with the authority's own `horsePhase13CompletionCounts` and
 * `horsePhase13CompletionBoardCounts` (per street and per board count), so
 * the record means exactly what admission reads. The extract carries
 * single-board, multi-board and bomb hands alike; the counting decides which
 * receipts count (a bomb hand has no eligible preflop decision), which are
 * excluded by name (`excluded.diamond`, from `horsePhase13CompletionExclusions`)
 * and under which named field each counted one falls (`analysisUnavailable`
 * included).
 *
 * An empty window is a record, not a refusal (audit 2026-10-06): a variant
 * with no natural decisions gets zero eligible in every cell, which fails the
 * floor, so admission refuses it by name (`completion_below_floor`) rather
 * than finding no record at all.
 *
 * The policy digest is computed from the release's own sources
 * (`git show <release>:server/<path>` for every
 * HORSE_PHASE13_POLICY_SOURCE_FILES entry), never from this checkout, so the
 * record binds the code that made the decisions.
 *
 * Usage: node --import tsx src/scripts/phase13CompletionRecord.ts
 *   --variant=plo4 --release=<sha40> --from=<iso> --to=<iso>
 *   --release-unchanged=true --source=<text> < extract.ndjson > record.json
 * Refuses by name (exit 2): unknown_variant, invalid_release, invalid_window,
 * release_unchanged_not_proven, release_sources_unavailable,
 * malformed_extract_line, decision_outside_window.
 */
import { execFileSync } from 'node:child_process';
import { createInterface } from 'node:readline';
import { pathToFileURL } from 'node:url';
import {
  HORSE_PHASE13_COMPLETION_BOARD_COUNTS,
  HORSE_PHASE13_COMPLETION_DEFINITION,
  HORSE_PHASE13_COMPLETION_SCHEMA,
  HORSE_PHASE13_COMPLETION_STREETS,
  HORSE_PHASE13_PACK_VERSION,
  horsePhase13CompletionBoardCounts,
  horsePhase13CompletionCounts,
  horsePhase13CompletionExclusions,
  horsePhase13CompletionLowerBound,
  horsePhase13CompletionRecordMeetsFloor,
  type HorsePhase13CompletionRecord,
} from '../engine/HorsePhase13Authority.js';
import {
  HORSE_PHASE13_POLICY_DIGEST_DEFINITION,
  horsePhase13PolicyDigestOf,
  type HorsePhase13PolicySourceReader,
} from '../engine/HorsePhase13PolicyDigest.js';
import { isJointVariant } from '../engine/multiway/JointInputBinding.js';

export type Phase13CompletionRefusal =
  | 'unknown_variant'
  | 'invalid_release'
  | 'invalid_window'
  | 'release_unchanged_not_proven'
  | 'release_sources_unavailable'
  | 'malformed_extract_line'
  | 'decision_outside_window';

export interface Phase13CompletionInput {
  variant: string | undefined;
  release: string | undefined;
  from: string | undefined;
  to: string | undefined;
  releaseUnchanged: string | undefined;
  source?: string;
  /** Stage 1 output, one JSON object per line. */
  lines: Iterable<string>;
  /** Reads `server/<path>` at `release`; defaults to `git show`. */
  readReleaseFile?: (release: string) => HorsePhase13PolicySourceReader;
}

/** `git show <release>:server/<path>` from the checkout this runs in. */
export const gitReleaseReader =
  (release: string): HorsePhase13PolicySourceReader =>
  (path) =>
    execFileSync('git', ['show', `${release}:server/${path}`], {
      maxBuffer: 64 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'ignore'],
    });

/** Build the record, or the name of the reason it cannot be built. Pure apart
 * from the release reader. */
export function phase13CompletionRecordFrom(
  input: Phase13CompletionInput
):
  | { refused: Phase13CompletionRefusal }
  | { record: HorsePhase13CompletionRecord; records: number } {
  const { variant } = input;
  if (!isJointVariant(variant)) return { refused: 'unknown_variant' };
  const release = input.release ?? '';
  if (!/^[0-9a-f]{40}$/.test(release)) return { refused: 'invalid_release' };
  const from = input.from ?? '';
  const to = input.to ?? '';
  const fromMs = Date.parse(from);
  const toMs = Date.parse(to);
  // Admission reads the window with isoMs, which accepts only the canonical
  // toISOString form (milliseconds included); any other spelling of the same
  // instant would be refused completion_window_invalid there (2026-10-09).
  const canonical = (iso: string, ms: number) =>
    Number.isFinite(ms) && new Date(ms).toISOString() === iso;
  if (!(canonical(from, fromMs) && canonical(to, toMs) && fromMs < toMs))
    return { refused: 'invalid_window' };
  if (input.releaseUnchanged !== 'true') return { refused: 'release_unchanged_not_proven' };
  const policyDigest = horsePhase13PolicyDigestOf(
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
  return {
    records: receipts.length,
    record: {
      schema: HORSE_PHASE13_COMPLETION_SCHEMA,
      definition: HORSE_PHASE13_COMPLETION_DEFINITION,
      variant,
      packVersion: HORSE_PHASE13_PACK_VERSION,
      releaseSha: release,
      policyDigestDefinition: HORSE_PHASE13_POLICY_DIGEST_DEFINITION,
      policyDigest,
      gameMode: 'cash',
      window: {
        from,
        to,
        releaseUnchanged: true,
        source: input.source ?? 'journal archive segments',
      },
      streets: horsePhase13CompletionCounts(variant, receipts),
      boardCounts: horsePhase13CompletionBoardCounts(variant, receipts),
      excluded: horsePhase13CompletionExclusions(variant, receipts),
    },
  };
}

async function main(): Promise<void> {
  const arg = (name: string) =>
    process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
  const lines: string[] = [];
  for await (const line of createInterface({ input: process.stdin })) lines.push(line);
  const outcome = phase13CompletionRecordFrom({
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
      excluded: record.excluded,
      lowerBounds: Object.fromEntries(
        HORSE_PHASE13_COMPLETION_STREETS.map((s) => [
          s,
          horsePhase13CompletionLowerBound(record.streets[s].completed, record.streets[s].eligible),
        ])
      ),
      boardCountLowerBounds: Object.fromEntries(
        HORSE_PHASE13_COMPLETION_BOARD_COUNTS.map((b) => [
          b,
          horsePhase13CompletionLowerBound(
            record.boardCounts[b].completed,
            record.boardCounts[b].eligible
          ),
        ])
      ),
      meetsFloor: horsePhase13CompletionRecordMeetsFloor(record),
    })}\n`
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
