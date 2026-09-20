/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  TRANSACTION HISTORY — Wallet Transaction Log
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Reads `wallet_transactions`: the settled, server-written ledger of the
 * viewer's own money. Every row here was written inside the same transaction as
 * the movement it records, by the SECURITY DEFINER RPC that performed it - see
 * the block comment on WalletService.logTransaction for why the browser never
 * writes to this table.
 *
 * ── AUDIT 2026-08-25 ────────────────────────────────────────────────────────
 *
 *  1. THE LABEL MAP WAS MISSING FOUR LIVE CATEGORIES. `tournament_buyin`
 *     (85,589 rows in production), `bounty` (7,217), `rakeback` (1,571) and
 *     `addon_refund` (103) had no entry, so a player's biggest single category
 *     of spend rendered as the raw database enum: "tournament_buyin". The map
 *     is now derived from the table's own CHECK constraint
 *     (wallet_transactions_category_check) so it cannot drift again, and an
 *     unrecognised value title-cases instead of leaking the enum.
 *
 *  2. LOAD MORE COULD NEVER APPEAR. The query fetched `limit` rows (20 by
 *     default, 50 from the wallet page) and the button was gated on
 *     `filtered.length > page * 25`. With a page size larger than the fetch,
 *     `hasMore` was false for every user who has ever existed - the control was
 *     unreachable code and the history silently stopped at the first page.
 *     Paging is now done SERVER-side with .range(), so page 2 is a real second
 *     page rather than a slice of a page we already had.
 *
 *  3. THE FILTER LIED FOR THE SAME REASON. It filtered the fetched page in
 *     memory, so "Rake" showed the rake rows *within the last 20 movements*,
 *     not the last 20 rake rows. Filtering moved to the server alongside the
 *     paging, which is the only way the two can agree.
 *
 *  4. EVERY BUS EVENT TORE THE LIST DOWN. `loadTransactions` set `loading`,
 *     and `loading` returns the skeleton - so a buy-in three seats away
 *     replaced the whole history with shimmer bars for the length of a round
 *     trip. Only the FIRST load shows the skeleton now; refreshes swap the rows
 *     underneath a list that stays on screen.
 */

import { useState, useEffect, useCallback, useRef, memo } from 'react';
import { supabase } from '../../lib/supabase';
import { useAuthUser } from '../../hooks/useAuthUser';
import { useToast } from '../common/Toast';
import { useIsMounted } from '../../hooks/useIsMounted';
import { useStaggerAnimation } from '../../hooks/useStaggerAnimation';
import { useMasterBusSubscriptions } from '../../hooks/useMasterBusSubscription';
import './TransactionHistory.css';
import { reportError } from '../../utils/errorReporter';
import { formatPopupText } from '../../utils/popupStyle';

interface TransactionHistoryProps {
  /**
   * The user whose ledger to read. Named `walletId` historically; it is a
   * `wallet_transactions.user_id`, and RLS permits reading only your own rows,
   * so passing anyone else's returns an empty list rather than their money.
   */
  walletId?: string;
  /** Rows per page. Also the fetch size - see audit note 2. */
  limit?: number;
}

interface Transaction {
  id: string;
  type: 'credit' | 'debit';
  category: string;
  amount: number;
  balance: number;
  description: string;
  createdAt: Date;
  walletType: string;
}

/**
 * EVERY value `wallet_transactions_category_check` admits, in the order the
 * constraint lists them, plus the two legacy spellings that predate it. If the
 * constraint gains a value, add it here in the same commit - the fallback below
 * keeps an unknown value readable, but a real name beats a guessed one.
 */
const CATEGORY_LABELS: Record<string, string> = {
  buyin: 'Buy-In',
  cashout: 'Cash-Out',
  promo: 'Promo Bonus',
  rake: 'Rake',
  transfer: 'Transfer',
  tournament_buyin: 'Tournament Buy-In',
  tournament_winnings: 'Tournament Winnings',
  tournament_cashout: 'Tournament Cash-Out',
  horse_refill: 'Auto Refill',
  deposit: 'Deposit',
  withdrawal: 'Withdrawal',
  refund: 'Refund',
  bbj: 'Bad Beat Jackpot',
  bonus: 'Bonus',
  mint: 'Mint',
  settlement: 'Settlement',
  commission: 'Commission',
  INSURANCE: 'Insurance',
  prize: 'Prize',
  rebuy: 'Rebuy',
  addon: 'Add-On',
  funding: 'Funding',
  promotion: 'Promotion',
  rakeback: 'Rakeback',
  bounty: 'Bounty',
  addon_refund: 'Add-On Refund',
  bounty_own: 'Own Bounty',
  prize_reversal: 'Prize Reversal',
  // 'TIP' intentionally absent: dealer tipping was removed on 2026-08-20 and no
  // row has ever carried this category. The fallback below would still render a
  // legacy row rather than blanking it.
};

