/**
 *  TRANSACTION HISTORY PAGE — With Pagination & Export
 */

import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { supabase } from '../lib/supabase';
import { masterBus } from '../core/MasterBus';
import { useAuthUser } from '../hooks/useAuthUser';
import { useToast } from '../components/common/Toast';
import { exportToCSV } from '../lib/export';
import { retryFetch } from '../utils/retryFetch';
import { useIsMounted } from '../hooks/useIsMounted';
import './TransactionHistoryPage.css';
import { useVisibilityRefresh } from '../hooks/useVisibilityRefresh';
import PageSkeleton from '../components/common/PageSkeleton';
import { formatDateTime as formatDate } from '../utils/format';
import { reportError } from '../utils/errorReporter';
import RewardsSurfaceHeader from '../components/rewards/RewardsSurfaceHeader';
import { formatPopupText } from '../utils/popupStyle';
import { playerDisplayName, PLAYER_NAME_COLUMNS } from '../utils/playerDisplayName';
import {
  describeChipTransaction,
  WALLET_MOVE_TYPES,
} from '../components/wallet/describeChipTransaction';

interface Transaction {
  id: string;
  type:
    | 'deposit'
    | 'withdrawal'
    | 'transfer_in'
    | 'transfer_out'
    | 'rake'
    | 'rakeback'
    | 'settlement';
  amount: number;
  currency: 'chips' | 'diamonds' | 'usd';
  description: string;
  created_at: string;
  club_id?: string;
  club_name?: string;
  counterparty_name?: string;
}

type TransactionFilter = 'all' | 'deposits' | 'withdrawals' | 'transfers' | 'rake';

const PAGE_SIZE = 25;

