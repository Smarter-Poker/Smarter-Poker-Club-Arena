import { describe, expect, it, vi } from 'vitest';
import { waitForSharedNaturalLevel } from '../e2e/support/tournamentHudWitness';
import { classifyUnsubscribes } from '../e2e/support/initialTableOwnership';
import {
  classifyCaseFailure,
  decideReselection,
  type TournamentBoardFacts,
} from '../e2e/support/tournamentBoardEnding';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  admitMttReplacementBudget,
  MTT_MAX_CASE_MS,
  MTT_MAX_SUBJECT_MS,
  MTT_SUBJECT_STARTUP_MS,
} from '../e2e/support/mttSubjectBudget';

// Production evidence: a board closed during a 321s HUD witness. Reuse the
// actual ownership and durable ending classifiers; no browser/API writes.
describe('closed MTT board retires its HUD witness before reselection loses its runway', () => {
  it('propagates a later ownership refusal and clears the original HUD timer', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const owner = new AbortController();
    let unsubscribed = false;
    const start = 1;
    try {
      const pending = waitForSharedNaturalLevel(
        () => {
          const verdict = classifyUnsubscribes(
            unsubscribed ? [{ at: 30_000, socketId: 1 }] : [],
            [{ at: 0, socketId: 1 }],
            1,
            start
          );
          if (verdict.violations.length) throw new Error('board unsubscribed');
          return undefined;
        },
        321_066,
        owner.signal
      );
      const refused = expect(pending).rejects.toThrow('board unsubscribed');
      await vi.advanceTimersByTimeAsync(30_000);
      unsubscribed = true;
      await vi.advanceTimersByTimeAsync(50);
      await refused;
      expect(vi.getTimerCount()).toBe(0);
      expect(decideReselection({ reselectionsUsed: 0, remainingMs: 416_980 - Date.now() })).toEqual(
        { reselect: true }
      );
    } finally {
      owner.abort();
      vi.useRealTimers();
    }
  });
  it('requires the same durable complete relocation proof and refuses a running or unaccounted board', () => {
    const start: TournamentBoardFacts = {
      tableId: 'board',
      tournamentId: 'event',
      tournamentStatus: 'RUNNING',
      currentPlayers: 242,
      tableStatus: 'running',
      endedAt: null,
      bigBlind: 600,
      seatedUserIds: ['a', 'b'],
      seatStacks: [100, 200],
    };
    const end: TournamentBoardFacts = {
      ...start,
      currentPlayers: 201,
      tableStatus: 'closed',
      seatedUserIds: [],
      seatStacks: [],
      relocatedUserIds: ['a'],
      eliminatedUserIds: ['b'],
    };
    const classify = (facts: TournamentBoardFacts) =>
      classifyCaseFailure({
        engineRestartFrames: 0,
        atSelection: start,
        atFailure: facts,
        lastGameplayEventType: 'pot_distributed',
      });
    expect(classify(end).kind).toBe('natural-completion');
    expect(classify(start).kind).toBe('unproven');
    expect(classify({ ...end, eliminatedUserIds: [] }).kind).toBe('unproven');
    expect(decideReselection({ reselectionsUsed: 2, remainingMs: 400_000 }).reselect).toBe(false);
    expect(decideReselection({ reselectionsUsed: 0, remainingMs: 149_999 }).reselect).toBe(false);
  });
  it('connects the guards to the actual HUD read and shares the already admitted case deadline', () => {
    const source = readFileSync(
      resolve('tests/e2e/production-live-table-realtime.spec.ts'),
      'utf8'
    );
    const section = source.slice(
      source.indexOf('const transition = await waitForSharedNaturalLevel('),
      source.indexOf('// Actual source contract: payload.new_level')
    );
    expect(section).toContain('classifyUnsubscribes(');
    expect(section).toContain('ownership.violations');
    expect(section).toContain("type: 'ERROR'");
    expect(section.indexOf('ownership.violations')).toBeLessThan(
      section.indexOf('return sharedNaturalEngineLevel(')
    );
    expect(source).toContain('observationDeadline: caseStartedAt + testInfo.timeout');
    expect(source).toContain('remainingMs: caseStartedAt + testInfo.timeout - Date.now()');
    expect(source).toContain(
      "gameFormat === 'mtt' && error instanceof NaturalCompletionDuringObservation"
    );
    expect(source).toContain('testInfo.setTimeout(budget.startupTimeoutMs)');
    expect(source).toContain('subjectMaxTimeoutMs = budget.subjectMaxTimeoutMs');
    expect(source).toContain('clock.subjectMaxTimeoutMs,');
    expect(source).toMatch(
      /if \(!budget\)\s+throw Object\.assign\(new Error\('The finite MTT replacement budget is exhausted'\)/
    );
  });

  it('funds a complete replacement after the production closure left only 60237ms', () => {
    const elapsedMs = 430_000;
    const previousDeadlineMs = elapsedMs + 60_237;
    expect(
      decideReselection({
        reselectionsUsed: 0,
        remainingMs: previousDeadlineMs - elapsedMs,
      }).reselect
    ).toBe(false);
    const budget = admitMttReplacementBudget({
      outcome: 'natural-completion',
      reselectionsUsed: 0,
      caseElapsedMs: elapsedMs,
    });
    expect(budget).toEqual({
      startupTimeoutMs: elapsedMs + MTT_SUBJECT_STARTUP_MS,
      subjectMaxTimeoutMs: elapsedMs + MTT_MAX_SUBJECT_MS,
    });
    expect(
      decideReselection({
        reselectionsUsed: 0,
        remainingMs: budget!.startupTimeoutMs - elapsedMs,
      })
    ).toEqual({ reselect: true });
    // Only a newly read actual HUD clock can spend the larger subject cap.
    expect(budget!.startupTimeoutMs - elapsedMs).toBe(390_000);
    expect(budget!.subjectMaxTimeoutMs - elapsedMs).toBe(1_350_000);
  });

  it('keeps both replacements and their real clocks inside one fixed overall maximum', () => {
    expect(MTT_MAX_CASE_MS).toBe(4_050_000);
    const first = admitMttReplacementBudget({
      outcome: 'natural-completion',
      reselectionsUsed: 0,
      caseElapsedMs: MTT_MAX_SUBJECT_MS,
    })!;
    const second = admitMttReplacementBudget({
      outcome: 'natural-completion',
      reselectionsUsed: 1,
      caseElapsedMs: first.subjectMaxTimeoutMs,
    })!;
    expect(second.subjectMaxTimeoutMs).toBe(MTT_MAX_CASE_MS);
    expect(
      admitMttReplacementBudget({
        outcome: 'natural-completion',
        reselectionsUsed: 2,
        caseElapsedMs: second.startupTimeoutMs,
      })
    ).toBeNull();
    expect(
      admitMttReplacementBudget({
        outcome: 'natural-completion',
        reselectionsUsed: 1,
        caseElapsedMs: MTT_MAX_CASE_MS - MTT_SUBJECT_STARTUP_MS + 1,
      })
    ).toBeNull();
  });

  it.each(['unproven', 'table-engine-restarted'] as const)(
    'never admits replacement time for %s failures',
    (outcome) => {
      expect(
        admitMttReplacementBudget({
          outcome,
          reselectionsUsed: 0,
          caseElapsedMs: 430_000,
        })
      ).toBeNull();
    }
  );

  it.each([Number.NaN, Number.POSITIVE_INFINITY, -1])(
    'refuses an unreadable elapsed budget %s',
    (caseElapsedMs) => {
      expect(
        admitMttReplacementBudget({
          outcome: 'natural-completion',
          reselectionsUsed: 0,
          caseElapsedMs,
        })
      ).toBeNull();
    }
  );
});
