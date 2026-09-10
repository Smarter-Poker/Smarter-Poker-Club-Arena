/**
 * Dan 2026-09-02: "IN THE TRANSACTION LEDGER, IT NEEDS TO SPECIFY WHICH WALLET
 * A USER IS TRANSFERRING TO REGARDLESS OF ROLE - 'KINGFISH TRANSFERRED XXX
 * FROM HIS AGENT WALLET TO PLAYER WALLET'."
 *
 * Every wallet-moving transaction type the cashier writes gets one sentence
 * that names the actor, the amount, the wallet the chips left and the wallet
 * they entered. Anything that is not a wallet move is left alone.
 *
 * The amount reads to the cent (2026-09-10, audit CL-10): 1,250.50 is
 * "1,250.50", never "1,250.5" with the cent column dropped, through the one
 * money formatter (tests/money-is-displayed-one-way.law.test.ts).
 */
import { describe, it, expect } from 'vitest';
import {
  describeChipTransaction,
  walletRoute,
  WALLET_MOVE_TYPES,
} from '../../src/components/wallet/describeChipTransaction';

const KING = 'aaaaaaaa-0000-4000-8000-000000000001';
const BOB = 'bbbbbbbb-0000-4000-8000-000000000002';
const names = new Map([
  [KING, 'KINGFISH'],
  [BOB, 'Bob'],
]);

describe('a ledger line names both wallets', () => {
  it('an agent staking their own seat: from their agent wallet to their player wallet', () => {
    const line = describeChipTransaction(
      {
        transaction_type: 'agent_wallet_self_stake',
        amount: 500,
        from_user_id: KING,
        to_user_id: KING,
        metadata: { destination: 'player_wallet' },
      },
      names
    );
    expect(line).toBe(
      "KINGFISH Transferred 500.00 From KINGFISH's Agent Wallet To KINGFISH's Player Wallet"
    );
  });

  it('an agent send names the recipient and the destination wallet', () => {
    const line = describeChipTransaction(
      {
        transaction_type: 'agent_wallet_send',
        amount: 1250.5,
        from_user_id: KING,
        to_user_id: BOB,
        metadata: { destination: 'player_wallet' },
      },
      names
    );
    expect(line).toBe("KINGFISH Sent 1,250.50 From KINGFISH's Agent Wallet To Bob's Player Wallet");
  });

  it('a club bank send says it came from the club bank, whatever the role', () => {
    expect(
      describeChipTransaction(
        {
          transaction_type: 'club_bank_send',
          amount: 100,
          from_user_id: KING,
          to_user_id: BOB,
          metadata: { destination: 'agent_wallet', actor_role: 'owner' },
        },
        names
      )
    ).toBe("KINGFISH Sent 100.00 From The Club Bank To Bob's Agent Wallet");
  });

  it('an owner funding their own player wallet from the club bank', () => {
    expect(
      describeChipTransaction(
        {
          transaction_type: 'club_bank_send',
          amount: 2000,
          from_user_id: KING,
          to_user_id: KING,
          metadata: { destination: 'player_wallet', actor_role: 'owner' },
        },
        names,
        KING
      )
    ).toBe('You Transferred 2,000.00 From The Club Bank To Your Player Wallet');
  });

  it('a claim back travels the other way and says so', () => {
    expect(
      describeChipTransaction(
        {
          transaction_type: 'club_bank_reversal',
          amount: 1,
          from_user_id: KING,
          to_user_id: BOB,
          metadata: { destination: 'agent_wallet' },
        },
        names
      )
    ).toBe("KINGFISH Claimed Back 1.00 From Bob's Agent Wallet To The Club Bank");
  });

  it('never invents a route for a row that is not a wallet move', () => {
    expect(
      describeChipTransaction(
        { transaction_type: 'tournament_buyin', amount: 10, notes: 'x' },
        names
      )
    ).toBeNull();
    expect(walletRoute({ transaction_type: 'rake' })).toBeNull();
  });

  it('a name that did not load is never a uuid on screen', () => {
    const line = describeChipTransaction(
      { transaction_type: 'agent_wallet_send', amount: 5, from_user_id: KING, to_user_id: BOB },
      new Map()
    );
    expect(line).not.toContain(KING);
    expect(line).not.toContain(BOB);
    expect(line).toContain('A Member');
  });

  it('the compact route matches the sentence', () => {
    expect(
      walletRoute({
        transaction_type: 'agent_wallet_send',
        metadata: { destination: 'agent_wallet' },
      })
    ).toBe('Agent Wallet To Agent Wallet');
    expect(
      walletRoute({
        transaction_type: 'club_bank_send',
        metadata: { destination: 'player_wallet' },
      })
    ).toBe('Club Bank To Player Wallet');
    expect(walletRoute({ transaction_type: 'agent_wallet_self_stake' })).toBe(
      'Agent Wallet To Player Wallet'
    );
  });

  it('every narrated type is a type the cashier actually writes', () => {
    for (const t of WALLET_MOVE_TYPES) {
      expect(t).toMatch(/^[a-z_]+$/);
    }
  });
});
