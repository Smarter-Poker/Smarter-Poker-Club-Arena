/**
 *  TRANSACTION HISTORY PAGE - the player's chip statement, full page.
 *
 * WHY THIS PAGE NO LONGER READS chip_transactions (launch audit, 2026-10-06).
 *
 * This page used to list `chip_transactions`. That table is a partial receipt
 * log, not the record of a player's chips. Measured on production for one busy
 * player over 24 hours: chip_ledger held 393 movements of their wallet (257
 * tournament entries out, 121 prizes and 11 bounties in, 3 add-ons, 1 rebuy),
 * and chip_transactions held only the 257 entries. Every prize and bounty was
 * missing, so the page showed a player paying in and never being paid, and its
 * Inflow / Outflow / Net figures were built from that one-sided list.
 *
 * The authoritative record is the chip journal, `chip_ledger`: the database
 * refuses any transaction that moves a covered balance without its matching
 * chip_ledger leg (docs/laws.d/a-balance-never-moves-without-its-ledger-row.md,
 * installed mode `refuse`), and the nightly replay checks every wallet against
 * it. The existing read for one player is fn_ca_chip_statement_page, rendered by
 * ChipStatement: it binds the account to auth.uid() (never a parameter), shows
 * both directions with signed amounts and plain-word labels, the balance now,
 * and the nightly reconciliation. This page renders that statement, so the
 * wallet page and this page can never disagree about a player's chips.
 *
 * What went with the old list: its search box, date range, type tabs and CSV
 * export all filtered the wrong table. The statement pages from the newest leg
 * backwards, so a client-side date or type filter over the loaded pages would
 * answer "nothing in this range" for movements simply not loaded yet - the one
 * answer a statement must never guess.
 *
 * HORSES ARE PLAYERS (CLAUDE.md 10.5): no horse branch here or in the RPC.
 */

import { useEffect, useState } from 'react';
import { masterBus } from '../core/MasterBus';
import { useVisibilityRefresh } from '../hooks/useVisibilityRefresh';
import RewardsSurfaceHeader from '../components/rewards/RewardsSurfaceHeader';
import ChipStatement from '../components/wallet/ChipStatement';
import './TransactionHistoryPage.css';

/** The full-page view shows more per page than the wallet's panel (50). */
export const TRANSACTION_PAGE_SIZE = 100;

export default function TransactionHistoryPage() {
  // A fresh read is a remount of the statement: it re-asks the RPC from the
  // newest leg, exactly as the old page reset to its first page.
  const [generation, setGeneration] = useState(0);
  useVisibilityRefresh(() => setGeneration((g) => g + 1));

  // A cash-out, rakeback claim or chip send elsewhere in the app changes the
  // wallet; read the statement again so this page does not go stale.
  useEffect(() => {
    const refresh = () => setGeneration((g) => g + 1);
    const unsubWallet = masterBus.subscribeDebounced('WALLET_REFRESHED', refresh, 500);
    const unsubBalance = masterBus.subscribeDebounced('BALANCE_UPDATED', refresh, 500);
    const unsubChipsAdded = masterBus.subscribeDebounced('CHIPS_ADDED', refresh, 500);
    return () => {
      unsubWallet();
      unsubBalance();
      unsubChipsAdded();
    };
  }, []);

  return (
    <div className="transaction-history-page">
      <RewardsSurfaceHeader
        eyebrow="Rewards Circuit / Ledger"
        title="Transaction Ledger"
        description="Every Chip That Came Into Or Went Out Of Your Wallet, Newest First, Read From The Chip Journal, With The Nightly Check That Your Balance Adds Up."
        art="vault"
        status="CHIP JOURNAL // LIVE"
        crest="diamond"
      />
      <div className="transaction-history-page__statement">
        <ChipStatement
          key={generation}
          scope="player"
          pageSize={TRANSACTION_PAGE_SIZE}
          title="Your Chip Statement"
        />
      </div>
    </div>
  );
}
