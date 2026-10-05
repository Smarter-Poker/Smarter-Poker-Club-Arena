/**
 * P12.3 completion reader on real policy receipts: stage 1 (the host
 * extractor, run here over temporary archive segments) and stage 2 (the
 * record writer, which counts with the authority's own function and binds the
 * release's policy digest from that release's sources). The record it writes
 * is the record admission reads.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { afterAll, describe, expect, it } from 'vitest';
import { remainingVariantSpot } from '../benchmark/RemainingVariantPolicyEvidence.js';
import {
  admitHorsePhase12QualifiedAuthority,
  horsePhase12CompletionCounts,
  horsePhase12CompletionOutcome,
} from '../engine/HorsePhase12Authority.js';
import {
  horsePhase12PolicyDigest,
  horsePhase12PolicyDigestOf,
  runningPhase12PolicySourceReader,
} from '../engine/HorsePhase12PolicyDigest.js';
import {
  P12_TEST_CONTRACT_DIGEST,
  P12_TEST_NOW,
  p12CompletionPath,
  p12QualificationBytes,
  p12Reader,
  p12Selection,
} from '../engine/HorsePhase12Authority.test-support.js';
import { evaluateRemainingVariantPolicy } from '../engine/remainingVariants/RemainingVariantLivePolicy.js';
import type { RemainingPolicyVariant } from '../engine/remainingVariants/RemainingVariantPolicyPack.js';
import { phase12CompletionRecordFrom } from './phase12CompletionRecord.js';

const serverRoot = fileURLToPath(new URL('../../', import.meta.url));
const RELEASE = 'a'.repeat(40);
const FROM = '2026-10-12T00:00:00.000Z';
const TO = '2026-10-19T00:00:00.000Z';
const AT = Date.parse('2026-10-15T00:00:00.000Z');
const running = () => runningPhase12PolicySourceReader;

/** A real journaled-shape receipt (JSON round trip) at one spot and clock. */
function receipt(
  variant: RemainingPolicyVariant,
  street: 'preflop' | 'flop' | 'turn' | 'river',
  clock: () => number,
  mode: 'cash' | 'tournament' = 'cash'
) {
  const s = remainingVariantSpot(variant, street, 2, mode);
  const r = evaluateRemainingVariantPolicy(s.hero, s.state, s.baseline, null, 'shadow', clock);
  return JSON.parse(JSON.stringify(r.receipt)) as Record<string, unknown>;
}
const line = (r: unknown, at = AT, eventId = 'e') =>
  JSON.stringify({ eventId, decisionTimeMs: at, gameMode: 'cash', receipt: r });

/** Every street complete `n` times, plus one work-budget fallback on the river. */
function window(variant: RemainingPolicyVariant, n: number) {
  const lines: string[] = [];
  const receipts: unknown[] = [];
  for (const street of ['preflop', 'flop', 'turn', 'river'] as const) {
    const ok = receipt(variant, street, () => 0);
    for (let i = 0; i < n; i++) {
      lines.push(line(ok, AT + i, `${street}-${i}`));
      receipts.push(ok);
    }
  }
  let t = 0;
  const slow = receipt(variant, 'river', () => (t += 5));
  lines.push(line(slow, AT, 'slow'));
  receipts.push(slow);
  return { lines, receipts };
}

