/** Owner update 2026-10-15 replaces the August 25 forced-agent rule. */
import { describe, it, expect } from 'vitest';
import {
  cashierDestinations,
  coercesToAgentWallet,
  clubBankRecipientWallets,
  clubBankDestinationFor,
} from '../src/components/wallet/cashierModes';
import { readFileSync } from 'node:fs';
const migration = readFileSync(
  'supabase/migrations/20261016021637_chip_send_honors_the_recipient_wallet_chosen_by_the_sender.sql',
  'utf8'
);
describe('The Sender Chooses The Recipient Wallet', () => {
  it.each(['owner', 'co_owner', 'super_agent', 'agent', 'sub_agent'])(
    'offers both held wallets for %s',
    (role) => {
      expect(clubBankRecipientWallets(role)).toEqual(['agent_wallet', 'player_wallet']);
      expect(clubBankDestinationFor(role, 'player_wallet')).toBe('player_wallet');
      expect(clubBankDestinationFor(role, 'agent_wallet')).toBe('agent_wallet');
      expect(coercesToAgentWallet('agent_wallet', 'send', true)).toBe(false);
    }
  );
  it('keeps ineligible wallets unavailable', () => {
    expect(clubBankRecipientWallets('admin')).toEqual(['agent_wallet']);
    expect(clubBankRecipientWallets('player')).toEqual(['player_wallet']);
    expect(cashierDestinations('club_bank')).toEqual([
      'agent_wallet',
      'promo_wallet',
      'player_wallet',
    ]);
  });
  it('patches both live routing layers with an exact preimage guard', () => {
    expect(migration).toContain('fn_agent_wallet_send_core_20260830');
    expect(migration).toContain('fn_agent_wallet_send_phase2_core_20260831');
    expect(migration).toContain('v_replay_destination := v_destination;');
    expect(migration).toContain('Unexpected function preimage');
    expect(migration).toContain('An Admin Does Not Hold A Player Wallet');
  });
});
