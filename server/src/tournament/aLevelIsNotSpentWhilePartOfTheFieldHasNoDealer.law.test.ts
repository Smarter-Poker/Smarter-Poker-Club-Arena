/**
 * A LEVEL IS NOT SPENT WHILE PART OF THE FIELD HAS NO DEALER (2026-10-16)
 *
 * Coffee Break Freeroll (PLO4) 85313174: three tables (15 players) parked at
 * 17:03 and every re-admission was refused. One heads-up table dealt on until
 * 18:01, and the "any table dealt since the level began" witness let every one
 * of its hands spend a hyper-turbo level for the whole field. The parked
 * players came back at level 42 and were all-in out inside two minutes.
 *
 * These drive the real advanceBlindLevel on a manager holding only what it
 * reads before publishing: a level that comes due while one table has had no
 * dealer past the grace is held (no database request, one recheck wake), a
 * refusal younger than the grace never holds an ordinary level, and once the
 * table is admitted the owed level goes up.
 *
 * 2026-10-21, Turbo Tuesday PKO bc8e3d86: the hold had no end. One table that
 * never dealt kept about 170 players at one level for 19 hours. Past
 * FIELD_WITHOUT_DEALER_HOLD_MAX_MS (the table's critical page) the field plays
 * on, announced once per table, while another current table has a dealer.
 * The exception never releases an entirely unavailable field, even if a
 * recently closed table supplied this level's most recent completed hand.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../services/errorReporter.js', () => ({
  reportError: vi.fn(),
  describeError: (value: unknown) => String(value),
}));

import { TournamentManagerBase } from './TournamentManagerBase.js';

const EVENT = 'e5000000-0000-4000-8000-000000000001';
const PARKED = 'e5000000-0000-4000-8000-000000000002';
const STRUCTURE = [
  { level: 1, smallBlind: 25, bigBlind: 50, ante: 0, duration: 2 },
  { level: 2, smallBlind: 50, bigBlind: 100, ante: 0, duration: 2 },
];

afterEach(() => {
  vi.restoreAllMocks();
});

/** A manager whose level 1 began a level ago and whose other table dealt since. */
function manager(failingSinceMsAgo: number | null) {
  const now = Date.now();
  const m = Object.create(TournamentManagerBase.prototype) as any;
  m.tournamentId = EVENT;
  m.lifecycleEpoch = { current: () => 1 };
  m.lifecycleIsCurrent = () => true;
  m.blindTransitionInFlight = false;
  m.blindClockTerminalCommitted = false;
  m.blindClockNeedsThawResync = false;
  m.tournamentCache = { started_at: new Date(now - 10 * 60_000).toISOString() };
  m.isOnBreak = () => false;
  m.currentLevel = 1;
  m.blindTimerStartedAt = now - 2 * 60_000;
  // A hand landed on another table after the level began, so the older
  // "nothing dealt" guard passes and only the new one can hold.
  m.lastObservedHandCompletedAtMs = now - 5_000;
  m.stalledLevelHoldAnnouncedFor = new Set<number>();
  m.fieldWithoutDealerHoldAnnouncedFor = new Set<number>();
  m.fieldWithoutDealerReleaseAnnouncedFor = new Set<string>();
  m.tableEngines = new Map([
    [PARKED, {}],
    ['healthy-table', {}],
  ]);
  m.tableAdmissionFailingSince = new Map<string, number>();
  if (failingSinceMsAgo !== null) m.tableAdmissionFailingSince.set(PARKED, now - failingSinceMsAgo);
  m.askForConsolidationIfSpread = vi.fn();
  m.scheduleBlindLevelWake = vi.fn();
  m.startBlindTimer = vi.fn();
  // The first thing advanceBlindLevel reads after its holds is the multi-day
  // plan; reaching it means the level was not held. It then stops there.
  m.pendingBlindTransition = null;
  m.publicationReached = vi.fn();
  Object.defineProperty(m, 'multiDayPlan', {
    get() {
      m.publicationReached();
      throw new Error('publication reached');
    },
  });
  return m;
}

