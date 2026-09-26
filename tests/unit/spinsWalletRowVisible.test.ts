import { describe, expect, it } from 'vitest';
import { clubWalletRows, spinsWalletRowVisible } from '../../src/components/wallet/walletRows';

/* What fn_spin_owner_state answers for a standalone club that has never
   enabled Spins (20260823160000_spin_wallet_hardening.sql, NOT FOUND branch):
   a real object, not null. */
const neverEnabled = {
  ok: true,
  owner_id: 'club-1',
  owner_kind: 'club',
  is_active: false,
  balance: 0,
  offered_max_stake: 0,
  required_seed: 0,
  seeded_amount: 0,
  seed_returned_amount: 0,
  seed_repayable_in: 0,
  collected_from_play: 0,
  total_drawn: 0,
  spin_count: 0,
  bonus_count: 0,
};

describe('the Spins Treasury row appears only when there is a Spins wallet to show', () => {
  it('hides the row while the state has not been read, or could not be', () => {
    expect(spinsWalletRowVisible(null)).toBe(false);
    expect(spinsWalletRowVisible(undefined)).toBe(false);
  });

  it('hides a zero-balance, inactive state - the club that never enabled Spins', () => {
    expect(spinsWalletRowVisible(neverEnabled)).toBe(false);
    expect(
      clubWalletRows('owner', {
        standalone: true,
        spinsActive: spinsWalletRowVisible(neverEnabled),
      })
    ).not.toContain('spins_wallet');
  });

  it('shows the row while Spins is running, even on an empty reserve', () => {
    expect(spinsWalletRowVisible({ ...neverEnabled, is_active: true })).toBe(true);
  });

  it('shows an inactive reserve that still holds chips', () => {
    expect(spinsWalletRowVisible({ ...neverEnabled, balance: 600 })).toBe(true);
    expect(
      clubWalletRows('owner', {
        standalone: true,
        spinsActive: spinsWalletRowVisible({ ...neverEnabled, balance: 600 }),
      })
    ).toContain('spins_wallet');
  });

  it('shows an inactive reserve with a seed still outstanding in it', () => {
    expect(spinsWalletRowVisible({ ...neverEnabled, seeded_amount: 2000 })).toBe(true);
  });

  it('reads numeric strings the way Postgres numerics can arrive, and ignores junk', () => {
    expect(spinsWalletRowVisible({ is_active: false, balance: '12.50', seeded_amount: 0 })).toBe(
      true
    );
    expect(spinsWalletRowVisible({ is_active: false, balance: '0', seeded_amount: '0.00' })).toBe(
      false
    );
    expect(
      spinsWalletRowVisible({ is_active: false, balance: Number.NaN, seeded_amount: -5 })
    ).toBe(false);
    expect(spinsWalletRowVisible({ is_active: null, balance: null, seeded_amount: null })).toBe(
      false
    );
  });

  it('never widens who may see the row: role and union rules still decide first', () => {
    const funded = spinsWalletRowVisible({ ...neverEnabled, is_active: true });
    expect(clubWalletRows('player', { standalone: true, spinsActive: funded })).not.toContain(
      'spins_wallet'
    );
    expect(clubWalletRows('owner', { standalone: false, spinsActive: funded })).not.toContain(
      'spins_wallet'
    );
  });
});
