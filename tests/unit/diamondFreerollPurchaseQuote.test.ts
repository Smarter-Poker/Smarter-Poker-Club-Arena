import { describe, expect, it } from 'vitest';
import { tournamentService } from '../../src/services/TournamentService';

const diamond = { asset: 'diamonds', is_platform: true, union_id: null };

describe('Diamond freeroll recovery purchase quotes', () => {
  it.each([diamond, [diamond]])('puts the full 100-Diamond rebuy into the prize pool', (arena) => {
    expect(
      tournamentService.quoteFromTournament(
        {
          arena,
          buy_in_amount: 0,
          buy_in_fee: 0,
          rebuy_cost: 100,
          rebuy_chips: 5_000,
          starting_chips: 10_000,
        },
        'rebuy'
      )
    ).toEqual({ baseCost: 100, fee: 0, totalCost: 100, chips: 5_000 });
  });

  it('preserves the paid Diamond entry fee ratio', () => {
    expect(
      tournamentService.quoteFromTournament(
        {
          arena: diamond,
          buy_in_amount: 90,
          buy_in_fee: 10,
          rebuy_cost: 100,
        },
        'rebuy'
      )
    ).toMatchObject({ baseCost: 90, fee: 10, totalCost: 100 });
  });

  it('keeps a paid Diamond purchase on the whole-Diamond grid', () => {
    expect(
      tournamentService.quoteFromTournament(
        {
          arena: diamond,
          buy_in_amount: 9,
          buy_in_fee: 1,
          rebuy_cost: 5,
        },
        'rebuy'
      )
    ).toMatchObject({ baseCost: 5, fee: 0, totalCost: 5 });
  });

  it('preserves the chip fee rule on zero-entry events', () => {
    expect(
      tournamentService.quoteFromTournament(
        {
          arena: null,
          buy_in_amount: 0,
          buy_in_fee: 0,
          rebuy_cost: 100,
        },
        'rebuy'
      )
    ).toMatchObject({ baseCost: 90, fee: 10, totalCost: 100 });
  });
});