describe('P12.3 completion reader, stage 2: the record admission reads', () => {
  it.each(['short_deck', 'pineapple', 'flh', 'flo8'] as const)(
    'writes the %s record from real receipts with the authority counts and the release digest',
    (variant) => {
      const { lines, receipts } = window(variant, 130);
      const out = phase12CompletionRecordFrom({
        variant,
        release: RELEASE,
        from: FROM,
        to: TO,
        releaseUnchanged: 'true',
        source: 'test',
        lines,
        readReleaseFile: running,
      });
      if ('refused' in out) throw new Error(out.refused);
      expect(out.records).toBe(4 * 130 + 1);
      expect(out.record.streets).toEqual(horsePhase12CompletionCounts(variant, receipts));
      expect(out.record.streets.river).toEqual({
        eligible: 131,
        completed: 130,
        workBudget: 1,
        samplerBudgetExhausted: 0,
        sampleUnavailable: 0,
        governorReduced: 0,
      });
      expect(out.record.policyDigest).toBe(horsePhase12PolicyDigest(variant));
      // The record is exactly what admission reads: 130 complete of 131 on the
      // river (lower bound 0.940) is below the floor; without the fallback the
      // 130 all-complete decisions clear it.
      const admitRecord = (record: unknown) => {
        const c = Buffer.from(JSON.stringify(record, null, 2) + '\n');
        const q = p12QualificationBytes(variant);
        return admitHorsePhase12QualifiedAuthority(
          variant,
          p12Selection(variant, q, c),
          p12Reader(variant, q, c),
          P12_TEST_NOW,
          P12_TEST_CONTRACT_DIGEST
        );
      };
      expect(admitRecord(out.record)).toMatchObject({ reason: 'completion_below_floor' });
      const clean = phase12CompletionRecordFrom({
        variant,
        release: RELEASE,
        from: FROM,
        to: TO,
        releaseUnchanged: 'true',
        source: 'test',
        lines: lines.slice(0, -1),
        readReleaseFile: running,
      });
      if ('refused' in clean) throw new Error(clean.refused);
      const admitted = admitRecord(clean.record);
      expect(admitted.status).toBe('admitted');
      expect(admitted.status === 'admitted' && admitted.authority.completionPath).toBe(
        p12CompletionPath(variant)
      );
    }
  );

  it('binds the digest of the release sources, not of this checkout', () => {
    const { lines } = window('flh', 1);
    const edited = (file: string) =>
      file === 'src/engine/remainingVariants/RemainingVariantLivePolicy.ts'
        ? Buffer.concat([runningPhase12PolicySourceReader(file), Buffer.from('\n')])
        : runningPhase12PolicySourceReader(file);
    const out = phase12CompletionRecordFrom({
      variant: 'flh',
      release: RELEASE,
      from: FROM,
      to: TO,
      releaseUnchanged: 'true',
      lines,
      readReleaseFile: () => edited,
    });
    if ('refused' in out) throw new Error(out.refused);
    expect(out.record.policyDigest).toBe(horsePhase12PolicyDigestOf('flh', edited));
    expect(out.record.policyDigest).not.toBe(horsePhase12PolicyDigest('flh'));
  });

  it.each([
    ['unknown_variant', { variant: 'plo8' }],
    ['invalid_release', { release: 'main' }],
    ['invalid_window', { from: TO, to: FROM }],
    ['release_unchanged_not_proven', { releaseUnchanged: 'false' }],
    [
      'release_sources_unavailable',
      {
        readReleaseFile: () => () => {
          throw new Error('fatal: path does not exist');
        },
      },
    ],
    ['malformed_extract_line', { lines: ['{not json'] }],
    ['malformed_extract_line', { lines: [JSON.stringify({ decisionTimeMs: AT })] }],
    ['decision_outside_window', { lines: [line(null, Date.parse(TO))] }],
    ['no_records', { lines: ['', '  '] }],
  ] as const)('refuses by name: %s', (reason, overrides) => {
    expect(
      phase12CompletionRecordFrom({
        variant: 'flo8',
        release: RELEASE,
        from: FROM,
        to: TO,
        releaseUnchanged: 'true',
        lines: [line(null)],
        readReleaseFile: running,
        ...(overrides as object),
      })
    ).toEqual({ refused: reason });
  });

  it('the command reads the release sources with git show and prints the record', () => {
    const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: serverRoot, encoding: 'utf8' })
      .trim()
      .toLowerCase();
    const { lines } = window('short_deck', 1);
    const run = spawnSync(
      process.execPath,
      [
        '--import',
        'tsx',
        'src/scripts/phase12CompletionRecord.ts',
        '--variant=short_deck',
        `--release=${head}`,
        `--from=${FROM}`,
        `--to=${TO}`,
        '--release-unchanged=true',
        '--source=test',
      ],
      { cwd: serverRoot, input: lines.join('\n') + '\n', encoding: 'utf8' }
    );
    expect(run.status, run.stderr).toBe(0);
    const record = JSON.parse(run.stdout) as { policyDigest: string; releaseSha: string };
    expect(record.releaseSha).toBe(head);
    expect(record.policyDigest).toBe(
      horsePhase12PolicyDigestOf('short_deck', (file) =>
        execFileSync('git', ['show', `${head}:server/${file}`], { cwd: serverRoot })
      )
    );
    expect(JSON.parse(run.stderr.trim().split('\n').at(-1)!)).toMatchObject({ records: 5 });
    const refused = spawnSync(
      process.execPath,
      ['--import', 'tsx', 'src/scripts/phase12CompletionRecord.ts', '--variant=plo8'],
      { cwd: serverRoot, input: '', encoding: 'utf8' }
    );
    expect(refused.status).toBe(2);
    expect(refused.stderr).toContain('refused: unknown_variant');
  }, 60_000);
});

