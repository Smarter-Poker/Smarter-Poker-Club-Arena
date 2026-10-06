import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { classifyUnsubscribes } from '../e2e/support/initialTableOwnership';
import {
  boardEnduranceBigBlinds,
  classifyBoardEnding,
  classifyCaseFailure,
  decideReselection,
  MAX_NATURAL_COMPLETION_RESELECTIONS,
  MIN_RESELECTION_BUDGET_MS,
  orderByEndurance,
  selectableWhileRunning,
  type TournamentBoardFacts,
} from '../e2e/support/tournamentBoardEnding';

const spec = readFileSync(
  join(resolve(__dirname, '../..'), 'tests/e2e/production-live-table-realtime.spec.ts'),
  'utf8'
);

const board = (over: Partial<TournamentBoardFacts> = {}): TournamentBoardFacts => ({
  tableId: 'a93b5449-c930-4e8e-9ab1-b6f4f478ba88',
  tournamentId: '88e376bf-4448-41df-b365-16e59205ed03',
  tournamentStatus: 'RUNNING',
  currentPlayers: 2,
  tableStatus: 'running',
  endedAt: null,
  bigBlind: 100,
  seatStacks: [1500, 500],
  ...over,
});

describe('a heads-up Sit & Go that finished is a result, not a transport failure', () => {
  // Rows read from production 2026-09-29: a bust leaves the tournament RUNNING
  // for 10-20 minutes with one survivor and a table that stopped dealing.
  it.each([
    ['still dealing, two players', board(), 'running'],
    [
      'the finishing hand settled (RUNNING, one survivor, table waiting) - NLH Heads-Up 100',
      board({ currentPlayers: 1, tableStatus: 'waiting', seatStacks: [2000] }),
      'natural-completion',
    ],
    [
      'stamped COMPLETED - PLO4 Heads-Up 2',
      board({ tournamentStatus: 'COMPLETED', currentPlayers: 0, tableStatus: 'closed' }),
      'natural-completion',
    ],
    ['cancelled is not a finish', board({ tournamentStatus: 'CANCELLED' }), 'not-a-completion'],
    ['one survivor but the table is still running', board({ currentPlayers: 1 }), 'running'],
    [
      'no tournament row readable',
      board({ tournamentId: null, tournamentStatus: null }),
      'unknown',
    ],
    ['unheard-of status', board({ tournamentStatus: 'PAUSED' }), 'unknown'],
    ['player count unreadable', board({ currentPlayers: null }), 'unknown'],
  ])('%s', (_name, facts, expected) => {
    expect(classifyBoardEnding(facts)).toBe(expected);
  });

  it('never selects a board that already ended or is one settled hand from ending', () => {
    expect(selectableWhileRunning(board())).toBe(true);
    expect(selectableWhileRunning(board({ currentPlayers: 1, tableStatus: 'waiting' }))).toBe(
      false
    );
    expect(selectableWhileRunning(board({ tournamentStatus: 'COMPLETED' }))).toBe(false);
    expect(selectableWhileRunning(null)).toBe(false);
    expect(selectableWhileRunning(board({ tournamentId: null, tournamentStatus: null }))).toBe(
      false
    );
  });
});

describe('the certificate prefers boards that will not finish while it watches', () => {
  it('measures the shorter stack in big blinds and never guesses an unknown depth', () => {
    expect(boardEnduranceBigBlinds(board({ seatStacks: [1500, 500], bigBlind: 100 }))).toBe(5);
    expect(boardEnduranceBigBlinds(board({ seatStacks: [1000, 1000], bigBlind: 20 }))).toBe(50);
    expect(boardEnduranceBigBlinds(board({ seatStacks: [1000] }))).toBe(0);
    expect(boardEnduranceBigBlinds(board({ bigBlind: null }))).toBe(0);
    expect(boardEnduranceBigBlinds(undefined)).toBe(0);
  });

  it('orders deepest first, keeps the caller order on a tie, and sorts unknown last', () => {
    const tables = ['a', 'b', 'c', 'd', 'e'].map((tableId) => ({ tableId }));
    const facts = new Map<string, TournamentBoardFacts>([
      ['a', board({ tableId: 'a', seatStacks: [1500, 500], bigBlind: 100 })], // 5 BB
      ['b', board({ tableId: 'b', seatStacks: [1000, 1000], bigBlind: 20 })], // 50 BB
      ['c', board({ tableId: 'c', seatStacks: [1000, 1000], bigBlind: 20 })], // 50 BB (tie with b)
      ['d', board({ tableId: 'd', seatStacks: [1900, 100], bigBlind: 100 })], // 1 BB
      // e: no facts at all
    ]);
    expect(orderByEndurance(tables, facts).map((t) => t.tableId)).toEqual([
      'b',
      'c',
      'a',
      'd',
      'e',
    ]);
  });
});

