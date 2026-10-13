import { expect, it, vi } from 'vitest';
vi.mock('../../src/lib/supabase', () => ({ supabase: {} }));
import {
  diamondMiniPlateAmount,
  type DiamondJackpotSnapshot,
} from '../../src/lib/diamondJackpotFeed';
const snapshot: DiamondJackpotSnapshot = {
  version: 1,
  pool_id: 'pool',
  enabled: true,
  mini_enabled: true,
  main_balance: 1000,
  backup_balance: 6500,
  reserve_floor: 5000,
  hits: [],
  stakes: [
    {
      big_blind: 20,
      drop: 1,
      min_pot: 200,
      payout_percent: 70,
      loser_percent: 50,
      winner_percent: 25,
      table_percent: 25,
      mini_amount: 1500,
      mini_payable: true,
    },
  ],
};
it('shows exactly the whole amount that keeps the reserve floor, at this exact published stake', () => {
  expect(diamondMiniPlateAmount(snapshot, 20)).toBe(1500);
  expect(diamondMiniPlateAmount(snapshot, 25)).toBeNull();
  expect(diamondMiniPlateAmount({ ...snapshot, backup_balance: 6499 }, 20)).toBeNull();
  expect(diamondMiniPlateAmount(null, 20)).toBeNull();
});
it.each([
  'main_off',
  'mini_off',
  'paused',
  'no_drop',
  'zero_amount',
  'fractional_amount',
  'unknown_reserve',
])('never promises an unpayable Mini: %s', (fault) => {
  const s = { ...snapshot, stakes: snapshot.stakes.map((stake) => ({ ...stake })) };
  if (fault === 'main_off') s.enabled = false;
  if (fault === 'mini_off') s.mini_enabled = false;
  if (fault === 'paused') s.stakes[0].mini_payable = false;
  if (fault === 'no_drop') s.stakes[0].drop = 0;
  if (fault === 'zero_amount') s.stakes[0].mini_amount = 0;
  if (fault === 'fractional_amount') s.stakes[0].mini_amount = 1500.5;
  if (fault === 'unknown_reserve') s.backup_balance = NaN;
  expect(diamondMiniPlateAmount(s, 20)).toBeNull();
});
