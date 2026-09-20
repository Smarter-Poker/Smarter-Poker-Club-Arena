import { afterEach, expect, it, vi } from 'vitest';
import { HorseLogic } from './HorseLogic.js';
import * as evaluation from './HorseEval.js';
import { plo4Cards, plo4ReferenceSpot } from '../benchmark/Plo4PolicyEvidence.js';

afterEach(() => vi.restoreAllMocks());

it.each([
  ['nlh', 9, '9s 8s'],
  ['plo4', 8, '9s 8s Kc Qd'],
  ['plo5', 6, '9s 8s Kc Qd 4h'],
  ['plo6', 6, '9s 8s Kc Qd 4h 6d'],
  ['plo8', 6, '9s 8s Kc Qd'],
] as const)(
  'prices every contender in a supported %s cash population',
  (variant, seats, holding) => {
    const input = plo4ReferenceSpot('non_nut_flush');
    input.hero.cards = plo4Cards(holding);
    const state = input.state;
    state.gameVariant = variant;
    state.bettingStructure = variant === 'nlh' ? 'no_limit' : 'pot_limit';
    for (let seat = 3; seat <= seats; seat++) {
      state.players.push({ ...state.players[1], user_id: 'opponent-' + seat, seat });
    }
    // A committed away all-in still owns showdown rights.
    const away = state.players[seats - 1];
    away.is_all_in = true;
    away.is_sitting_out = true;
    away.stack = 0;
    state.dealtSeatIds = state.players.map((p) => p.seat);
    state.pot = state.players.reduce((sum, p) => sum + p.totalInvested, 0);
    state.contestablePot = state.pot;
    const simulate = vi.spyOn(evaluation, 'simulateEquity').mockReturnValue(0.35);
    HorseLogic.decide(
      input.hero,
      state,
      'balanced',
      {},
      {
        mind: false,
        telemetry: false,
        phase10Plo4: 'off',
        phase11Omaha: 'off',
        phase12Remaining: 'off',
        phase13Joint: 'off',
      }
    );
    expect(simulate).toHaveBeenCalled();
    expect(simulate.mock.calls[0][2]).toBe(seats - 1);
  }
);
