/**
 * P13.3 completion reader on real joint receipts: stage 1 (the host
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
import {
  admitHorsePhase13QualifiedAuthority,
  HORSE_PHASE13_COMPLETION_STREET_KEYS,
  HORSE_PHASE13_VARIANTS,
  horsePhase13CompletionBoardCounts,
  horsePhase13CompletionCounts,
  horsePhase13CompletionOutcome,
  horsePhase13CompletionRecordMeetsFloor,
} from '../engine/HorsePhase13Authority.js';
import {
  horsePhase13PolicyDigest,
  horsePhase13PolicyDigestOf,
  runningPhase13PolicySourceReader,
} from '../engine/HorsePhase13PolicyDigest.js';
import {
  P13_TEST_CONTRACT_DIGEST,
  P13_TEST_NOW,
  p13CompletionPath,
  p13QualificationBytes,
  p13Reader,
  p13Selection,
} from '../engine/HorsePhase13Authority.test-support.js';
import { evaluateJointLivePolicy } from '../engine/multiway/JointLivePolicy.js';
import { jointPolicyFixture } from '../engine/multiway/JointRangeFixture.test-support.js';
import type { JointVariant } from '../engine/multiway/JointInputBinding.js';
import { phase13CompletionRecordFrom } from './phase13CompletionRecord.js';

const serverRoot = fileURLToPath(new URL('../../', import.meta.url));
const RELEASE = 'a'.repeat(40);
const FROM = '2026-10-12T00:00:00.000Z';
const TO = '2026-10-19T00:00:00.000Z';
const AT = Date.parse('2026-10-15T00:00:00.000Z');
const running = () => runningPhase13PolicySourceReader;

/** A real journaled-shape joint receipt (JSON round trip) at one spot and clock. */
function receipt(
  variant: JointVariant,
  street: 'preflop' | 'flop' | 'turn' | 'river',
  clock: () => number,
  boards = 1,
  mode: 'cash' | 'tournament' = 'cash'
) {
  const s = jointPolicyFixture(variant, boards, mode, street);
  const r = evaluateJointLivePolicy(s.hero, s.state, s.baseline, 'shadow', clock);
  return JSON.parse(JSON.stringify(r.receipt)) as Record<string, unknown>;
}
const line = (r: unknown, at = AT, eventId = 'e') =>
  JSON.stringify({ eventId, decisionTimeMs: at, gameMode: 'cash', receipt: r });

/** Every street complete `n` times on one board, `n` two-board bomb
 * decisions on the flop and `n` three-board bomb decisions on the turn, plus
 * one work-budget fallback on the river (last). */
function window(variant: JointVariant, n: number) {
  const lines: string[] = [];
  const receipts: unknown[] = [];
  const spots = [
    ['preflop', 1],
    ['flop', 1],
    ['turn', 1],
    ['river', 1],
    ['flop', 2],
    ['turn', 3],
  ] as const;
  for (const [street, boards] of spots) {
    const ok = receipt(variant, street, () => 0, boards);
    for (let i = 0; i < n; i++) {
      lines.push(line(ok, AT + i, `${street}-${boards}-${i}`));
      receipts.push(ok);
    }
  }
  let t = 0;
  const slow = receipt(variant, 'river', () => (t += 5));
  lines.push(line(slow, AT, 'slow'));
  receipts.push(slow);
  return { lines, receipts };
}