describe('P12.3 completion reader, stage 1: the host extractor', () => {
  const dirs: string[] = [];
  afterAll(() => {
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  });
  /** A closed archive segment named by its own sha256, as the host writes it. */
  function segment(dir: string, records: unknown[], nameOverride?: string) {
    const raw = Buffer.from(records.map((r) => JSON.stringify(r)).join('\n') + '\n');
    const name = nameOverride ?? createHash('sha256').update(raw).digest('hex');
    const file = path.join(dir, `${name}.ndjson.gz`);
    writeFileSync(file, gzipSync(raw));
    // Closed inside the window (the extractor skips segments closed before it).
    utimesSync(file, AT / 1000, AT / 1000);
  }
  const record = (
    kind: string,
    variant: string,
    at: number,
    decision: unknown,
    overrides: Record<string, unknown> = {},
    gameState: Record<string, unknown> = {}
  ) => ({
    kind,
    eventId: `${kind}-${variant}-${at}`,
    sourceRelease: RELEASE,
    body: JSON.stringify({
      snapshot: {
        decisionTimeMs: at,
        gameState: { gameVariant: variant, gameMode: 'cash', ...gameState },
      },
      decision,
    }),
    ...overrides,
  });

  it('prints each window decision of one pack and release with its journaled receipt, and names every exclusion', () => {
    const a = mkdtempSync(path.join(tmpdir(), 'p123-seg-a-'));
    const b = mkdtempSync(path.join(tmpdir(), 'p123-seg-b-'));
    dirs.push(a, b);
    const ok = receipt('pineapple', 'river', () => 0);
    segment(a, [
      record('decision', 'pineapple', AT, { action: 'call', remainingVariantPolicy: ok }),
      record('decision', 'pineapple', AT + 1, { action: 'fold' }),
      record('discard_decision', 'pineapple', AT + 2, { discard: 'private' }),
      record('decision', 'pineapple', AT + 3, {}, { sourceRelease: 'f'.repeat(40) }),
      record('decision', 'pineapple', AT + 4, {}, {}, { boardCount: 2 }),
      record('decision', 'flh', AT + 5, {}),
      record('decision', 'pineapple', Date.parse(TO), {}),
      record('execution', 'pineapple', AT + 6, {}),
    ]);
    segment(b, [record('decision', 'pineapple', AT + 7, {})], 'f'.repeat(64));
    const run = spawnSync(
      'python3',
      ['scripts/phase12-completion-extract.py', FROM, TO, RELEASE, 'pineapple'],
      {
        cwd: serverRoot,
        encoding: 'utf8',
        env: { ...process.env, PHASE12_EXTRACT_SEGMENT_DIRS: `${a}:${b}` },
      }
    );
    expect(run.status, run.stderr).toBe(0);
    const rows = run.stdout
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as { eventId: string; receipt: unknown; gameMode: string });
    expect(rows.map((r) => r.eventId)).toEqual([
      `decision-pineapple-${AT}`,
      `decision-pineapple-${AT + 1}`,
    ]);
    expect(rows[0]).toMatchObject({ gameMode: 'cash', receipt: ok });
    expect(rows[1].receipt).toBeNull();
    expect(JSON.parse(run.stderr)).toEqual({
      excluded_discard_decision: 1,
      excluded_multiboard: 1,
      excluded_release_other: 1,
      records: 2,
      segment_digest_mismatch: 1,
      segments_read: 1,
    });
    // Stage 2 over the extract: the discard never reaches the counts and the
    // decision without a receipt is not counted.
    const out = phase12CompletionRecordFrom({
      variant: 'pineapple',
      release: RELEASE,
      from: FROM,
      to: TO,
      releaseUnchanged: 'true',
      lines: run.stdout.trim().split('\n'),
      readReleaseFile: running,
    });
    if ('refused' in out) throw new Error(out.refused);
    expect(horsePhase12CompletionOutcome('pineapple', ok)).toBe('completed');
    expect(out.record.streets.river).toMatchObject({ eligible: 1, completed: 1 });
    expect(out.record.streets.flop.eligible).toBe(0);
  });

  it('refuses an unknown pack', () => {
    const run = spawnSync(
      'python3',
      ['scripts/phase12-completion-extract.py', FROM, TO, RELEASE, 'plo8'],
      {
        cwd: serverRoot,
        encoding: 'utf8',
        env: { ...process.env, PHASE12_EXTRACT_SEGMENT_DIRS: tmpdir() },
      }
    );
    expect(run.status).not.toBe(0);
    expect(run.stdout).toBe('');
  });
});
