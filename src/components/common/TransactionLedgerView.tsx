/**
 * TransactionLedgerView — Reusable chip_ledger transaction history component
 *
 * Shows an immutable, append-only transaction log from the chip_ledger table.
 * Can be filtered by union_id, club_id, or user_id (as performer or recipient).
 *
 * Used on: Union Dashboard, Agent Dashboard, CashierPage, ClubFinancials
 */

import { useState, useEffect, useCallback } from 'react';
import { supabase } from '../../lib/supabase';
import { useMasterBusSubscriptions } from '../../hooks/useMasterBusSubscription';
import { isAuthzError } from '../../utils/clubDashboard';
import { isUUID } from '../../utils/clubIdResolver';
import { reportError } from '../../utils/errorReporter';
import { formatPopupText } from '../../utils/popupStyle';

interface LedgerEntry {
  id: string;
  performed_by: string;
  from_type: string;
  from_label: string | null;
  to_type: string;
  to_label: string | null;
  amount: number;
  category: string;
  description: string | null;
  created_at: string;
  club_id: string | null;
  union_id: string | null;
}

interface Props {
  unionId?: string;
  clubId?: string;
  userId?: string;
  limit?: number;
  title?: string;
  /**
   * CLUB-SCOPED (2026-09-04, phase 6). chip_ledger's RLS policy is
   * `performed_by = auth.uid() OR from_entity_id = auth.uid() OR
   * to_entity_id = auth.uid()` - the caller's OWN movements. A `.eq('club_id',
   * ...)` filter on top of that does not widen it, so this panel under the
   * heading "Club Chip Audit Trail" showed a club owner what THEY had moved
   * and called it the club's. With this flag the rows come from
   * ca_club_chip_ledger, which is gated on ca_can_view_club_finances and
   * returns the club's ledger. Requires clubId to be a uuid.
   */
  clubScoped?: boolean;
}

const CATEGORY_COLORS: Record<string, string> = {
  mint: '#22c55e',
  transfer: '#3b82f6',
  agent_funding: '#a855f7',
  player_funding: '#06b6d4',
  distribute: '#f59e0b',
  buyin: '#ec4899',
  cashout: '#10b981',
  clawback: '#ef4444',
  commission: '#f97316',
  rake: '#6366f1',
  settlement: '#14b8a6',
  deposit_to_union: '#22c55e',
  union_to_club: '#3b82f6',
};

const CATEGORY_ICONS: Record<string, string> = {
  mint: '+',
  transfer: '->',
  agent_funding: 'A',
  player_funding: 'P',
  distribute: 'D',
  buyin: 'B',
  cashout: 'C',
  clawback: 'X',
  commission: '%',
  rake: 'R',
  settlement: 'S',
  deposit_to_union: '+',
  union_to_club: '->',
};