describe('P13.3 completion reader, stage 2: the record admission reads', () => {
  it.each(HORSE_PHASE13_VARIANTS)(
    'writes the %s record from real receipts with the authority counts and the release digest',
    (variant) => {
      const { lines, receipts } = window(variant, 130);
      const out = phase13CompletionRecordFrom({
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
      expect(out.records).toBe(6 * 130 + 1);
      expect(out.record.streets).toEqual(horsePhase13CompletionCounts(variant, receipts));
      expect(out.record.boardCounts).toEqual(horsePhase13CompletionBoardCounts(variant, receipts));
      expect(out.record.streets.flop).toMatchObject({ eligible: 260, completed: 260 });
      expect(out.record.streets.turn).toMatchObject({ eligible: 260, completed: 260 });
      expect(out.record.boardCounts['1']).toMatchObject({
        eligible: 521,
        completed: 520,
        workBudget: 1,
      });
      expect(out.record.boardCounts['2']).toMatchObject({ eligible: 130, completed: 130 });
      expect(out.record.boardCounts['3']).toMatchObject({ eligible: 130, completed: 130 });
      expect(out.record.streets.river).toEqual({
        eligible: 131,
        completed: 130,
        workBudget: 1,
        samplerBudgetExhausted: 0,
        sampleUnavailable: 0,
        governorReduced: 0,
        responseBranchUnavailable: 0,
        analysisUnavailable: 0,
      });
      expect(out.record.excluded).toEqual({ diamond: 0 });
      expect(out.record.policyDigest).toBe(horsePhase13PolicyDigest(variant));
      // 130 complete of 131 on the river (lower bound 0.940) is below the
      // floor; without the fallback the record clears it.
      const admitRecord = (record: unknown) => {
        const c = Buffer.from(JSON.stringify(record, null, 2) + '\n');
        const q = p13QualificationBytes(variant);
        return admitHorsePhase13QualifiedAuthority(
          variant,
          p13Selection(variant, q, c),
          p13Reader(variant, q, c),
          P13_TEST_NOW,
          P13_TEST_CONTRACT_DIGEST
        );
      };
      expect(admitRecord(out.record)).toMatchObject({ reason: 'completion_below_floor' });
      const clean = phase13CompletionRecordFrom({
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
        p13CompletionPath(variant)
      );
    }
  );

  it('binds the digest of the release sources, not of this checkout', () => {
    const { lines } = window('plo4', 1);
    const edited = (file: string) =>
      file === 'src/engine/multiway/JointResponseTree.ts'
        ? Buffer.concat([runningPhase13PolicySourceReader(file), Buffer.from('\n')])
        : runningPhase13PolicySourceReader(file);
    const out = phase13CompletionRecordFrom({
      variant: 'plo4',
      release: RELEASE,
      from: FROM,
      to: TO,
      releaseUnchanged: 'true',
      lines,
      readReleaseFile: () => edited,
    });
    if ('refused' in out) throw new Error(out.refused);
    expect(out.record.policyDigest).toBe(horsePhase13PolicyDigestOf('plo4', edited));
    expect(out.record.policyDigest).not.toBe(horsePhase13PolicyDigest('plo4'));
  });

  it.each([
    ['unknown_variant', { variant: 'stud' }],
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
  ] as const)('refuses by name: %s', (reason, overrides) => {
    expect(
      phase13CompletionRecordFrom({
        variant: 'nlh',
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

  // Audit 2026-10-06: an empty window used to be refused (`no_records`, exit
  // 2), so a variant with no natural decisions had no record at all. It now
  // has a record that says so: zero eligible in every cell, which fails the
  // floor by name at admission.
  it.each([
    ['an empty extract', [] as string[]],
    ['an extract of blank lines', ['', '  ']],
    ['an extract of decisions without a joint receipt', [line(null), line(null, AT + 1, 'f')]],
  ])('writes a zero record for %s, which fails the floor', (_name, lines) => {
    const out = phase13CompletionRecordFrom({
      variant: 'nlh',
      release: RELEASE,
      from: FROM,
      to: TO,
      releaseUnchanged: 'true',
      lines,
      readReleaseFile: running,
    });
    if ('refused' in out) throw new Error(out.refused);
    expect(out.records).toBe(lines.filter((l) => l.trim()).length);
    const zero = Object.fromEntries(HORSE_PHASE13_COMPLETION_STREET_KEYS.map((k) => [k, 0]));
    for (const cell of [
      ...Object.values(out.record.streets),
      ...Object.values(out.record.boardCounts),
    ])
      expect(cell).toEqual(zero);
    expect(out.record.excluded).toEqual({ diamond: 0 });
    expect(out.record.policyDigest).toBe(horsePhase13PolicyDigest('nlh'));
    expect(horsePhase13CompletionRecordMeetsFloor(out.record)).toBe(false);
    const c = Buffer.from(JSON.stringify(out.record, null, 2) + '\n');
    const q = p13QualificationBytes('nlh');
    expect(
      admitHorsePhase13QualifiedAuthority(
        'nlh',
        p13Selection('nlh', q, c),
        p13Reader('nlh', q, c),
        P13_TEST_NOW,
        P13_TEST_CONTRACT_DIGEST
      )
    ).toMatchObject({ status: 'refused', reason: 'completion_below_floor' });
  });

  it('counts Diamond decisions as excluded by name and analysis failures apart from completed', () => {
    const ok = receipt('nlh', 'river', () => 0);
    const failed = { ...ok, reason: 'joint_scores_no_winner', fired: false };
    const s = jointPolicyFixture('nlh', 2, 'cash', 'turn');
    Object.assign(s.state, { asset: 'diamonds', chipUnit: 1 });
    s.state.rakeConfig!.percent = 0;
    s.state.rakeConfig!.cap = 0;
    const diamond = JSON.parse(
      JSON.stringify(
        evaluateJointLivePolicy(s.hero, s.state, s.baseline, 'shadow', () => 0).receipt
      )
    );
    const out = phase13CompletionRecordFrom({
      variant: 'nlh',
      release: RELEASE,
      from: FROM,
      to: TO,
      releaseUnchanged: 'true',
      lines: [line(ok, AT, 'a'), line(failed, AT + 1, 'b'), line(diamond, AT + 2, 'c')],
      readReleaseFile: running,
    });
    if ('refused' in out) throw new Error(out.refused);
    expect(out.records).toBe(3);
    expect(out.record.definition).toBe('horse-phase13-completion-definition-v2');
    expect(out.record.excluded).toEqual({ diamond: 1 });
    expect(out.record.streets.river).toMatchObject({
      eligible: 2,
      completed: 1,
      analysisUnavailable: 1,
      responseBranchUnavailable: 0,
    });
    expect(out.record.streets.turn.eligible).toBe(0);
    expect(out.record.boardCounts['2'].eligible).toBe(0);
  });

  it('the command reads the release sources with git show and prints the record', () => {
    const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: serverRoot, encoding: 'utf8' })
      .trim()
      .toLowerCase();
    const { lines } = window('flo8', 1);
    const run = spawnSync(
      process.execPath,
      [
        '--import',
        'tsx',
        'src/scripts/phase13CompletionRecord.ts',
        '--variant=flo8',
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
      horsePhase13PolicyDigestOf('flo8', (file) =>
        execFileSync('git', ['show', `${head}:server/${file}`], { cwd: serverRoot })
      )
    );
    expect(JSON.parse(run.stderr.trim().split('\n').at(-1)!)).toMatchObject({ records: 7 });
    const refused = spawnSync(
      process.execPath,
      ['--import', 'tsx', 'src/scripts/phase13CompletionRecord.ts', '--variant=stud'],
      { cwd: serverRoot, input: '', encoding: 'utf8' }
    );
    expect(refused.status).toBe(2);
    expect(refused.stderr).toContain('refused: unknown_variant');
    // An empty window is a record (zero eligible everywhere), not a refusal.
    const empty = spawnSync(
      process.execPath,
      [
        '--import',
        'tsx',
        'src/scripts/phase13CompletionRecord.ts',
        '--variant=flo8',
        `--release=${head}`,
        `--from=${FROM}`,
        `--to=${TO}`,
        '--release-unchanged=true',
        '--source=test',
      ],
      { cwd: serverRoot, input: '', encoding: 'utf8' }
    );
    expect(empty.status, empty.stderr).toBe(0);
    expect(JSON.parse(empty.stdout).streets.river.eligible).toBe(0);
    expect(JSON.parse(empty.stderr.trim().split('\n').at(-1)!)).toMatchObject({
      records: 0,
      meetsFloor: false,
    });
  }, 90_000);
});

describe('P13.3 completion reader, stage 1: the host extractor', () => {
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
      snapshot:
        kind === 'discard_decision'
          ? {
              type: 'DECIDE_DISCARD',
              gameVariant: variant,
              cards: [],
              communityCards: [],
              journalContext: { requestedAtMs: at },
            }
          : {
              type: overrides.type ?? 'DECIDE_FAST',
              decisionTimeMs: at,
              gameState: {
                gameVariant: variant,
                gameMode: 'cash',
                dealtSeatIds: [1, 2, 3, 4],
                ...gameState,
              },
            },
      decision,
      governorScale: 0.75,
    }),
    ...Object.fromEntries(Object.entries(overrides).filter(([k]) => k !== 'type')),
  });

  it('prints each window decision of one variant and release, multi-board and bomb hands included, and names every exclusion', () => {
    const a = mkdtempSync(path.join(tmpdir(), 'p133-seg-a-'));
    const b = mkdtempSync(path.join(tmpdir(), 'p133-seg-b-'));
    dirs.push(a, b);
    const ok = receipt('pineapple', 'river', () => 0);
    const bomb = receipt('pineapple', 'flop', () => 0, 2);
    segment(a, [
      record('decision', 'pineapple', AT, { action: 'check', jointPolicy: ok }),
      record('decision', 'pineapple', AT + 1, { action: 'fold' }),
      record('discard_decision', 'pineapple', AT + 2, { discard: 'private' }),
      record('decision', 'pineapple', AT + 3, {}, { sourceRelease: 'f'.repeat(40) }),
      record(
        'decision',
        'pineapple',
        AT + 4,
        { action: 'check', jointPolicy: bomb },
        {},
        { boardCount: 2, bombPot: true }
      ),
      // A DEEP second look of the first turn: the same turn, not a new decision.
      record('decision', 'pineapple', AT + 8, { action: 'check' }, { type: 'DECIDE_DEEP' }),
      record('decision', 'flh', AT + 5, {}),
      record('decision', 'pineapple', Date.parse(TO), {}),
      record('execution', 'pineapple', AT + 6, {}),
    ]);
    segment(b, [record('decision', 'pineapple', AT + 7, {})], 'f'.repeat(64));
    const run = spawnSync(
      'python3',
      ['scripts/phase13-completion-extract.py', FROM, TO, RELEASE, 'pineapple'],
      {
        cwd: serverRoot,
        encoding: 'utf8',
        env: { ...process.env, PHASE13_EXTRACT_SEGMENT_DIRS: `${a}:${b}` },
      }
    );
    expect(run.status, run.stderr).toBe(0);
    const rows = run.stdout
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(rows.map((r) => r.eventId)).toEqual([
      `decision-pineapple-${AT}`,
      `decision-pineapple-${AT + 1}`,
      `decision-pineapple-${AT + 4}`,
    ]);
    expect(rows[0]).toEqual({
      eventId: `decision-pineapple-${AT}`,
      decisionTimeMs: AT,
      gameMode: 'cash',
      variant: 'pineapple',
      boardCount: 1,
      bombPot: false,
      dealtPlayers: 4,
      governorScale: 0.75,
      receipt: ok,
    });
    expect(rows[1].receipt).toBeNull();
    expect(rows[2]).toMatchObject({ boardCount: 2, bombPot: true, receipt: bomb });
    expect(JSON.parse(run.stderr)).toEqual({
      bomb_records: 1,
      excluded_deep_second_look: 1,
      excluded_discard_decision: 1,
      excluded_release_other: 1,
      multiboard_records: 1,
      records: 3,
      records_without_joint_receipt: 1,
      segment_digest_mismatch: 1,
      segments_read: 1,
    });
    // Stage 2 over the extract: the discard never reaches the counts, the
    // decision without a receipt is not counted, and the bomb flop is.
    const out = phase13CompletionRecordFrom({
      variant: 'pineapple',
      release: RELEASE,
      from: FROM,
      to: TO,
      releaseUnchanged: 'true',
      lines: run.stdout.trim().split('\n'),
      readReleaseFile: running,
    });
    if ('refused' in out) throw new Error(out.refused);
    expect(horsePhase13CompletionOutcome('pineapple', ok)).toBe('completed');
    expect(out.record.streets.river).toMatchObject({ eligible: 1, completed: 1 });
    expect(out.record.streets.flop).toMatchObject({ eligible: 1, completed: 1 });
    expect(out.record.streets.preflop.eligible).toBe(0);
  });

  // Audit 2026-10-06: the window bounds were parsed by dropping the fraction
  // and refusing any offset, so stage 1 and stage 2 (Date.parse) could read
  // different windows from the same arguments.
  it('reads the window bounds exactly as Date.parse does (Z, +00:00, fractional seconds)', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'p133-seg-iso-'));
    dirs.push(dir);
    const from = '2026-10-15T00:00:00.500+00:00';
    const to = '2026-10-15T00:00:01.2509Z';
    expect(Date.parse(from)).toBe(AT + 500);
    expect(Date.parse(to)).toBe(AT + 1250);
    const times = [AT, AT + 499, AT + 500, AT + 1249, AT + 1250, AT + 1251];
    segment(
      dir,
      times.map((t) => record('decision', 'nlh', t, {}))
    );
    const run = spawnSync(
      'python3',
      ['scripts/phase13-completion-extract.py', from, to, RELEASE, 'nlh'],
      {
        cwd: serverRoot,
        encoding: 'utf8',
        env: { ...process.env, PHASE13_EXTRACT_SEGMENT_DIRS: dir },
      }
    );
    expect(run.status, run.stderr).toBe(0);
    const printed = run.stdout
      .trim()
      .split('\n')
      .map((l) => (JSON.parse(l) as { decisionTimeMs: number }).decisionTimeMs);
    const fromMs = Date.parse(from);
    const toMs = Date.parse(to);
    expect(printed).toEqual(times.filter((t) => t >= fromMs && t < toMs));
    expect(printed).toEqual([AT + 500, AT + 1249]);
    // Stage 2 reads the same window from the same arguments: no row is outside it.
    const out = phase13CompletionRecordFrom({
      variant: 'nlh',
      release: RELEASE,
      from,
      to,
      releaseUnchanged: 'true',
      lines: run.stdout.trim().split('\n'),
      readReleaseFile: running,
    });
    expect('refused' in out ? out.refused : null).toBeNull();
    // Other offsets convert to UTC as Date.parse does; a bound without an
    // offset (local time to Date.parse) or not ISO-8601 is refused.
    for (const [bound, expected] of [
      ['2026-10-15T01:00:00.750+01:00', AT + 750],
      ['2026-10-14T19:00:00.75-05:00', AT + 750],
      ['2026-10-15T00:00Z', AT],
    ] as const) {
      expect(Date.parse(bound)).toBe(expected);
      const r = spawnSync(
        'python3',
        ['scripts/phase13-completion-extract.py', bound, to, RELEASE, 'nlh'],
        {
          cwd: serverRoot,
          encoding: 'utf8',
          env: { ...process.env, PHASE13_EXTRACT_SEGMENT_DIRS: dir },
        }
      );
      expect(r.status, `${bound} ${r.stderr}`).toBe(0);
      expect(
        r.stdout
          .trim()
          .split('\n')
          .filter(Boolean)
          .map((l) => (JSON.parse(l) as { decisionTimeMs: number }).decisionTimeMs)
      ).toEqual(times.filter((t) => t >= expected && t < toMs));
    }
    for (const bound of ['2026-10-15T00:00:00', '2026-10-15', 'yesterday']) {
      const r = spawnSync(
        'python3',
        ['scripts/phase13-completion-extract.py', bound, to, RELEASE, 'nlh'],
        {
          cwd: serverRoot,
          encoding: 'utf8',
          env: { ...process.env, PHASE13_EXTRACT_SEGMENT_DIRS: dir },
        }
      );
      expect(r.status, bound).not.toBe(0);
      expect(r.stdout, bound).toBe('');
    }
  });

  it('prints Diamond NLH decisions for stage 2 to exclude by name, and names them in its summary', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'p133-seg-diamond-'));
    dirs.push(dir);
    const ok = receipt('nlh', 'river', () => 0);
    const s = jointPolicyFixture('nlh', 2, 'cash', 'turn');
    Object.assign(s.state, { asset: 'diamonds', chipUnit: 1 });
    s.state.rakeConfig!.percent = 0;
    s.state.rakeConfig!.cap = 0;
    const diamond = JSON.parse(
      JSON.stringify(
        evaluateJointLivePolicy(s.hero, s.state, s.baseline, 'shadow', () => 0).receipt
      )
    );
    segment(dir, [
      record('decision', 'nlh', AT, { action: 'check', jointPolicy: ok }),
      record(
        'decision',
        'nlh',
        AT + 1,
        { action: 'check', jointPolicy: diamond },
        {},
        { asset: 'diamonds', boardCount: 2, bombPot: true }
      ),
    ]);
    const run = spawnSync(
      'python3',
      ['scripts/phase13-completion-extract.py', FROM, TO, RELEASE, 'nlh'],
      {
        cwd: serverRoot,
        encoding: 'utf8',
        env: { ...process.env, PHASE13_EXTRACT_SEGMENT_DIRS: dir },
      }
    );
    expect(run.status, run.stderr).toBe(0);
    expect(run.stdout.trim().split('\n')).toHaveLength(2);
    expect(JSON.parse(run.stderr)).toMatchObject({ records: 2, diamond_records: 1 });
    const out = phase13CompletionRecordFrom({
      variant: 'nlh',
      release: RELEASE,
      from: FROM,
      to: TO,
      releaseUnchanged: 'true',
      lines: run.stdout.trim().split('\n'),
      readReleaseFile: running,
    });
    if ('refused' in out) throw new Error(out.refused);
    expect(out.record.excluded).toEqual({ diamond: 1 });
    expect(out.record.streets.river).toMatchObject({ eligible: 1, completed: 1 });
    expect(out.record.streets.turn.eligible).toBe(0);
  });

  it('refuses an unknown variant', () => {
    const run = spawnSync(
      'python3',
      ['scripts/phase13-completion-extract.py', FROM, TO, RELEASE, 'stud'],
      {
        cwd: serverRoot,
        encoding: 'utf8',
        env: { ...process.env, PHASE13_EXTRACT_SEGMENT_DIRS: tmpdir() },
      }
    );
    expect(run.status).not.toBe(0);
    expect(run.stdout).toBe('');
  });
});