/**
 * A category nobody has taught this component about must still read like
 * English, and must never render the raw enum (house rule 9: HIGH_HAND reads
 * "High Hand"). Underscores and hyphens become spaces, every word takes a
 * capital, and an all-caps enum is lowered first so HIGH_HAND does not come
 * back as "HIGH HAND".
 */
export function formatCategory(raw: string | null | undefined): string {
  if (!raw) return 'Movement';
  const known = CATEGORY_LABELS[raw];
  if (known) return known;
  const words = raw.replace(/[_-]+/g, ' ').trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return 'Movement';
  return words
    .map((w) => (w === w.toUpperCase() ? w.toLowerCase() : w))
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

const CATEGORY_COLORS: Record<string, string> = {
  buyin: '#f59e0b',
  cashout: '#22c55e',
  rake: '#ef4444',
  prize: '#22c55e',
  rebuy: '#f59e0b',
  addon: '#f59e0b',
  mint: '#a855f7',
  settlement: '#3b82f6',
  commission: '#3b82f6',
  INSURANCE: '#f59e0b',
  funding: '#22c55e',
  transfer: '#3b82f6',
  deposit: '#22c55e',
  withdrawal: '#f59e0b',
  refund: '#22c55e',
  bonus: '#a855f7',
  promo: '#a855f7',
  promotion: '#a855f7',
  bbj: '#eab308',
  horse_refill: '#94a3b8',
  tournament_buyin: '#f59e0b',
  tournament_winnings: '#22c55e',
  tournament_cashout: '#22c55e',
  rakeback: '#22c55e',
  bounty: '#22c55e',
  bounty_own: '#22c55e',
  addon_refund: '#22c55e',
  prize_reversal: '#ef4444',
};

const CATEGORY_ICONS: Record<string, string> = {
  buyin: '▦',
  cashout: '◉',
  rake: '%',
  prize: '★',
  rebuy: '↺',
  addon: '⊞',
  mint: '◆',
  settlement: '≡',
  commission: '◈',
  INSURANCE: '⊕',
  funding: '→',
  promotion: '↑',
  promo: '★',
  bbj: '♣',
  horse_refill: '↺',
  transfer: '→',
  deposit: '+',
  withdrawal: '-',
  refund: '↻',
  bonus: '★',
  tournament_buyin: '♠',
  tournament_winnings: '★',
  tournament_cashout: '◉',
  rakeback: '↻',
  bounty: '✦',
  bounty_own: '✦',
  addon_refund: '↻',
  prize_reversal: '↩',
};

/** Filters offered in the dropdown. `value` is either a type or a category. */
const FILTERS: Array<{ value: string; label: string; kind: 'all' | 'type' | 'category' }> = [
  { value: 'all', label: 'All', kind: 'all' },
  { value: 'credit', label: 'Credits', kind: 'type' },
  { value: 'debit', label: 'Debits', kind: 'type' },
  { value: 'buyin', label: 'Buy-Ins', kind: 'category' },
  { value: 'cashout', label: 'Cash-Outs', kind: 'category' },
  { value: 'tournament_buyin', label: 'Tournament Buy-Ins', kind: 'category' },
  { value: 'prize', label: 'Prizes', kind: 'category' },
  { value: 'bounty', label: 'Bounties', kind: 'category' },
  { value: 'rake', label: 'Rake', kind: 'category' },
  { value: 'rakeback', label: 'Rakeback', kind: 'category' },
  { value: 'transfer', label: 'Transfers', kind: 'category' },
  { value: 'funding', label: 'Funding', kind: 'category' },
  { value: 'bonus', label: 'Bonuses', kind: 'category' },
];

// ── Skeleton Loading Component ──
function TransactionSkeleton() {
  return (
    <div className="transaction-history">
      <div className="transaction-history__header">
        <div className="tx-skeleton-bar" style={{ width: '140px', height: '16px' }} />
        <div
          className="tx-skeleton-bar"
          style={{ width: '80px', height: '28px', borderRadius: '6px' }}
        />
      </div>
      {Array.from({ length: 5 }).map((_, i) => (
        <div
          key={i}
          className="transaction-row tx-skeleton-row"
          style={{ animationDelay: `${i * 0.08}s` }}
        >
          <div className="tx-skeleton-circle" />
          <div className="details">
            {/* Fixed widths. `Math.random()` in a render body is a side effect:
                every re-render dealt new bar widths, so the skeleton twitched
                while it waited. */}
            <div className="tx-skeleton-bar" style={{ width: '72%', height: '13px' }} />
            <div
              className="tx-skeleton-bar"
              style={{ width: '48%', height: '10px', marginTop: '4px' }}
            />
          </div>
          <div className="amounts">
            <div className="tx-skeleton-bar" style={{ width: '60px', height: '14px' }} />
            <div
              className="tx-skeleton-bar"
              style={{ width: '45px', height: '10px', marginTop: '4px' }}
            />
          </div>
        </div>
      ))}
    </div>
  );
}

function TransactionHistoryInner({ walletId, limit = 20 }: TransactionHistoryProps) {
  const { user } = useAuthUser();
  const toast = useToast();

  const [transactions, setTransactions] = useState<Transaction[]>([]);
  /** First-paint only. A refresh must never take the list off the screen. */
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [loadError, setLoadError] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [filter, setFilter] = useState<string>('all');
  const isMounted = useIsMounted();

  const targetUserId = walletId || user?.id || null;
  const pageSize = Math.max(1, limit);

  /* The toast handle is read through a ref so it can never become a dependency
     of the fetch. `useToast()` returns context, and a provider that ever stops
     memoising its value would otherwise give `loadPage` a new identity on every
     render - and the effect below depends on `loadPage`, so that is an infinite
     fetch loop one unrelated edit away. */
  const toastRef = useRef(toast);
  useEffect(() => {
    toastRef.current = toast;
  }, [toast]);

  /* One toast per failure EPISODE. House rule 5.7: identical popups dedupe and
     retry loops must not re-toast. Cleared on the next success. */
  const toastedErrorRef = useRef(false);
  /* Discards a response whose request has been superseded (filter switched,
     user switched, refresh raced a Load More). */
  const requestSeqRef = useRef(0);

  // ── Load one page ─────────────────────────────────────────────────────────
  // append=false replaces the list (first load, filter change, bus refresh);
  // append=true adds the next page.
  const loadPage = useCallback(
    async (page: number, append: boolean) => {
      if (!targetUserId) {
        if (isMounted.current) {
          setTransactions([]);
          setHasMore(false);
          setLoading(false);
        }
        return;
      }
      const seq = ++requestSeqRef.current;
      if (append) setLoadingMore(true);

      try {
        const from = page * pageSize;
        let query = supabase
          .from('wallet_transactions')
          .select(
            'id, type, category, amount, balance_after, description, created_at, user_id, related_entity_id, wallet_type'
          )
          .eq('user_id', targetUserId)
          .order('created_at', { ascending: false })
          // Tie-break so two rows written in the same millisecond cannot swap
          // between pages and be shown twice (or skipped) across a .range().
          .order('id', { ascending: false })
          .range(from, from + pageSize - 1);

        const active = FILTERS.find((f) => f.value === filter);
        if (active?.kind === 'type') query = query.eq('type', active.value);
        else if (active?.kind === 'category') query = query.eq('category', active.value);

        const { data, error } = await query;
        if (!isMounted.current || seq !== requestSeqRef.current) return;

        // supabase-js RESOLVES with { data: null, error } - it does not throw.
        // Treating that as an empty page is how a ledger renders "No
        // Transactions" for a read that never happened.
        if (error) throw error;

        const mapped: Transaction[] = (data || []).map((t) => ({
          id: t.id,
          // The CHECK constraint allows only credit|debit, but a display must
          // not assume a constraint it cannot see. Anything else is treated as
          // a debit, which is the reading that cannot overstate a balance.
          type: t.type === 'credit' ? 'credit' : 'debit',
          category: t.category,
          amount: Number(t.amount) || 0,
          balance: Number(t.balance_after) || 0,
          description: t.description || '',
          createdAt: new Date(t.created_at),
          walletType: t.wallet_type || 'PLAYER',
        }));

        setTransactions((prev) => {
          if (!append) return mapped;
          // A row that arrived while the user was reading would otherwise shift
          // the window and duplicate a key across pages.
          const seen = new Set(prev.map((t) => t.id));
          return [...prev, ...mapped.filter((t) => !seen.has(t.id))];
        });
        setHasMore(mapped.length === pageSize);
        setLoadError(false);
        toastedErrorRef.current = false;
      } catch (e) {
        reportError(e, 'TransactionHistory.loadPage');
        if (!isMounted.current || seq !== requestSeqRef.current) return;
        setLoadError(true);
        if (!toastedErrorRef.current) {
          toastedErrorRef.current = true;
          toastRef.current.error('Could Not Load Your Transactions');
        }
      } finally {
        if (isMounted.current) {
          setLoading(false);
          setLoadingMore(false);
        }
      }
    },
    [targetUserId, pageSize, filter, isMounted]
  );

  /* Which page the list currently ends on. A ref, not state: it must not be a
     render input (the list length already is), and keeping it out of state
     stops a Load More from racing a refresh into two overlapping fetches. */
  const pageRef = useRef(0);

  useEffect(() => {
    pageRef.current = 0;
    setLoading(true);
    loadPage(0, false);
  }, [loadPage]);

  // ── Bus listeners: refresh page 0 in place, no skeleton ───────────────────
  // Includes CHIPS_ADDED and CHIPS_WITHDRAWN, which the wallet panel already
  // refreshes on (WALLET_BUS_EVENTS in DynamicWallet) but this ledger did not -
  // so a top-up moved the balance above the list while the list below it still
  // showed the movement missing.
  const refresh = useCallback(() => {
    pageRef.current = 0;
    loadPage(0, false);
  }, [loadPage]);

  useMasterBusSubscriptions(
    ['BALANCE_UPDATED', 'WALLET_REFRESHED', 'CHIPS_DISTRIBUTED', 'CHIPS_ADDED'],
    refresh,
    { debounce: 500 }
  );

  const { style: txStyle } = useStaggerAnimation(transactions.length);

  // ── Skeleton loading state — first paint only ──
  if (loading) {
    return <TransactionSkeleton />;
  }

  // ── Error state with retry ──
  if (loadError && transactions.length === 0) {
    return (
      <div className="transaction-history">
        <div className="tx-error-state">
          <span className="tx-error-icon" aria-hidden="true">
            {'⚠'}
          </span>
          <p>Failed To Load Transactions</p>
          <button className="tx-retry-btn" onClick={() => refresh()}>
            Retry
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="transaction-history">
      <div className="transaction-history__header">
        <h3>Transaction History</h3>
        <select
          value={filter}
          aria-label="Filter Transactions"
          onChange={(e) => setFilter(e.target.value)}
        >
          {FILTERS.map((f) => (
            <option key={f.value} value={f.value}>
              {f.label}
            </option>
          ))}
        </select>
      </div>

      {/* A failed REFRESH keeps the rows already on screen and says so, rather
          than replacing a correct list with an error card. */}
      {loadError && transactions.length > 0 && (
        <button className="tx-stale-banner" onClick={() => refresh()}>
          Could Not Refresh. Tap To Retry
        </button>
      )}

      {transactions.length === 0 ? (
        <div className="transaction-history__empty">
          {filter === 'all' ? 'No Transactions' : 'No Transactions Of This Kind'}
        </div>
      ) : (
        <div className="transaction-list">
          {transactions.map((tx, i) => (
            <div key={tx.id} className={`transaction-row ${tx.type}`} style={txStyle(i)}>
              <span className="icon" aria-hidden="true">
                {CATEGORY_ICONS[tx.category] || '●'}
              </span>
              <div className="details">
                <span className="type" style={{ color: CATEGORY_COLORS[tx.category] || '#94a3b8' }}>
                  {formatCategory(tx.category)}
                </span>
                <span className="description">{formatPopupText(tx.description)}</span>
              </div>
              <div className="amounts">
                <span className={`amount ${tx.type === 'credit' ? 'positive' : 'negative'}`}>
                  {tx.type === 'credit' ? '+' : '-'}
                  {tx.amount.toLocaleString()}
                </span>
                <span className="balance">Bal: {tx.balance.toLocaleString()}</span>
              </div>
              <span className="time">
                {tx.createdAt.toLocaleDateString()}{' '}
                {tx.createdAt.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
              </span>
            </div>
          ))}
          {hasMore && (
            <button
              className="tx-load-more"
              disabled={loadingMore}
              onClick={() => {
                if (loadingMore) return;
                pageRef.current += 1;
                loadPage(pageRef.current, true);
              }}
            >
              {loadingMore ? 'Loading...' : 'Load More'}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

const TransactionHistory = memo(TransactionHistoryInner);
export { TransactionHistory };
export default TransactionHistory;