export default function TransactionLedgerView({
  unionId,
  clubId,
  userId,
  limit = 25,
  title = 'Transaction History',
  clubScoped = false,
}: Props) {
  const [entries, setEntries] = useState<LedgerEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [denied, setDenied] = useState(false);

  const loadLedger = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      if (clubScoped) {
        // The RPC takes a uuid. Every club route in this app carries a SLUG,
        // and handing one to a uuid argument is a 22P02 the page then shows as
        // an outage - twice over in phase 6 alone. A caller that has not
        // resolved the club yet gets nothing rather than a false failure.
        if (!clubId || !isUUID(clubId)) {
          setEntries([]);
          setError(clubId ? 'The Club Ledger Could Not Be Loaded' : null);
          if (clubId)
            reportError(
              new Error(`club ledger called with "${clubId}"`),
              'TransactionLedgerView.unresolved_club'
            );
          setLoading(false);
          return;
        }
        const { data, error: rpcError } = await supabase.rpc('ca_club_chip_ledger', {
          p_club_id: clubId,
          p_limit: limit,
        });
        if (rpcError) {
          if (isAuthzError(rpcError)) {
            setDenied(true);
            setEntries([]);
          } else {
            reportError(rpcError, 'TransactionLedgerView.club_rpc');
            setError('The Club Ledger Could Not Be Loaded');
          }
        } else {
          setDenied(false);
          setEntries(((data as { rows?: LedgerEntry[] } | null)?.rows || []) as LedgerEntry[]);
        }
        setLoading(false);
        return;
      }

      let query = supabase
        .from('chip_ledger')
        .select('*')
        .order('created_at', { ascending: false })
        .limit(limit);

      if (unionId) query = query.eq('union_id', unionId);
      if (clubId) query = query.eq('club_id', clubId);
      if (userId) query = query.or(`performed_by.eq.${userId},to_entity_id.eq.${userId}`);

      const { data, error: readError } = await query;
      // A discarded error read as "no transactions", which on a ledger is the
      // one answer that must never be guessed.
      if (readError) {
        reportError(readError, 'TransactionLedgerView.read');
        setError('The Ledger Could Not Be Loaded');
      } else if (data) {
        setEntries(data as LedgerEntry[]);
      }
    } catch (e) {
      reportError(e, 'TransactionLedgerView.useCallback');
      setError('The Ledger Could Not Be Loaded');
    }
    setLoading(false);
  }, [unionId, clubId, userId, limit, clubScoped]);

  useEffect(() => {
    loadLedger();
  }, [loadLedger]);

  // Auto-refresh on new transactions
  useMasterBusSubscriptions(['BALANCE_UPDATED', 'TRANSACTION_LOGGED'], () => loadLedger(), {
    debounce: 2000,
  });

  if (loading) {
    return (
      <div style={{ padding: '16px', textAlign: 'center', color: '#666' }}>
        Loading Transactions...
      </div>
    );
  }

  if (denied) {
    return (
      <div style={{ padding: '24px', textAlign: 'center', color: '#888' }}>
        This Ledger Is Available To Club Owners, Admins And Super Agents.
      </div>
    );
  }

  if (error) {
    return (
      <div style={{ padding: '24px', textAlign: 'center', color: '#f87171' }} role="alert">
        <div>{error}</div>
        <button
          type="button"
          onClick={() => loadLedger()}
          style={{
            marginTop: 10,
            padding: '6px 14px',
            borderRadius: 8,
            border: '1px solid rgba(255,255,255,0.2)',
            background: 'transparent',
            color: 'inherit',
          }}
        >
          Try Again
        </button>
      </div>
    );
  }

  if (entries.length === 0) {
    return (
      <div style={{ padding: '24px', textAlign: 'center', color: '#666' }}>
        <div style={{ fontSize: '32px', marginBottom: '8px', opacity: 0.5 }}>{'▤'}</div>
        <div>No Transactions Yet</div>
      </div>
    );
  }

  return (
    <div>
      <div style={{ fontSize: '11px', color: '#888', marginBottom: '8px' }}>
        {entries.length} Transaction{entries.length !== 1 ? 's' : ''} Shown
      </div>
      <div
        style={{
          maxHeight: '400px',
          overflowY: 'auto',
          display: 'flex',
          flexDirection: 'column',
          gap: '6px',
        }}
      >
        {entries.map((e) => {
          const color = CATEGORY_COLORS[e.category] || '#888';
          const icon = CATEGORY_ICONS[e.category] || '?';
          const timeStr = new Date(e.created_at).toLocaleString();

          return (
            <div
              key={e.id}
              style={{
                display: 'flex',
                alignItems: 'flex-start',
                gap: '10px',
                padding: '8px 10px',
                background: 'rgba(255,255,255,0.03)',
                borderRadius: '8px',
                borderLeft: `3px solid ${color}`,
                fontSize: '12px',
              }}
            >
              <div
                style={{
                  width: '28px',
                  height: '28px',
                  borderRadius: '50%',
                  background: `${color}22`,
                  color: color,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  fontWeight: 700,
                  fontSize: '10px',
                  flexShrink: 0,
                }}
              >
                {icon}
              </div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div
                  style={{
                    fontWeight: 600,
                    color: '#e0e0e0',
                    textTransform: 'uppercase',
                    fontSize: '10px',
                    letterSpacing: '0.5px',
                  }}
                >
                  {e.category.replace(/_/g, ' ')}
                </div>
                <div
                  style={{
                    color: '#aaa',
                    fontSize: '11px',
                    marginTop: '2px',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  }}
                >
                  {e.from_label || e.from_type} → {e.to_label || e.to_type}
                </div>
                {e.description && (
                  <div
                    style={{
                      color: '#777',
                      fontSize: '10px',
                      marginTop: '2px',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                    }}
                  >
                    {formatPopupText(e.description)}
                  </div>
                )}
              </div>
              <div style={{ textAlign: 'right', flexShrink: 0 }}>
                <div style={{ fontWeight: 700, color: color, fontSize: '13px' }}>
                  {Number(e.amount).toLocaleString()}
                </div>
                <div style={{ fontSize: '9px', color: '#666', marginTop: '2px' }}>{timeStr}</div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
