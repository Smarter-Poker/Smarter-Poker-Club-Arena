/**
 * A CLUB OWNER CAN BE PAID INTO THEIR PLAYER WALLET (Dan 2026-10-11, binding)
 *
 * "CLUB OWNERS CAN PLAY AND HAVE CHIPS SENT TO THEIR PLAYER WALLETS. THEY
 * CURRENTLY AREN'T SELECTABLE TO RECEIVE CHIPS."
 *
 * Owners and co-owners have held a player wallet since 2026-09-02, and the
 * server has always credited one for them: fn_club_bank_send refuses a
 * player-wallet credit only to an admin, and has no self guard. Every screen
 * that spends the Club Bank chose the wallet from the recipient's ROLE
 * (`canHoldAgentWallet(role) ? 'agent_wallet' : 'player_wallet'`), so an
 * owner - including the owner sending to himself - was only ever paid into his
 * agent float. Production had never recorded one Club Bank send into a player
 * wallet. The Trade grid offered the owner's own row no action at all.
 *
 * The rule pinned here: the owner is in the recipient roster, is sendable, and
 * a Club Bank send to anyone who holds both wallets lets the sender choose the
 * player wallet - through fn_club_bank_send, the same audited path, never a
 * new one.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { cashierRecipientBlock, mapCashierRoster } from '../src/lib/cashierRoster';
import {
  cashierRefusesSelfSend,
  clubBankDestinationFor,
  clubBankRecipientWallets,
} from '../src/components/wallet/cashierModes';
import {
  canHoldAgentWallet,
  clubWalletRows,
  holdsPlayerWallet,
} from '../src/components/wallet/walletRows';

const read = (p: string) => readFileSync(resolve(__dirname, '..', p), 'utf8');
const OWNER = '47965354-0e56-43ef-931c-ddaab82af765';
const AGENT = '11111111-1111-4111-8111-111111111111';

const ROSTER_ROWS = [
  { user_id: OWNER, role_rank: 100, role: 'owner', name: 'KingFish', chip_balance: 0 },
  { user_id: AGENT, role_rank: 40, role: 'agent', name: 'An Agent', chip_balance: 0 },
  { user_id: 'p1', role_rank: 0, role: 'player', name: 'A Player', chip_balance: 5 },
  { user_id: 'a1', role_rank: 80, role: 'admin', name: 'An Admin', chip_balance: 0 },
];

describe('a club owner is a recipient, not a hole in the list', () => {
  it('the owner is in the roster, whoever is looking', () => {
    for (const viewer of [OWNER, AGENT]) {
      const roster = mapCashierRoster(ROSTER_ROWS, viewer);
      const owner = roster.find((r) => r.userId === OWNER);
      expect(owner).toBeDefined();
      expect(owner?.role).toBe('owner');
    }
  });

  it('owners and co-owners hold a player wallet; an admin does not', () => {
    expect(holdsPlayerWallet('owner')).toBe(true);
    expect(holdsPlayerWallet('co_owner')).toBe(true);
    expect(holdsPlayerWallet('super_agent')).toBe(true);
    expect(holdsPlayerWallet('player')).toBe(true);
    expect(holdsPlayerWallet('admin')).toBe(false);
    // The wallet panel and the cashier read the same rule.
    expect(clubWalletRows('owner')).toContain('player_wallet');
    expect(clubWalletRows('admin')).not.toContain('player_wallet');
  });

  it('a Club Bank send to an owner offers the player wallet, and defaults to the float', () => {
    // 2026-10-16: the Promo Wallet an agent-capable recipient holds is offered too.
    expect(clubBankRecipientWallets('owner')).toEqual([
      'agent_wallet',
      'promo_wallet',
      'player_wallet',
    ]);
    expect(clubBankRecipientWallets('co_owner')).toEqual([
      'agent_wallet',
      'promo_wallet',
      'player_wallet',
    ]);
    expect(clubBankRecipientWallets('player')).toEqual(['player_wallet']);
    expect(clubBankRecipientWallets('admin')).toEqual(['agent_wallet', 'promo_wallet']);
    expect(clubBankDestinationFor('owner', 'promo_wallet')).toBe('promo_wallet');
    expect(clubBankDestinationFor('owner', 'player_wallet')).toBe('player_wallet');
    expect(clubBankDestinationFor('owner', null)).toBe('agent_wallet');
    // A stale choice never routes chips to a wallet the recipient lacks.
    expect(clubBankDestinationFor('admin', 'player_wallet')).toBe('agent_wallet');
    expect(clubBankDestinationFor('player', 'agent_wallet')).toBe('player_wallet');
  });

  it('the owner sending to himself from the Club Bank is not refused', () => {
    // fn_club_bank_send has no self guard; the agent wallet cashier still does.
    expect(cashierRefusesSelfSend('club_bank')).toBe(false);
    expect(cashierRefusesSelfSend('agent_wallet')).toBe(true);
    expect(
      cashierRecipientBlock({
        isSelf: true,
        refusesSelfSend: cashierRefusesSelfSend('club_bank'),
        destinationNeedsAgentWallet: false,
        memberHoldsAgentWallet: canHoldAgentWallet('owner'),
        destinationIsPlayerWallet: true,
        memberHoldsPlayerWallet: holdsPlayerWallet('owner'),
      })
    ).toBeNull();
    // An owner who is NOT the sender is equally sendable into a player wallet.
    expect(
      cashierRecipientBlock({
        isSelf: false,
        refusesSelfSend: true,
        destinationNeedsAgentWallet: false,
        memberHoldsAgentWallet: true,
        destinationIsPlayerWallet: true,
        memberHoldsPlayerWallet: holdsPlayerWallet('owner'),
      })
    ).toBeNull();
    // The admin is listed and explained, not offered a refusal.
    expect(
      cashierRecipientBlock({
        isSelf: false,
        refusesSelfSend: true,
        destinationNeedsAgentWallet: false,
        memberHoldsAgentWallet: true,
        destinationIsPlayerWallet: true,
        memberHoldsPlayerWallet: holdsPlayerWallet('admin'),
      })?.label
    ).toBe('No Player Wallet');
  });
});

describe('no Club Bank screen picks the wallet from the role alone', () => {
  it('the transfer modal sends the chosen wallet', () => {
    const modal = read('src/components/agent/ChipTransferModal.tsx');
    expect(modal).toContain('clubBankDestinationFor(recipientData.role, chosenWallet)');
    expect(modal).toContain('clubBankRecipientWallets(selectedRecipientData.role)');
    expect(modal).toContain('p_destination: destination,');
    expect(modal).not.toContain(
      "const destination = canHoldAgentWallet(recipientData.role) ? 'agent_wallet' : 'player_wallet';"
    );
  });

  it('the classic cashier Distribute tab sends the chosen wallet', () => {
    const page = read('src/pages/CashierPage.tsx');
    expect(page).toContain('clubBankDestinationFor(selectedRecipientData.role, distributeWallet)');
    expect(page).toContain('p_destination: distributeDestination,');
    expect(page).not.toMatch(/p_destination: canHoldAgentWallet\(recipientRow\?\.role\)/);
  });

  it('the Trade grid lets the owner fund his own player wallet through the Club Bank', () => {
    const trade = read('src/pages/CashierTradePage.tsx');
    expect(trade).toContain("currentClub?.entityType === 'club' && canSeeClubBank(myRole)");
    // Dan 2026-10-15: the owner's own row is selectable like any other, and a
    // A selected Club Bank source pays the chosen eligible wallet, including self.
    expect(trade).toMatch(
      /const selectable =\s*!r\.isSelf \|\| selfCanFundPlayerWallet \|\| canHoldAgentWallet\(myRole\);/
    );
    expect(trade).toMatch(
      /kind === 'send' &&\s*targets.length === 1 &&\s*selfCanFundPlayerWallet &&\s*sendSource === 'club_bank'/
    );
    expect(trade).toContain("supabase.rpc('fn_club_bank_send', {");
    expect(trade).toContain('p_destination: transferDestination(picked[0]),');
    expect(trade).toContain('initialRecipientId={cashierPreset?.recipientId ?? null}');
    // The agent wallet still never pays the viewer: fn_agent_wallet_send
    // refuses it, so a batch never carries the viewer's own row.
    expect(trade).toContain("'Send To Yourself On Its Own, Then Send To The Others'");
  });

  it('the cashier modal opens on the preset recipient and wallet, through the same guard', () => {
    const modal = read('src/components/wallet/WalletCashierModal.tsx');
    expect(modal).toContain('if (!blockFor(row)) setRecipient(row);');
    expect(modal).toContain('cashierDestinations(walletType).includes(initialDestination)');
    expect(modal).toContain('memberHoldsPlayerWallet: holdsPlayerWallet(m.role),');
  });
});