// SWR cache helpers
function getTxCache(userId: string): Transaction[] | null {
  try {
    const raw = sessionStorage.getItem(`tx_cache_${userId}`);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}
function setTxCache(userId: string, data: Transaction[]) {
  try {
    sessionStorage.setItem(`tx_cache_${userId}`, JSON.stringify(data.slice(0, 25)));
  } catch {
    /* storage full */
  }
}

export default function TransactionHistoryPage() {
  const navigate = useNavigate();
  useVisibilityRefresh(() => loadTransactions(1, true));
  const { user } = useAuthUser();
  const toast = useToast();
  const isMounted = useIsMounted();
  const hasDataRef = useRef(false);

  const [transactions, setTransactions] = useState<Transaction[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [filter, setFilter] = useState<TransactionFilter>('all');
  const [hasMore, setHasMore] = useState(true);
  const [page, setPage] = useState(0);
  const [searchQuery, setSearchQuery] = useState('');
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  const [visibleTransactions, setVisibleTransactions] = useState(new Set<number>());

  // Safety timeout: prevent infinite skeleton if auth/Supabase hangs
  useEffect(() => {
    const timeout = setTimeout(() => setLoading(false), 5000);
    return () => clearTimeout(timeout);
  }, []);

  // SWR: show cached transactions instantly on mount (only for 'all' filter, no date range)
  useEffect(() => {
    if (!user?.id || filter !== 'all' || dateFrom || dateTo) return;
    const cached = getTxCache(user.id);
    if (cached && cached.length > 0) {
      setTransactions(cached);
      hasDataRef.current = true;
      setLoading(false);
    }
  }, [user?.id]);

  // Ref for realtime/bus callbacks to avoid stale closures on filter/date state
  const loadTransactionsRef = useRef<
    (pageNum: number, reset?: boolean, getIsMounted?: () => boolean) => void
  >(() => {});

  // Stagger transaction rows
  useEffect(() => {
    setVisibleTransactions(new Set());
    const timers = transactions.map((_, i) =>
      setTimeout(() => setVisibleTransactions((prev) => new Set([...prev, i])), i * 35)
    );
    return () => timers.forEach((t) => clearTimeout(t));
  }, [transactions.length]);

  useEffect(() => {
    let isMounted = true;
    if (user?.id) {
      if (!hasDataRef.current) setTransactions([]);
      setPage(0);
      setHasMore(true);
      loadTransactions(0, true, () => isMounted);
    }
    return () => {
      isMounted = false;
    };
  }, [user?.id, filter, dateFrom, dateTo]);

  // ── Realtime: live transaction updates ──
  useEffect(() => {
    if (!user?.id) return;
    const channelKey = `tx-history-${user.id}`;

    const channel = masterBus.getOrCreateChannel(channelKey);
    channel
      .on(
        'postgres_changes',
        {
          event: 'INSERT',
          schema: 'public',
          table: 'chip_transactions',
          filter: `to_user_id=eq.${user.id}`,
        },
        () => {
          loadTransactionsRef.current(0, true);
        }
      )
      .subscribe((status: string, err?: Error) => {
        if (status === 'CHANNEL_ERROR') {
          if (err)
            reportError(err?.message || err, 'TransactionHistoryPage._Realtime_channel_error');
        }
        if (status === 'TIMED_OUT') {
          console.warn('[TransactionHistoryPage] Realtime channel timed out');
        }
      });
    return () => {
      masterBus.removeRegisteredChannel(channelKey);
    };
  }, [user?.id]);

  // Bus listeners: reload when wallet/balance changes (e.g. cashout, rakeback claim, chip send)
  useEffect(() => {
    if (!user?.id) return;
    const refresh = () => loadTransactionsRef.current(0, true);
    const unsubWallet = masterBus.subscribeDebounced('WALLET_REFRESHED', refresh, 500);
    const unsubBalance = masterBus.subscribeDebounced('BALANCE_UPDATED', refresh, 500);
    const unsubChipsAdded = masterBus.subscribeDebounced('CHIPS_ADDED', refresh, 500);
    const unsubChipsWithdrawn = masterBus.subscribeDebounced('CHIPS_WITHDRAWN', refresh, 500);
    return () => {
      unsubWallet();
      unsubBalance();
      unsubChipsAdded();
      unsubChipsWithdrawn();
    };
  }, [user?.id]);

  const loadingRef = useRef(false);

  const loadTransactions = async (pageNum: number, reset = false, getIsMounted?: () => boolean) => {
    if (!user?.id) return;
    if (loadingRef.current) return;
    loadingRef.current = true;
    if (reset) {
      if (!getIsMounted || getIsMounted()) setLoading(true);
    } else {
      if (!getIsMounted || getIsMounted()) setLoadingMore(true);
    }

    try {
      let query = supabase
        .from('chip_transactions')
        .select(
          `
                    id,
                    transaction_type,
                    amount,
                    notes,
                    created_at,
                    club_id,
                    from_user_id,
                    to_user_id,
                    metadata,
                    clubs (name)
                `
        )
        .or(`from_user_id.eq.${user?.id},to_user_id.eq.${user?.id}`)
        .order('created_at', { ascending: false })
        .range(pageNum * PAGE_SIZE, (pageNum + 1) * PAGE_SIZE - 1);

      if (filter === 'deposits') query = query.eq('transaction_type', 'deposit');
      else if (filter === 'withdrawals')
        query = query.in('transaction_type', ['cash_out', 'withdrawal']);
      else if (filter === 'transfers')
        // The Transfers filter used to list three legacy labels and none of
        // the types the cashier actually writes, so every agent wallet send,
        // club bank send and claim back fell out of it (Dan 2026-09-02).
        query = query.in('transaction_type', [
          'transfer_in',
          'transfer_out',
          'agent_transfer',
          ...WALLET_MOVE_TYPES,
        ]);
      else if (filter === 'rake') query = query.in('transaction_type', ['rake', 'rakeback']);

      if (dateFrom) query = query.gte('created_at', new Date(dateFrom).toISOString());
      if (dateTo) {
        const endDate = new Date(dateTo);
        endDate.setHours(23, 59, 59, 999);
        query = query.lte('created_at', endDate.toISOString());
      }

      const { data, error } = await retryFetch(() => query.then((r) => r), {
        maxRetries: 2,
        isMountedRef: isMounted,
      });

      if (getIsMounted && !getIsMounted()) return;
      if (!error && data) {
        /* THE LINE NAMES BOTH WALLETS (Dan 2026-09-02): "KINGFISH TRANSFERRED
           XXX FROM HIS AGENT WALLET TO PLAYER WALLET". A wallet move is
           described from the row's own structure - actor, amount, source and
           destination wallet - by describeChipTransaction; the names it needs
           are read once per page. Everything that is not a wallet move keeps
           its notes exactly as before. A name outage degrades to "A Member",
           never to a hidden row. */
        const ids = new Set<string>();
        for (const t of data as any[]) {
          if (t.from_user_id) ids.add(t.from_user_id);
          if (t.to_user_id) ids.add(t.to_user_id);
        }
        const names = new Map<string, string>();
        if (ids.size > 0) {
          const { data: profs, error: profErr } = await supabase
            .from('profiles')
            .select(`id, ${PLAYER_NAME_COLUMNS}`)
            .in('id', Array.from(ids));
          if (profErr) reportError(profErr, 'TransactionHistoryPage.names_read_failed');
          for (const p of profs ?? []) {
            const label = playerDisplayName(p as any);
            if (label) names.set((p as any).id, String(label));
          }
        }
        if (getIsMounted && !getIsMounted()) return;
        const mapped = data.map((t: any) => ({
          id: t.id,
          type: t.transaction_type,
          amount: t.amount,
          currency: 'chips' as const,
          description: describeChipTransaction(t, names, user?.id) ?? (t.notes || ''),
          created_at: t.created_at,
          club_id: t.club_id,
          club_name: t.clubs?.name,
        }));

        // SWR: cache first page for instant display on revisit (unfiltered only)
        if (pageNum === 0 && filter === 'all' && !dateFrom && !dateTo && user?.id) {
          setTxCache(user.id, mapped);
        }
        hasDataRef.current = true;

        if (reset) {
          setTransactions(mapped);
        } else {
          setTransactions((prev) => [...prev, ...mapped]);
        }

        setHasMore(data.length === PAGE_SIZE);
        setPage(pageNum);
      }
    } catch (error) {
      reportError(error, 'TransactionHistoryPage.Failed_to_load_transactions');
      if (!getIsMounted || getIsMounted()) toast.error('Failed to load transactions');
    } finally {
      loadingRef.current = false;
      if (!getIsMounted || getIsMounted()) {
        setLoading(false);
        setLoadingMore(false);
      }
    }
  };

  // Keep ref in sync with latest loadTransactions (captures current filter, dateFrom, dateTo)
  useEffect(() => {
    loadTransactionsRef.current = loadTransactions;
  });

  const loadMore = () => {
    if (!loadingMore && hasMore) {
      loadTransactions(page + 1);
    }
  };

  const handleExportCSV = () => {
    try {
      exportToCSV(transactions, 'transactions.csv', [
        { key: 'created_at', label: 'Date' },
        { key: 'type', label: 'Type' },
        { key: 'description', label: 'Description' },
        { key: 'amount', label: 'Amount' },
        { key: 'currency', label: 'Currency' },
        { key: 'club_name', label: 'Club' },
      ]);
      toast.success('Transactions exported!');
    } catch (err) {
      reportError(err, 'TransactionHistoryPage.CSV_export_failed');
      toast.error('Failed to export transactions.');
    }
  };

  const getIcon = (type: string): { symbol: string; color: string; bg: string } => {
    switch (type) {
      case 'deposit':
        return { symbol: '▲', color: '#00C853', bg: 'rgba(0,200,83,0.12)' };
      case 'withdrawal':
      case 'cash_out':
        return { symbol: '▼', color: '#ef4444', bg: 'rgba(239,68,68,0.12)' };
      case 'transfer_in':
        return { symbol: '←', color: '#3b82f6', bg: 'rgba(59,130,246,0.12)' };
      case 'transfer_out':
      case 'agent_transfer':
        return { symbol: '→', color: '#8b5cf6', bg: 'rgba(139,92,246,0.12)' };
      case 'rake':
        return { symbol: '%', color: '#00d4ff', bg: 'rgba(0,212,255,0.12)' };
      case 'rakeback':
        return { symbol: '↺', color: '#10b981', bg: 'rgba(16,185,129,0.12)' };
      case 'settlement':
        return { symbol: '☐', color: '#f59e0b', bg: 'rgba(245,158,11,0.12)' };
      default:
        return { symbol: '●', color: '#6a7a8a', bg: 'rgba(106,122,138,0.12)' };
    }
  };

  const getCurrencySymbol = (currency: string): string => {
    switch (currency) {
      case 'diamonds':
        return '◆';
      case 'usd':
        return '';
      default:
        return '♠';
    }
  };

  // Apply local search filter
  const displayTransactions = useMemo(() => {
    if (!searchQuery.trim()) return transactions;
    const q = searchQuery.toLowerCase();
    return transactions.filter(
      (tx) =>
        (tx.description || '').toLowerCase().includes(q) ||
        (tx.club_name || '').toLowerCase().includes(q) ||
        tx.type.toLowerCase().includes(q)
    );
  }, [transactions, searchQuery]);

  // Calculate totals from visible transactions
  const totals = displayTransactions.reduce(
    (acc, tx) => {
      if (tx.amount > 0) acc.deposits += tx.amount;
      else acc.withdrawals += Math.abs(tx.amount);
      return acc;
    },
    { deposits: 0, withdrawals: 0 }
  );
  const netFlow = totals.deposits - totals.withdrawals;

  return (
    <div className="transaction-history-page">
      <RewardsSurfaceHeader
        eyebrow="Rewards Circuit / Ledger"
        title="Transaction Ledger"
        description="Audit Deposits, Withdrawals, Transfers, Rake, And Settlements From One Filterable Record. Exported Results Preserve The Active Date And Transaction Filters."
        art="vault"
        status="TRANSACTION INDEX // LIVE"
        metrics={[
          { label: 'Inflow', value: `+${totals.deposits.toLocaleString()}`, tone: 'live' },
          { label: 'Outflow', value: `-${totals.withdrawals.toLocaleString()}` },
          {
            label: 'Net Flow',
            value: `${netFlow >= 0 ? '+' : ''}${netFlow.toLocaleString()}`,
            tone: netFlow >= 0 ? 'attention' : 'default',
          },
        ]}
      />
      {/* Summary */}
      <div className="tx-summary">
        <div className="summary-card">
          <span className="summary-value positive">+{totals.deposits.toLocaleString()}</span>
          <span className="summary-label">Deposits</span>
        </div>
        <div className="summary-card">
          <span className="summary-value negative">-{totals.withdrawals.toLocaleString()}</span>
          <span className="summary-label">Withdrawals</span>
        </div>
        <div className="summary-card">
          <span className={`summary-value ${netFlow >= 0 ? 'positive' : 'negative'}`}>
            {netFlow >= 0 ? '+' : ''}
            {netFlow.toLocaleString()}
          </span>
          <span className="summary-label">Net Flow</span>
        </div>
        <button className="export-btn" onClick={handleExportCSV}>
          Export CSV
        </button>
      </div>

      {/* Search + Date Range */}
      <div
        style={{
          display: 'flex',
          gap: '8px',
          marginBottom: '12px',
          flexWrap: 'wrap',
          alignItems: 'center',
        }}
      >
        <input
          type="text"
          placeholder="Search Transactions..."
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          style={{
            flex: 1,
            minWidth: '160px',
            padding: '8px 12px',
            borderRadius: '8px',
            border: '1px solid rgba(255,255,255,0.15)',
            background: 'rgba(255,255,255,0.05)',
            color: 'inherit',
            fontSize: '0.85rem',
          }}
        />
        <input
          type="date"
          value={dateFrom}
          onChange={(e) => setDateFrom(e.target.value)}
          style={{
            padding: '8px 10px',
            borderRadius: '8px',
            border: '1px solid rgba(255,255,255,0.15)',
            background: 'rgba(255,255,255,0.05)',
            color: 'inherit',
            fontSize: '0.8rem',
          }}
        />
        <span style={{ color: '#888', fontSize: '0.8rem' }}>To</span>
        <input
          type="date"
          value={dateTo}
          onChange={(e) => setDateTo(e.target.value)}
          style={{
            padding: '8px 10px',
            borderRadius: '8px',
            border: '1px solid rgba(255,255,255,0.15)',
            background: 'rgba(255,255,255,0.05)',
            color: 'inherit',
            fontSize: '0.8rem',
          }}
        />
        {(dateFrom || dateTo || searchQuery) && (
          <button
            onClick={() => {
              setDateFrom('');
              setDateTo('');
              setSearchQuery('');
            }}
            style={{
              padding: '6px 12px',
              borderRadius: '6px',
              border: '1px solid rgba(255,59,48,0.3)',
              background: 'rgba(255,59,48,0.1)',
              color: '#ff3b30',
              fontSize: '0.75rem',
              cursor: 'pointer',
            }}
          >
            Clear
          </button>
        )}
      </div>

      <div className="filter-tabs">
        {(['all', 'deposits', 'withdrawals', 'transfers', 'rake'] as TransactionFilter[]).map(
          (f) => (
            <button key={f} className={filter === f ? 'active' : ''} onClick={() => setFilter(f)}>
              {f.charAt(0).toUpperCase() + f.slice(1)}
            </button>
          )
        )}
      </div>

      <div className="transactions-list">
        {loading ? (
          <div className="loading-state">
            <PageSkeleton variant="financial" />
          </div>
        ) : displayTransactions.length === 0 ? (
          <div className="empty-state" style={{ textAlign: 'center', padding: '2.5rem 1.5rem' }}>
            <span
              style={{
                fontSize: '2.5rem',
                display: 'block',
                marginBottom: '0.75rem',
                opacity: 0.5,
              }}
            >
              ▦
            </span>
            <p style={{ fontSize: '1.05rem', fontWeight: 600, margin: '0 0 0.5rem' }}>
              {filter !== 'all'
                ? `No ${filter.charAt(0).toUpperCase() + filter.slice(1)}`
                : 'No Transactions'}
            </p>
            <p style={{ color: 'var(--soft-white, #B0B3B8)', fontSize: '0.85rem', margin: 0 }}>
              {searchQuery
                ? `No Results Matching "${searchQuery}".`
                : dateFrom || dateTo
                  ? 'No Transactions Found In The Selected Date Range.'
                  : filter !== 'all'
                    ? `No ${filter} Have Been Recorded Yet.`
                    : 'No Transaction History Yet. Your Activity Will Appear Here.'}
            </p>
          </div>
        ) : (
          <>
            {displayTransactions.map((tx, index) => {
              const icon = getIcon(tx.type);
              return (
                <div
                  key={tx.id}
                  className="transaction-row"
                  style={{
                    opacity: visibleTransactions.has(index) ? 1 : 0,
                    transform: visibleTransactions.has(index) ? 'translateY(0)' : 'translateY(6px)',
                    transition: 'all 0.3s cubic-bezier(0.175, 0.885, 0.32, 1.275)',
                  }}
                >
                  <span
                    className="tx-icon"
                    style={{
                      width: '36px',
                      height: '36px',
                      borderRadius: '10px',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      background: icon.bg,
                      color: icon.color,
                      fontSize: '1rem',
                      fontWeight: 700,
                      flexShrink: 0,
                    }}
                  >
                    {icon.symbol}
                  </span>
                  <div className="tx-info">
                    <span className="tx-desc">
                      {formatPopupText(tx.description || tx.type.replace('_', ' '))}
                    </span>
                    <span className="tx-meta">
                      {tx.club_name && <span className="tx-club">{tx.club_name}</span>}
                      {formatDate(tx.created_at)}
                    </span>
                  </div>
                  <span className={`tx-amount ${tx.amount >= 0 ? 'positive' : 'negative'}`}>
                    {tx.amount >= 0 ? '+' : ''}
                    {getCurrencySymbol(tx.currency)}
                    {Math.abs(tx.amount).toLocaleString()}
                  </span>
                </div>
              );
            })}

            {/* Load More Button */}
            {hasMore && (
              <button className="load-more-btn" onClick={loadMore} disabled={loadingMore}>
                {loadingMore ? 'Loading...' : 'Load More'}
              </button>
            )}
          </>
        )}
      </div>
    </div>
  );
}