describe('a failure is reclassified only from evidence, and only three ways', () => {
  const running = board();
  const ended = board({ currentPlayers: 1, tableStatus: 'waiting' });

  it('proves a natural completion: running at selection, finished now, silence began at a hand boundary', () => {
    for (const lastGameplayEventType of ['hand_complete', 'pot_win', 'pot_distributed']) {
      const outcome = classifyCaseFailure({
        engineRestartFrames: 0,
        atSelection: running,
        atFailure: ended,
        lastGameplayEventType,
      });
      expect(outcome.kind).toBe('natural-completion');
    }
  });

  it('does not excuse silence that began mid-hand, even on a board that later finished', () => {
    for (const lastGameplayEventType of ['turn_change', 'player_action', 'hand_started']) {
      expect(
        classifyCaseFailure({
          engineRestartFrames: 0,
          atSelection: running,
          atFailure: ended,
          lastGameplayEventType,
        }).kind
      ).toBe('unproven');
    }
  });

  it('does not excuse a board that is still running, unreadable, or was never proven running', () => {
    const base = { engineRestartFrames: 0, lastGameplayEventType: 'hand_complete' };
    expect(classifyCaseFailure({ ...base, atSelection: running, atFailure: running }).kind).toBe(
      'unproven'
    );
    expect(classifyCaseFailure({ ...base, atSelection: running, atFailure: null }).kind).toBe(
      'unproven'
    );
    expect(classifyCaseFailure({ ...base, atSelection: null, atFailure: ended }).kind).toBe(
      'unproven'
    );
    expect(classifyCaseFailure({ ...base, atSelection: ended, atFailure: ended }).kind).toBe(
      'unproven'
    );
    expect(
      classifyCaseFailure({
        ...base,
        atSelection: running,
        atFailure: board({ tournamentStatus: 'CANCELLED' }),
      }).kind
    ).toBe('unproven');
  });

  it('names a table the engine rebuilt under the browser, and that outranks an ending', () => {
    // Production run 36519478277 (SNG a93b5449): the journal held an
    // engine_restarting frame at 04:13:34; the engine log for the table read
    // "watchdog_kill ... tournament_lease_lost" and hands resumed 91s later.
    for (const atFailure of [running, ended, null]) {
      expect(
        classifyCaseFailure({
          engineRestartFrames: 1,
          atSelection: running,
          atFailure,
          lastGameplayEventType: 'hand_complete',
        }).kind
      ).toBe('table-engine-restarted');
    }
  });
});

describe('normal terminal teardown is not an engine rebuild', () => {
  const start = board({ seatedUserIds: ['one', 'two'] });
  const completed = board({
    tournamentStatus: 'COMPLETED',
    tableStatus: 'closed',
    currentPlayers: 0,
    seatedUserIds: [],
    seatStacks: [],
    endedAt: '2026-10-06T00:22:52.153994Z',
  });
  const broken = board({
    seatedUserIds: [],
    tableStatus: 'closed',
    seatStacks: [],
    relocatedUserIds: ['one'],
    eliminatedUserIds: ['two'],
  });
  const input = {
    engineRestartFrames: 1,
    atSelection: start,
    terminalTeardownOnly: true,
    lastGameplayEventType: 'pot_distributed',
  };
  it('reproduces the completed SNG with its normal teardown frame', () => {
    expect(classifyCaseFailure({ ...input, atFailure: completed }).kind).toBe('natural-completion');
  });
  it('accepts an MTT closure only when every selected player is accounted for', () => {
    expect(classifyCaseFailure({ ...input, atFailure: broken }).kind).toBe('natural-completion');
  });
  it.each([
    ['missing participant', { ...broken, eliminatedUserIds: [] }],
    ['no relocation', { ...broken, relocatedUserIds: [], eliminatedUserIds: ['one', 'two'] }],
    ['wrong table', { ...completed, tableId: 'different' }],
    ['wrong tournament', { ...completed, tournamentId: 'different' }],
    ['unreadable source roster', { ...completed, seatedUserIds: undefined }],
    ['occupied row with invalid stack', { ...completed, seatedUserIds: ['one'] }],
    ['closed source still occupied', { ...completed, seatStacks: [50] }],
    ['no durable terminal timestamp', { ...completed, endedAt: null }],
    ['live table gap', board()],
    ['unreadable', null],
  ])('preserves failure: %s', (_name, atFailure) => {
    expect(classifyCaseFailure({ ...input, atFailure }).kind).toBe('table-engine-restarted');
  });
  it.each([null, 'turn_change', 'hand_started'])(
    'requires an actual boundary, not %s',
    (lastGameplayEventType) => {
      expect(
        classifyCaseFailure({ ...input, lastGameplayEventType, atFailure: completed }).kind
      ).toBe('table-engine-restarted');
    }
  );
  it('does not excuse an earlier rebuild just because the tournament later ended', () => {
    expect(
      classifyCaseFailure({ ...input, terminalTeardownOnly: false, atFailure: completed }).kind
    ).toBe('table-engine-restarted');
  });
  it('does not qualify a board never seen running', () => {
    expect(classifyCaseFailure({ ...input, atSelection: null, atFailure: completed }).kind).toBe(
      'table-engine-restarted'
    );
    expect(
      classifyCaseFailure({
        ...input,
        engineRestartFrames: 0,
        lastGameplayEventType: null,
        atFailure: completed,
      }).kind
    ).toBe('unproven');
  });
});

