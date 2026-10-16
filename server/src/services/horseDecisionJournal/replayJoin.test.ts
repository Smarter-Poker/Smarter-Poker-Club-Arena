import { describe, expect, it } from 'vitest';
import { makeHorseJournalRecord, type HorseJournalRecord } from './record.js';
import { joinHorseJournalHandReplay } from './review.js';

const HAND = 'a'.repeat(64);
const SOURCE = '0'.repeat(39) + '9';
const RUNTIME = { node: 'v22.23.2', v8: '12.4.254.21-node.56', arch: 'x64' };
let sequence = 0;
const record = (kind: HorseJournalRecord['kind'], body: unknown = { n: sequence }) =>
  makeHorseJournalRecord(
    {
      producerId: '11111111-1111-4111-8111-111111111111',
      sequence: ++sequence,
      atMs: 1_792_177_300_000 + sequence,
      sourceRelease: SOURCE,
      kind,
      handKey: HAND,
      turnKey: 'b'.repeat(64),
    },
    body
  );
const exact = (r: HorseJournalRecord, over: Record<string, unknown> = {}) => ({
  decisionId: r.eventId,
  recordSha256: r.sha256,
  recordedSource: r.sourceRelease,
  runningSource: r.sourceRelease,
  recordedRuntime: RUNTIME,
  runningRuntime: RUNTIME,
  outcome: 'replayed_exact',
  replayVerified: true,
  ...over,
});

describe('P15-A replay verification of one retained hand', () => {
  it('is true only when every decision record has its own exact replay on its own source and runtime', () => {
    const a = record('decision');
    const b = record('decision');
    const e = record('execution');
    const verified = joinHorseJournalHandReplay([a, b, e], HAND, [exact(a), exact(b)]);
    expect(verified).toMatchObject({ decisions: 2, verified: 2, replayVerified: true });
    expect(verified.unverified).toEqual({});
  });

  it('names every reason a hand stays unverified and never invents a verdict', () => {
    const a = record('decision');
    const b = record('decision');
    const c = record('decision');
    const d = record('decision');
    const f = record('decision');
    const g = record('decision');
    const result = joinHorseJournalHandReplay([a, b, c, d, f, g], HAND, [
      exact(a),
      // b: no verdict at all
      exact(c, { recordSha256: 'f'.repeat(64) }), // bound to another record: absent
      exact(d, { runningSource: '1'.repeat(40) }),
      exact(f, { runningRuntime: { ...RUNTIME, arch: 'arm64' } }),
      exact(g, {
        outcome: 'non_replayable:retained_fast_read_view',
        replayVerified: false,
      }),
    ]);
    expect(result).toMatchObject({ decisions: 6, verified: 1, replayVerified: false });
    expect(result.unverified).toEqual({
      verdict_absent: 2,
      foreign_source: 1,
      foreign_runtime: 1,
      'non_replayable:retained_fast_read_view': 1,
    });
  });

  it('refuses conflicting verdicts for one record and a hand with no decisions', () => {
    const a = record('decision');
    expect(
      joinHorseJournalHandReplay([a], HAND, [exact(a), exact(a, { outcome: 'replayed_mismatch' })])
    ).toMatchObject({ verified: 0, replayVerified: false, unverified: { verdict_conflict: 1 } });
    expect(joinHorseJournalHandReplay([record('execution')], HAND, [])).toMatchObject({
      decisions: 0,
      replayVerified: false,
    });
  });

  it('treats a forged or foreign record as invalid, not as verified', () => {
    const a = record('decision');
    const forged = { ...a, body: '{"n":-1}' } as HorseJournalRecord;
    expect(joinHorseJournalHandReplay([forged], HAND, [exact(a)])).toMatchObject({
      replayVerified: false,
      unverified: { invalid_records: 1 },
    });
    expect(joinHorseJournalHandReplay([a], 'c'.repeat(64), [exact(a)])).toMatchObject({
      replayVerified: false,
      unverified: { invalid_records: 1 },
    });
  });
});
