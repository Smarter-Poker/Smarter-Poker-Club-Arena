import { describe, expect, it } from 'vitest';
import { parseSpinSettlementReceipt } from './spinSettlementReceipt.js';

const id = (tail: string) => `00000000-0000-4000-8000-${tail.padStart(12, '0')}`;
const tournamentId = id('1');

const receipt = () => ({
  ok: true,
  money_path: 'fn_spin_draw_and_settle',
  tournament_id: tournamentId,
  seats: 3,
  paid_users: 3,
  multiplier: 10,
  prize_pool: 10,
  pool_covered: 10,
  draw_amount: 10,
  tournament_prize_pool: 10,
  tournament_multiplier: 10,
  reserve_in: 2.76,
  entry_amount: 2.76,
  house_rake: 0.24,
  operator_shortfall: 0,
  escrow_reserve_out: 2.76,
  escrow_reserve_in: 10,
  escrow_prize_balance: 10,
  reserve_balance: 500,
  owner_id: id('2'),
  pool_id: id('3'),
  entry_reserve_id: id('4'),
  entry_journal_id: id('5'),
  draw_reserve_id: id('6'),
  draw_journal_id: id('7'),
  locked: [{ multiplier: 100, reason: 'threshold', unlocksAt: 20000 }],
});

const expected = { tournamentId, buyIn: 1, seats: 3, rakeRate: 0.08 };

describe('an atomic Spin receipt is a complete money proof', () => {
  it('accepts one exact three-seat draw/settlement receipt', () => {
    expect(parseSpinSettlementReceipt(receipt(), expected)).toMatchObject({
      multiplier: 10,
      prizePool: 10,
      reserveIn: 2.76,
    });
  });

  it.each([
    ['paid_users', 2],
    ['pool_covered', 9.99],
    ['draw_amount', 10.01],
    ['operator_shortfall', 0.01],
    ['escrow_reserve_in', 9.99],
    ['escrow_prize_balance', 0],
    ['tournament_prize_pool', 3],
    ['draw_journal_id', null],
  ])('refuses a receipt whose %s is not exact', (field, wrong) => {
    expect(() => parseSpinSettlementReceipt({ ...receipt(), [field]: wrong }, expected)).toThrow();
  });

  it('refuses a receipt for a different event', () => {
    expect(() =>
      parseSpinSettlementReceipt({ ...receipt(), tournament_id: id('99') }, expected)
    ).toThrow(/different tournament/);
  });
});
