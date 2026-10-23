import { describe, it, expect } from 'vitest';
import { canRestoreFinishedTournamentReport } from '../../src/services/tournamentResult';
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
