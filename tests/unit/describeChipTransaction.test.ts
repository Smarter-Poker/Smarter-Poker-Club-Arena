/**
 * Dan 2026-09-02: "IN THE TRANSACTION LEDGER, IT NEEDS TO SPECIFY WHICH WALLET
 * A USER IS TRANSFERRING TO REGARDLESS OF ROLE - 'KINGFISH TRANSFERRED XXX
 * FROM HIS AGENT WALLET TO PLAYER WALLET'."
 *
 * Every wallet-moving transaction type the cashier writes gets one sentence
 * that names the actor, the amount, the wallet the chips left and the wallet
 * they entered. Anything that is not a wallet move is left alone.
 */
import { describe, it, expect } from 'vitest';
import {
  describeChipTransaction,
  presentChipTransaction,
  thirdPartySender,
  walletRoute,
  WALLET_MOVE_TYPES,
} from '../../src/components/wallet/describeChipTransaction';

const KING = 'aaaaaaaa-0000-4000-8000-000000000001';
const BOB = 'bbbbbbbb-0000-4000-8000-000000000002';
/** A reader who is neither side of the row: an owner reading staff's sends. */
const THIRD = 'cccccccc-0000-4000-8000-000000000003';
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
      "KINGFISH Transferred 500 From KINGFISH's Agent Wallet To KINGFISH's Player Wallet"
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
    // UPDATED 2026-10-09 (audit C1-14): a forward-facing sentence prints chip
    // figures through compactChips, never "1,250.5" under a "1.2K" headline.
    expect(line).toBe("KINGFISH Sent 1.2K From KINGFISH's Agent Wallet To Bob's Player Wallet");
  });

  /**
   * UPDATED 2026-10-09 (cashier launch round 3, contract 2). A Club Bank send
   * is the bank paying a member. Its operator is named to the two people in
   * it, the operator and the member paid; anyone else reads the pot that paid,
   * as the Statement prints it (20261009223439, rule 3). That is what lets a
   * send nobody pressed (a treasury-funded seat) read exactly like one somebody
   * did: a third party used to read "KINGFISH Sent 100 From The Club Bank ..."
   * for a human's send and "A Member Sent ..." for a horse's.
   */
  it('a club bank send says it came from the club bank, whatever the role', () => {
    const row = {
      transaction_type: 'club_bank_send',
      amount: 100,
      from_user_id: KING,
      to_user_id: BOB,
      metadata: { destination: 'agent_wallet', actor_role: 'owner' },
    };
    // A reader who is not in it, or one the caller did not name, reads the pot.
    expect(describeChipTransaction(row, names)).toBe(
      "The Club Bank Sent 100 To Bob's Agent Wallet"
    );
    expect(describeChipTransaction(row, names, THIRD)).toBe(
      "The Club Bank Sent 100 To Bob's Agent Wallet"
    );
    // The operator and the member paid read who pressed the button.
    expect(describeChipTransaction(row, names, KING)).toBe(
      "You Sent 100 From The Club Bank To Bob's Agent Wallet"
    );
    expect(describeChipTransaction(row, names, BOB)).toBe(
      'KINGFISH Sent 100 From The Club Bank To Your Agent Wallet'
    );
    expect(walletRoute(row)).toBe('Club Bank To Agent Wallet');
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
    ).toBe('You Transferred 2K From The Club Bank To Your Player Wallet');
  });

  /**
   * UPDATED 2026-10-09 (audit C1-4 / C3-2). This case used to pin an INVERTED
   * shape: a reversal written from the actor to the member. fn_club_bank_reverse
   * inserts (from = v_tx.to_user_id, to = v_tx.from_user_id): the member whose
   * wallet is debited back, then the original sender. Every fixture below is
   * copied from its writer's INSERT, so the sentence is tested against the row
   * production actually holds.
   */
  it('a bank reversal is told from the original sender, back into the club bank', () => {
    // 20260903170529 fn_club_bank_reverse: (v_tx.to_user_id, v_tx.from_user_id, ..., 'club_bank_reversal')
    const row = {
      transaction_type: 'club_bank_reversal',
      amount: 1,
      from_user_id: BOB,
      to_user_id: KING,
      metadata: { reverses: 'tx', destination: 'agent_wallet', actor_role: 'owner' },
    };
    expect(describeChipTransaction(row, names)).toBe(
      "KINGFISH Reversed 1 From Bob's Agent Wallet To The Club Bank"
    );
    expect(walletRoute(row)).toBe('Agent Wallet To Club Bank');
  });

  it('an agent claim back names the claiming agent and the wallet the chips left', () => {
    // 20260908125130 claim core: (p_club_id, v_src.to_user_id, v_actor, v_take, 'agent_wallet_claim_back',
    //   ..., {op_id, source, original_transaction_id, holder_balance_after, agent_wallet_after, ...})
    const row = {
      transaction_type: 'agent_wallet_claim_back',
      amount: 500,
      from_user_id: BOB,
      to_user_id: KING,
      metadata: { source: 'player_wallet', original_transaction_id: 'tx' },
    };
    expect(describeChipTransaction(row, names)).toBe(
      "KINGFISH Claimed Back 500 From Bob's Player Wallet To KINGFISH's Agent Wallet"
    );
    // The agent who claimed reads it as theirs; the player reads it as their wallet.
    expect(describeChipTransaction(row, names, KING)).toBe(
      "You Claimed Back 500 From Bob's Player Wallet To Your Agent Wallet"
    );
    expect(describeChipTransaction(row, names, BOB)).toBe(
      "KINGFISH Claimed Back 500 From Your Player Wallet To KINGFISH's Agent Wallet"
    );
    expect(walletRoute(row)).toBe('Player Wallet To Agent Wallet');
  });

  it('a club bank claim uses the type its writer inserts and lands in the club bank', () => {
    // 20260903170529 fn_club_bank_claim_back: (p_club_id, p_from_user_id, v_actor, p_amount, 'club_bank_claim',
    //   ..., {op_id, source, direction: 'into_bank', actor_role, holder_role, ...})
    const row = {
      transaction_type: 'club_bank_claim',
      amount: 250,
      from_user_id: BOB,
      to_user_id: KING,
      metadata: { source: 'agent_wallet', direction: 'into_bank', actor_role: 'owner' },
    };
    expect(describeChipTransaction(row, names)).toBe(
      "KINGFISH Claimed Back 250 From Bob's Agent Wallet To The Club Bank"
    );
    expect(walletRoute(row)).toBe('Agent Wallet To Club Bank');
    // No writer has ever inserted this spelling.
    expect(WALLET_MOVE_TYPES.has('club_bank_claim_back')).toBe(false);
  });

  it('an admin removal goes into the club bank, never an agent wallet', () => {
    // 20260903170529 fn_admin_remove_player_chips: (p_club_id, p_player_id, v_actor, p_amount, 'admin_removal',
    //   ..., {op_id, source: 'player_wallet', direction: 'into_bank', ...}) and chip_treasury += p_amount
    const row = {
      transaction_type: 'admin_removal',
      amount: 75,
      from_user_id: BOB,
      to_user_id: KING,
      metadata: { source: 'player_wallet', direction: 'into_bank', actor_role: 'admin' },
    };
    expect(describeChipTransaction(row, names)).toBe(
      "KINGFISH Removed 75 From Bob's Player Wallet To The Club Bank"
    );
    expect(walletRoute(row)).toBe('Player Wallet To Club Bank');
  });

  it('never prints a decimal chip figure', () => {
    for (const amount of [0.5, 999.99, 1250.5, 10000.25]) {
      const line = describeChipTransaction(
        {
          transaction_type: 'agent_wallet_send',
          amount,
          from_user_id: KING,
          to_user_id: BOB,
          metadata: { destination: 'player_wallet' },
        },
        names
      );
      expect(line).not.toMatch(/\d\.\d+(?!K|M|B)/);
    }
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

  /**
   * Cashier launch round 3, contract 2 (Dan, binding: "NOTHING SHOULD EVER
   * REVEAL A HORSES IDENTITY"). The treasury writers' own row - copied from
   * fn_horse_fund_from_treasury's INSERT: from nobody, to the seated member,
   * no metadata, a stock note - is presented as the Club Bank send it is.
   */
  it('a treasury-funded seat reads as the Club Bank send it is, for every reader', () => {
    const funded = {
      transaction_type: 'horse_treasury_funding',
      amount: 500,
      from_user_id: null,
      to_user_id: BOB,
      notes: 'Horse buy-in/rebuy funded from club treasury',
      metadata: null,
    };
    const shown = presentChipTransaction(funded);
    expect(shown).toEqual({
      transaction_type: 'club_bank_send',
      amount: 500,
      from_user_id: null,
      to_user_id: BOB,
      notes: null,
      metadata: { destination: 'player_wallet' },
    });
    // The same movement made by a person, read by someone who is not in it.
    const human = {
      transaction_type: 'club_bank_send',
      amount: 500,
      from_user_id: KING,
      to_user_id: BOB,
      notes: 'Club Bank Send',
      metadata: { destination: 'player_wallet', actor_role: 'owner' },
    };
    for (const reader of [THIRD, null, undefined]) {
      expect(describeChipTransaction(funded, names, reader)).toBe(
        describeChipTransaction(human, names, reader)
      );
    }
    expect(describeChipTransaction(funded, names, THIRD)).toBe(
      "The Club Bank Sent 500 To Bob's Player Wallet"
    );
    expect(walletRoute(funded)).toBe('Club Bank To Player Wallet');
    expect(walletRoute(funded)).toBe(walletRoute(human));
    expect(thirdPartySender(shown, null)).toBe(thirdPartySender(human, 'KINGFISH'));
    // Every other row is handed back untouched.
    expect(presentChipTransaction(human)).toBe(human);
  });

  it('a third party reads a Club Bank send by its pot, any other move by its sender', () => {
    expect(thirdPartySender({ transaction_type: 'club_bank_send' }, 'KINGFISH')).toBe('Club Bank');
    expect(thirdPartySender({ transaction_type: 'agent_wallet_send' }, 'KINGFISH')).toBe(
      'KINGFISH'
    );
    expect(thirdPartySender({ transaction_type: 'agent_wallet_send' }, null)).toBe('A Member');
    expect(thirdPartySender({ transaction_type: 'plinko_prize' }, ' ')).toBe('A Member');
  });
});

it.each(['promo_wallet_send', 'club_promo_send'])(
  'keeps selected agent float distinct from legacy promo destinations for %s',
  (transaction_type) => {
    expect(
      walletRoute({ transaction_type, metadata: { destination: 'cashier_agent_wallet' } })
    ).toBe(
      `${transaction_type === 'club_promo_send' ? 'Club Promo Wallet' : 'Promo Wallet'} To Agent Wallet`
    );
    expect(
      walletRoute({ transaction_type, metadata: { destination: 'cashier_promo_wallet' } })
    ).toContain('To Promo Wallet');
    expect(walletRoute({ transaction_type, metadata: { destination: 'agent_wallet' } })).toContain(
      'To Promo Wallet'
    );
  }
);
it('shows an explicit player wallet send route without guessing routes of old peer records', () => {
  expect(
    walletRoute({
      transaction_type: 'peer_transfer',
      metadata: { source: 'player_wallet', destination: 'promo_wallet' },
    })
  ).toBe('Player Wallet To Promo Wallet');
  expect(walletRoute({ transaction_type: 'peer_transfer' })).toBeNull();
});