describe('a re-selection is bounded and lives inside the one case deadline', () => {
  it('allows a fresh board only while boards remain and a whole case still fits', () => {
    expect(MAX_NATURAL_COMPLETION_RESELECTIONS).toBe(2);
    expect(decideReselection({ reselectionsUsed: 0, remainingMs: 330_000 })).toEqual({
      reselect: true,
    });
    expect(
      decideReselection({ reselectionsUsed: 1, remainingMs: MIN_RESELECTION_BUDGET_MS })
    ).toEqual({ reselect: true });
  });

  it.each([
    [2, 330_000],
    [3, 330_000],
    [0, MIN_RESELECTION_BUDGET_MS - 1],
    [0, 0],
    [0, -5],
    [0, Number.NaN],
  ])('refuses at %i used / %ims remaining', (reselectionsUsed, remainingMs) => {
    const decision = decideReselection({ reselectionsUsed, remainingMs });
    expect(decision.reselect).toBe(false);
    expect('reason' in decision && decision.reason.length > 0).toBe(true);
  });
});

describe('the UNSUBSCRIBE assertion tolerates only the mounting handoff', () => {
  // Production run 36511851995, SNG dce2f701 (socket ids and instants are the
  // journal's own): SUBSCRIBE 1790648804709, SUBSCRIBE 805578, then UNSUBSCRIBE
  // and SUBSCRIBE in the same millisecond, 1790648806188. The observed hand
  // cycle began at about 1790648806896 and the table dealt on for an hour.
  const subscribes = [
    { at: 1790648804709, socketId: 1 },
    { at: 1790648805578, socketId: 1 },
    { at: 1790648806188, socketId: 1 },
  ];
  const observationStartedAt = 1790648806896;

  it('accepts the recorded same-tick handoff as evidence, not as a violation', () => {
    const verdict = classifyUnsubscribes(
      [{ at: 1790648806188, socketId: 1 }],
      subscribes,
      1,
      observationStartedAt
    );
    expect(verdict.violations).toEqual([]);
    expect(verdict.handoffs).toEqual([
      { unsubscribeAt: 1790648806188, subscribeAt: 1790648806188, socketId: 1 },
    ]);
  });

  it('accepts no UNSUBSCRIBE at all', () => {
    expect(classifyUnsubscribes([], subscribes, 1, observationStartedAt)).toEqual({
      handoffs: [],
      violations: [],
    });
  });

  it.each([
    [
      'any UNSUBSCRIBE at or after the observed hand cycle begins',
      [{ at: observationStartedAt, socketId: 1 }],
      [...subscribes, { at: observationStartedAt, socketId: 1 }],
      'during the observed hand cycle',
    ],
    [
      'an UNSUBSCRIBE after the reconnect, on the recovered transport',
      [{ at: 1790648860000, socketId: 2 }],
      [...subscribes, { at: 1790648860000, socketId: 2 }],
      'crossed physical transports',
    ],
    [
      'leaving the table without re-acquiring it',
      [{ at: 1790648806188, socketId: 1 }],
      subscribes.slice(0, 2),
      'left the table without re-acquiring it',
    ],
    [
      'an UNSUBSCRIBE whose SUBSCRIBE comes too late to be one handoff',
      [{ at: 1790648806188, socketId: 1 }],
      [...subscribes.slice(0, 2), { at: 1790648806188 + 251, socketId: 1 }],
      'left the table without re-acquiring it',
    ],
    [
      'a SUBSCRIBE that happened BEFORE the UNSUBSCRIBE',
      [{ at: 1790648806188, socketId: 1 }],
      [{ at: 1790648806187, socketId: 1 }],
      'left the table without re-acquiring it',
    ],
    ['an invalid timestamp', [{ at: Number.NaN, socketId: 1 }], subscribes, 'invalid timestamp'],
  ])('refuses %s', (_name, unsubscribes, subs, why) => {
    const verdict = classifyUnsubscribes(unsubscribes, subs, 1, observationStartedAt);
    expect(verdict.violations.map((violation) => violation.why)).toContain(why);
  });

  it('refuses a table that keeps handing itself over while mounting', () => {
    const unsubscribes = [1, 2, 3].map((n) => ({ at: 1790648805000 + n * 1000, socketId: 1 }));
    const subs = unsubscribes.map((unsubscribe) => ({ ...unsubscribe }));
    const verdict = classifyUnsubscribes(unsubscribes, subs, 1, 1790648810000);
    expect(verdict.handoffs).toHaveLength(2);
    expect(verdict.violations).toHaveLength(1);
    expect(verdict.violations[0]!.why).toContain('more than 2 handoffs');
  });

  it('will not let one SUBSCRIBE excuse two UNSUBSCRIBEs', () => {
    const verdict = classifyUnsubscribes(
      [
        { at: 1790648806188, socketId: 1 },
        { at: 1790648806190, socketId: 1 },
      ],
      [{ at: 1790648806191, socketId: 1 }],
      1,
      observationStartedAt
    );
    expect(verdict.handoffs).toHaveLength(1);
    expect(verdict.violations.map((violation) => violation.why)).toEqual([
      'left the table without re-acquiring it',
    ]);
  });

  it('requires an exact observation and transport', () => {
    expect(() => classifyUnsubscribes([], [], 1, Number.NaN)).toThrow('exact observation');
    expect(() => classifyUnsubscribes([], [], 1.5, 1)).toThrow('exact observation');
  });
});

