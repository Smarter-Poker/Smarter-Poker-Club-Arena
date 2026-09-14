/**
 * A TOURNAMENT YOU CANNOT ENTER SAYS SO, AND A DIAMOND DOOR IS READ AS ONE.
 *
 * Diamond Phase 8 (2026-09-14). The arena's events are listed while its
 * tournament switch is off, and every registration door answers
 * `diamond_tournaments_not_open`; the card and the row say so instead of
 * offering a Register that fails, exactly as the cash board says Not Open Yet
 * for a seat. And when the door is open, the client reads what the Diamond
 * doors return: a refusal with a reason (no Diamonds move), a registration
 * receipt that names its asset and the wallet after, and an unregistration
 * receipt in Diamonds - which the chip-shaped parser would have thrown away
 * as "invalid" after the refund had already been paid.
 */
import { describe, expect, it } from 'vitest';
import { arenaGameCardActionsForEntry } from '../../src/components/lobby/game-cards/ArenaLobbyGameCard';
import type { LobbyRowContext } from '../../src/components/lobby/lobbyCardContext';
import type { LobbyEntry } from '../../src/components/lobby/lobbyEntries';
import {
  parseTournamentUnregisterResult,
  registerReasonText,
  tournamentUnregisterSuccessText,
} from '../../src/services/TournamentService';

const mtt = {
  id: 'event-1',
  kind: 'mtt',
  name: 'Diamond Daily',
  status: 'registering',
  statusLabel: 'Registering',
  capacity: 9,
  players: 2,
} as unknown as LobbyEntry;

const base: LobbyRowContext = {
  waitlistedIds: new Set(),
  seatedIds: new Set(),
  registeredIds: new Set(),
  favoriteIds: new Set(),
  onRegister: () => undefined,
  onViewTable: () => undefined,
};

describe('A closed arena offers no registration', () => {
  it('replaces Register with the reason and keeps Details', () => {
    const actions = arenaGameCardActionsForEntry(mtt, {
      ...base,
      registrationClosedLabel: 'Not Open Yet',
    });
    expect(actions.primaryLabel).toBe('Not Open Yet');
    expect(actions.primaryDisabled).toBe(true);
    expect(actions.onPrimary, 'a disabled button must carry no handler').toBeUndefined();
    expect(actions.secondaryLabel).toBe('Details');
    expect(typeof actions.onSecondary).toBe('function');
  });

  it('leaves an open board exactly as it was', () => {
    const actions = arenaGameCardActionsForEntry(mtt, base);
    expect(actions.primaryLabel).toBe('Register');
    expect(actions.primaryDisabled).toBe(false);
    expect(typeof actions.onPrimary).toBe('function');
  });

  it('still lets a registered player return, and a finished event be watched', () => {
    const registered = arenaGameCardActionsForEntry(mtt, {
      ...base,
      registeredIds: new Set(['event-1']),
      registrationClosedLabel: 'Not Open Yet',
    });
    expect(registered.primaryLabel).toBe('Unregister');
    const finished = arenaGameCardActionsForEntry(
      { ...mtt, status: 'completed' } as unknown as LobbyEntry,
      { ...base, registrationClosedLabel: 'Not Open Yet' }
    );
    expect(finished.primaryLabel).toBe('Registration Closed');
  });

  it('is undefined for a chip club, so no chip card changes', () => {
    expect(base.registrationClosedLabel).toBeUndefined();
  });
});

describe('The Diamond doors are read as the doors they are', () => {
  it('says why a Diamond entry was refused, in words, for every reason the door returns', () => {
    expect(registerReasonText('insufficient_diamonds')).toBe(
      'Not Enough Settled Diamonds In Your Diamond Wallet.'
    );
    expect(registerReasonText('diamond_tournaments_not_open')).toBe(
      'Diamond Tournaments Are Not Open Yet.'
    );
    expect(registerReasonText('diamond_debt_requires_settlement')).toMatch(/Unsettled Balance/);
    // The chip text is untouched.
    expect(registerReasonText('insufficient_balance')).toBe('Insufficient chips in Player Wallet.');
  });

  it('reads a Diamond unregistration receipt, whole Diamonds only, and says Diamonds', () => {
    const result = parseTournamentUnregisterResult(
      {
        ok: true,
        request_id: 'req-1',
        registration_id: 'reg-1',
        asset: 'diamonds',
        refunded_diamonds: 110,
        diamonds_after: 1000,
      },
      'req-1'
    );
    expect(result).toEqual({
      refundedChips: 0,
      returnedTicketValue: 0,
      refundedDiamonds: 110,
      diamondsAfter: 1000,
    });
    expect(tournamentUnregisterSuccessText(result)).toBe(
      '110 Diamonds Were Returned To Your Diamond Wallet.'
    );
    for (const broken of [
      { refunded_diamonds: 110.5 },
      { refunded_diamonds: undefined },
      { request_id: 'someone-elses' },
      { registration_id: '' },
      { ok: false },
    ]) {
      expect(() =>
        parseTournamentUnregisterResult(
          {
            ok: true,
            request_id: 'req-1',
            registration_id: 'reg-1',
            asset: 'diamonds',
            refunded_diamonds: 110,
            ...broken,
          },
          'req-1'
        )
      ).toThrow('invalid settlement receipt');
    }
  });

  it('reads a chip receipt exactly as before - no Diamond field appears on it', () => {
    const result = parseTournamentUnregisterResult(
      {
        ok: true,
        request_id: 'req-2',
        registration_id: 'reg-2',
        refunded_chips: 200,
        returned_ticket_value: 0,
        wallet_chips_from_satellite_entitlements: 0,
      },
      'req-2'
    );
    expect(result).toEqual({ refundedChips: 200, returnedTicketValue: 0 });
    expect(tournamentUnregisterSuccessText(result)).toBe('200 Chips Were Refunded To Your Wallet.');
  });
});