describe('a level is not spent while part of the field has no dealer', () => {
  it('holds a due level while one table has had no dealer past the grace', async () => {
    const m = manager(TournamentManagerBase.FIELD_WITHOUT_DEALER_HOLD_MS + 60_000);
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    await m.advanceBlindLevel(STRUCTURE);

    expect(m.publicationReached).not.toHaveBeenCalled();
    expect(m.currentLevel).toBe(1);
    expect(m.scheduleBlindLevelWake).toHaveBeenCalledWith(
      STRUCTURE,
      TournamentManagerBase.STALLED_LEVEL_RECHECK_MS
    );
    expect(log.mock.calls.flat().join(' ')).toContain('has had no dealer');

    // A recheck while the table is still stopped holds again, silently.
    log.mockClear();
    await m.advanceBlindLevel(STRUCTURE);
    expect(m.publicationReached).not.toHaveBeenCalled();
    expect(log).not.toHaveBeenCalled();
  });

  it('a refusal younger than the grace never holds an ordinary level', async () => {
    const m = manager(TournamentManagerBase.FIELD_WITHOUT_DEALER_HOLD_MS - 5_000);

    await m.advanceBlindLevel(STRUCTURE);

    expect(m.publicationReached).toHaveBeenCalledTimes(1);
  });

  it('the owed level goes up once the table is admitted', async () => {
    const m = manager(TournamentManagerBase.FIELD_WITHOUT_DEALER_HOLD_MS + 60_000);
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    await m.advanceBlindLevel(STRUCTURE);
    expect(m.publicationReached).not.toHaveBeenCalled();

    // Admission clears the table's recovery record.
    m.tableAdmissionFailingSince.delete(PARKED);
    await m.advanceBlindLevel(STRUCTURE);

    expect(m.publicationReached).toHaveBeenCalledTimes(1);
  });

  it('a field with every table dealing is not held', async () => {
    const m = manager(null);

    await m.advanceBlindLevel(STRUCTURE);

    expect(m.publicationReached).toHaveBeenCalledTimes(1);
  });

  it('a table stuck past the bound no longer holds the field', async () => {
    const m = manager(TournamentManagerBase.FIELD_WITHOUT_DEALER_HOLD_MAX_MS + 60_000);
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    await m.advanceBlindLevel(STRUCTURE);

    expect(m.publicationReached).toHaveBeenCalledTimes(1);
    expect(log.mock.calls.flat().join(' ')).toContain('the field no longer waits for it');

    // The release is announced once per table, not once per level.
    log.mockClear();
    m.currentLevel = 2;
    await m.advanceBlindLevel(STRUCTURE).catch(() => undefined);
    expect(m.publicationReached).toHaveBeenCalledTimes(2);
    expect(log.mock.calls.flat().join(' ')).not.toContain('the field no longer waits for it');
  });

  it.each([
    0,
    TournamentManagerBase.FIELD_WITHOUT_DEALER_HOLD_MS - 1,
    TournamentManagerBase.FIELD_WITHOUT_DEALER_HOLD_MAX_MS + 60_000,
  ])('never releases an entirely unavailable field after %ims', async (failingFor) => {
    // This is an exact 29999/30000ms boundary. Awaited owner work must not
    // move the fixture across that boundary on a loaded test worker.
    vi.spyOn(Date, 'now').mockReturnValue(1_800_000_000_000);
    const m = manager(failingFor);
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    m.tableAdmissionFailingSince.set('healthy-table', Date.now() - failingFor);
    // A hand on a now-closed table can still be the current level's witness.
    // It cannot establish that any of the remaining field can play.
    await m.advanceBlindLevel(STRUCTURE);
    expect(m.publicationReached).not.toHaveBeenCalled();
    expect(m.scheduleBlindLevelWake).toHaveBeenCalledWith(
      STRUCTURE,
      TournamentManagerBase.STALLED_LEVEL_RECHECK_MS
    );
    m.tableAdmissionFailingSince.delete('healthy-table');
    await m.advanceBlindLevel(STRUCTURE);
    expect(m.publicationReached).toHaveBeenCalledOnce();
  });

  it('a second, younger stuck table still holds while the old one is released', async () => {
    const m = manager(TournamentManagerBase.FIELD_WITHOUT_DEALER_HOLD_MAX_MS + 60_000);
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    m.tableAdmissionFailingSince.set(
      'e5000000-0000-4000-8000-000000000003',
      Date.now() - (TournamentManagerBase.FIELD_WITHOUT_DEALER_HOLD_MS + 5_000)
    );

    await m.advanceBlindLevel(STRUCTURE);

    expect(m.publicationReached).not.toHaveBeenCalled();
    expect(m.scheduleBlindLevelWake).toHaveBeenCalledWith(
      STRUCTURE,
      TournamentManagerBase.STALLED_LEVEL_RECHECK_MS
    );
  });

  it('the bound is the table admission page, and far longer than the grace', () => {
    expect(TournamentManagerBase.FIELD_WITHOUT_DEALER_HOLD_MAX_MS).toBe(
      TournamentManagerBase.TABLE_ADMISSION_PAGE_AFTER_MS
    );
    expect(TournamentManagerBase.FIELD_WITHOUT_DEALER_HOLD_MAX_MS).toBeGreaterThan(
      TournamentManagerBase.FIELD_WITHOUT_DEALER_HOLD_MS * 10
    );
  });

  it('the grace is shorter than any level a structure can run', () => {
    expect(TournamentManagerBase.FIELD_WITHOUT_DEALER_HOLD_MS).toBeGreaterThan(
      TournamentManagerBase.STALLED_LEVEL_RECHECK_MS
    );
    expect(TournamentManagerBase.FIELD_WITHOUT_DEALER_HOLD_MS).toBeLessThanOrEqual(60_000);
  });
});