describe('the certificate spec wires these classifiers without a retry-to-green', () => {
  const tournament = spec.slice(
    spec.indexOf('async function certifyReadOnlyTournamentFormat('),
    spec.indexOf("test.describe('production mobile WebKit live-table realtime continuity'")
  );

  it('no longer asserts a bare zero UNSUBSCRIBE frames since navigation', () => {
    expect(tournament).toContain('classifyUnsubscribes(');
    expect(tournament).not.toMatch(
      /type: 'UNSUBSCRIBE',\s*since: navigationStartedAt,\s*\}\),\s*`\$\{candidate\.name\} was unsubscribed while under observation`\s*\)\.toHaveLength\(0\)/
    );
    expect(tournament).toContain('was unsubscribed while under observation');
    expect(tournament).toContain('preOutageTransports[0]!,\n      progressStartedAt');
  });

  it('reads durable board facts for every tournament format and accounts for closed boards', () => {
    expect(tournament).toContain('const boardReader = await createHudClockReader();');
    expect(tournament).toContain('boardReader.accountClosedBoard(selected.boardFacts, atFailure)');
  });

  it('re-selects only on a proven natural completion, inside the one case deadline', () => {
    expect(tournament).toContain(
      'if (!(error instanceof NaturalCompletionDuringObservation)) throw error;'
    );
    expect(tournament).toContain('remainingMs: observationDeadline - Date.now()');
    expect(tournament).toContain('deadline: observationDeadline');
    // Unproven failures are rethrown as they were, after their evidence is attached.
    expect(tournament).toContain('throw original;');
    expect(tournament).toContain('-failure-classification');
    // A restarted table is a named engine defect, never a re-selection.
    expect(tournament).toContain('TABLE ENGINE RESTARTED DURING OBSERVATION');
    // No loop that retries the same board or swallows the last error.
    expect(tournament.match(/NaturalCompletionDuringObservation\(/g)).toHaveLength(1);
    expect(tournament).not.toMatch(/retries?\s*[:=]/i);
  });

  it('never re-selects a board it already watched, and never spends past the deadline', () => {
    expect(tournament).toContain('excludeTableIds: watched');
    expect(tournament).toContain('watched.push(candidate.id)');
    expect(spec).toContain('timeout: pollBudgetMs()');
  });
});
