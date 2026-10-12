import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  classifyMissingTournamentSubject,
  ENGINE_STALL_REPORT_MS,
  scopedStalledTables,
  type LivenessRow,
} from '../e2e/support/certifiableSubject';

const CLUB = 'a41434bb-8d0c-400a-8f0d-e8b3d65afed4';
const UNION = 'fade0000-0000-0000-0000-000000000001';

function row(over: Partial<LivenessRow> = {}): LivenessRow {
  return {
    tableId: '00000000-0000-4000-8000-000000000001',
    gameFormat: 'mtt',
    clubId: UNION,
    seated: 8,
    dealable: 8,
    handCount: 42,
    msSinceProgress: 2_000,
    loopPhase: 'dealing',
    paused: false,
    ...over,
  };
}

describe('an absent subject is not a broken subject', () => {
  it('reads a stalled table inside the scope as production being broken', () => {
    const verdict = classifyMissingTournamentSubject({
      rows: [row({ msSinceProgress: 3_435_496, loopPhase: 'dealing+3269s' })],
      gameFormat: 'mtt',
      clubIds: [CLUB, UNION],
      minimumStableSeats: 3,
      maxGameplaySilenceMs: 45_000,
    });
    expect(verdict.verdict).toBe('stalled');
    expect(verdict.stalled).toHaveLength(1);
    expect(verdict.stalled[0]?.secsIdle).toBe(3435);
    expect(verdict.stalled[0]?.loopPhase).toBe('dealing+3269s');
  });

  it('reads an empty fixture scope as nothing to observe', () => {
    const verdict = classifyMissingTournamentSubject({
      rows: [],
      gameFormat: 'mtt',
      clubIds: [CLUB, UNION],
      minimumStableSeats: 3,
      maxGameplaySilenceMs: 45_000,
    });
    expect(verdict.verdict).toBe('absent');
    expect(verdict.inScope).toBe(0);
    expect(verdict.runningShape).toBe(0);
  });

  it('reads a field that is too short-handed as nothing to observe, not a stall', () => {
    const verdict = classifyMissingTournamentSubject({
      rows: [row({ seated: 2, dealable: 2, msSinceProgress: 600_000 })],
      gameFormat: 'mtt',
      clubIds: [CLUB, UNION],
      minimumStableSeats: 3,
      maxGameplaySilenceMs: 45_000,
    });
    // Below the case's own seat floor it is not a table this case can certify,
    // so its silence is not this case's evidence of a defect.
    expect(verdict.verdict).toBe('absent');
    expect(verdict.runningShape).toBe(0);
  });

  it('reads a table parked by design as nothing to observe', () => {
    const verdict = classifyMissingTournamentSubject({
      rows: [row({ paused: true, msSinceProgress: 900_000 })],
      gameFormat: 'mtt',
      clubIds: [CLUB, UNION],
      minimumStableSeats: 3,
      maxGameplaySilenceMs: 45_000,
    });
    expect(verdict.verdict).toBe('absent');
  });

  it('reads healthy tables that no clock could qualify as nothing to observe', () => {
    // Every table progressing; the case still found no candidate because its
    // own HUD-clock requirement rejected them. Run 36748751745.
    const verdict = classifyMissingTournamentSubject({
      rows: [row(), row({ tableId: '00000000-0000-4000-8000-000000000002' })],
      gameFormat: 'mtt',
      clubIds: [CLUB, UNION],
      minimumStableSeats: 3,
      maxGameplaySilenceMs: 45_000,
    });
    expect(verdict.verdict).toBe('absent');
    expect(verdict.runningShape).toBe(2);
  });

  it('ignores another format and another club', () => {
    const verdict = classifyMissingTournamentSubject({
      rows: [
        row({ gameFormat: 'spin', msSinceProgress: 900_000 }),
        row({ clubId: 'ffffffff-0000-0000-0000-000000000000', msSinceProgress: 900_000 }),
      ],
      gameFormat: 'mtt',
      clubIds: [CLUB, UNION],
      minimumStableSeats: 3,
      maxGameplaySilenceMs: 45_000,
    });
    expect(verdict.verdict).toBe('absent');
    expect(verdict.inScope).toBe(0);
  });

  it("names scoped stalls on the engine's own two minute threshold", () => {
    expect(ENGINE_STALL_REPORT_MS).toBe(120_000);
    expect(scopedStalledTables([row({ msSinceProgress: ENGINE_STALL_REPORT_MS })])).toEqual([]);
    expect(
      scopedStalledTables([row({ msSinceProgress: ENGINE_STALL_REPORT_MS + 1 })])
    ).toHaveLength(1);
  });
});

describe('the live-table certificate no longer condemns a release for the whole fleet', () => {
  const spec = readFileSync(
    resolve(process.cwd(), 'tests/e2e/production-live-table-realtime.spec.ts'),
    'utf8'
  );

  it('stopped asserting the fleet-wide aggregates', () => {
    expect(spec).not.toContain('expect(health.stalledTableCount');
    expect(spec).not.toContain('expect(health.deadStalledCount');
  });

  it('keeps the fleet verdict and the scoped stall as hard reds', () => {
    expect(spec).toContain('expect(health.wholeFleetStalled');
    expect(spec).toContain('scopedStalledTables(health.tableLiveness)');
    expect(spec).toContain('a table this case is certifying had stopped dealing');
    expect(spec).toContain("if ('tableIds' in scope)");
  });

  it('names a reader for the fleet stall it declines to charge to this release', () => {
    expect(spec).toContain('PokerTablesFrozen');
    expect(spec).toContain('infra/monitoring/engine-freeze-rules.yml');
  });

  it('has a name for an absent subject and says it out loud', () => {
    expect(spec).toContain('AbsentCertifiableSubject');
    expect(spec).toContain('recordNonVerdict');
    const nonVerdict = readFileSync(
      resolve(process.cwd(), 'tests/e2e/support/nonVerdict.ts'),
      'utf8'
    );
    expect(nonVerdict).toContain('::warning::UNKNOWN:');
    expect(nonVerdict).toContain('NON-VERDICT:');
    expect(nonVerdict).toContain("'non-verdict'");
  });
});
