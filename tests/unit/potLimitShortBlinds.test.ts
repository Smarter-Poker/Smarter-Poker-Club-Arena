import { expect, it } from 'vitest';
import { computeRaisePresets, potSizedRaiseTo } from '@/components/table/ActionPanel';
import { mapEngineSnapshot } from '@/utils/mapEngineSnapshot';

it('keeps the legal POT preset when the real preflop pot has a short blind', () => {
  const state = mapEngineSnapshot(
    {
      table_id: 'short-blind',
      hand_number: 1,
      stage: 'preflop',
      pot: 1.5,
      pot_limit_pot: 3,
      betting_structure: 'pot_limit',
      current_bet: 2,
      min_raise: 2,
      last_raise: 2,
      dealer_seat: 1,
      current_player: 'p4',
      players: [],
      pots: [],
      action_history: [],
      community_cards: [],
    },
    'p4',
    4
  );
  const maxRaise = potSizedRaiseTo(state.currentBet, state.potLimitPot ?? state.pot, 2);
  const preset = computeRaisePresets({
    isPreflop: true,
    bigBlind: 2,
    currentBet: 2,
    callAmount: 2,
    pot: state.pot,
    minRaise: 4,
    maxRaise,
    isPotLimit: true,
    smallestChip: 0.01,
  }).find((p) => p.label === 'POT');
  expect(maxRaise).toBe(7);
  expect(preset?.value).toBe(7);
  expect(state.pot).toBe(1.5);
});
