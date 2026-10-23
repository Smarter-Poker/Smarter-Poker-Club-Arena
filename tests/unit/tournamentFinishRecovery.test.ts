import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import { canRestoreFinishedTournamentReport } from '../../src/services/tournamentResult';
it('initial completion recovery marks the report as result-only at its producer', () => {
  const page = readFileSync('src/pages/TablePage.tsx', 'utf8');
  const exit = page.slice(
    page.indexOf('const goToLobbyWithResult ='),
    page.indexOf('let durableCompletionLookupInFlight')
  );
  expect(exit).toMatch(
    /resultOnly:\s*loadedFinishedReportReady\s*\|\|\s*loadedTournamentStatus === 'COMPLETED'/
  );
});

describe('initial load restores a finished participant without ending a rebuy decision', () => {
  it.each(['mtt', 'spin', 'sng'])(
    'restores a sealed %s entrant while the event is still running',
    () => {
      expect(
        canRestoreFinishedTournamentReport({
          entryStatus: 'eliminated',
          tournamentStatus: 'RUNNING',
          prizePoolFinalized: true,
          isRebuy: true,
          isReentry: true,
        })
      ).toBe(true);
    }
  );
  it('restores a freezeout bust even before late registration closes', () => {
    expect(
      canRestoreFinishedTournamentReport({
        entryStatus: 'eliminated',
        tournamentStatus: 'RUNNING',
        prizePoolFinalized: false,
        isRebuy: false,
        isReentry: false,
      })
    ).toBe(true);
  });
  it.each(['playing', 'registered'])('does not report a %s entrant as finished', (entryStatus) => {
    expect(
      canRestoreFinishedTournamentReport({
        entryStatus,
        tournamentStatus: 'RUNNING',
        prizePoolFinalized: true,
      })
    ).toBe(false);
  });
  it('waits for committed tournament completion before recovering a winner', () => {
    expect(
      canRestoreFinishedTournamentReport({
        entryStatus: 'winner',
        tournamentStatus: 'RUNNING',
        prizePoolFinalized: true,
        isRebuy: false,
        isReentry: false,
      })
    ).toBe(false);
    expect(
      canRestoreFinishedTournamentReport({
        entryStatus: 'winner',
        tournamentStatus: 'COMPLETED',
        prizePoolFinalized: true,
      })
    ).toBe(true);
  });
  it('preserves an open rebuy or re-entry decision and refuses unknown finality', () => {
    for (const fields of [
      { isRebuy: true, isReentry: false },
      { isRebuy: false, isReentry: true },
      {},
    ])
      expect(
        canRestoreFinishedTournamentReport({
          entryStatus: 'eliminated',
          tournamentStatus: 'RUNNING',
          prizePoolFinalized: false,
          ...fields,
        })
      ).toBe(false);
  });
});
