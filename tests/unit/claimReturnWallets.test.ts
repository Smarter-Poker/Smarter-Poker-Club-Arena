import { describe, expect, it } from 'vitest';
import { claimReturnWallets } from '../../src/components/wallet/claimReturnWallets';
import {
  describeChipTransaction,
  walletRoute,
} from '../../src/components/wallet/describeChipTransaction';

describe('claim return wallets', () => {
  it.each(['owner', 'co_owner', 'admin'])(
    'offers %s their own eligible wallets and club wallets',
    (role) => {
      const wallets = claimReturnWallets('agent_wallet', role);
      expect(wallets).toContain('agent_wallet');
      expect(wallets).toContain('promo_wallet');
      expect(wallets).toContain('club_bank');
      expect(wallets).toContain('club_promo_wallet');
      expect(wallets.includes('player_wallet')).toBe(role !== 'admin');
    }
  );
  it.each(['agent', 'super_agent', 'sub_agent'])('keeps %s outside club wallets', (role) => {
    expect(claimReturnWallets('player_wallet', role)).toEqual([
      'agent_wallet',
      'player_wallet',
      'promo_wallet',
    ]);
    expect(claimReturnWallets('promo_wallet', role)).toEqual(['promo_wallet']);
  });
  it('never offers a cash destination for promo claims', () => {
    expect(claimReturnWallets('promo_wallet', 'owner')).toEqual([
      'promo_wallet',
      'club_promo_wallet',
    ]);
  });
  it('prints the actual return wallet and separates the original credit repayment', () => {
    const row = {
      transaction_type: 'agent_wallet_claim_back',
      from_user_id: 'p',
      to_user_id: 'a',
      amount: 20,
      metadata: {
        source: 'player_wallet',
        destination: 'promo_wallet',
        returned_amount: 16,
        credit_repaid: 4,
      },
    };
    expect(walletRoute(row)).toBe('Player Wallet To Promo Wallet');
    expect(describeChipTransaction(row, { p: 'Player', a: 'Agent' }, 'a')).toBe(
      "You Claimed Back 16 From Player's Player Wallet To Your Promo Wallet. 4 Repaid The Original Credit Draw"
    );
  });
});
