/**
 * TransactionLedgerView — Reusable chip_ledger transaction history component
 *
 * Shows an immutable, append-only transaction log from the chip_ledger table.
 * Can be filtered by union_id, club_id, or user_id (as performer or recipient).
 *
 * Used on: Union Dashboard, Agent Dashboard, CashierPage, ClubFinancials
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import { supabase } from '../../lib/supabase';
import { useMasterBusSubscriptions } from '../../hooks/useMasterBusSubscription';
import { isAuthzError } from '../../utils/clubDashboard';
import { isUUID } from '../../utils/clubIdResolver';
import { reportError } from '../../utils/errorReporter';
import { formatPopupText } from '../../utils/popupStyle';
import { compactChips } from '../../utils/format';
import './TransactionLedgerView.css';

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

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function isNullableText(value: unknown): value is string | null {
  return value === null || typeof value === 'string';
}

function isLedgerEntry(value: unknown): value is LedgerEntry {
  if (!isRecord(value)) return false;
  return (
    typeof value.id === 'string' &&
    typeof value.performed_by === 'string' &&
    typeof value.from_type === 'string' &&
    isNullableText(value.from_label) &&
    typeof value.to_type === 'string' &&
    isNullableText(value.to_label) &&
    typeof value.amount === 'number' &&
    Number.isFinite(value.amount) &&
    value.amount > 0 &&
    typeof value.category === 'string' &&
    isNullableText(value.description) &&
    typeof value.created_at === 'string' &&
    Number.isFinite(Date.parse(value.created_at)) &&
    isNullableText(value.club_id) &&
    isNullableText(value.union_id)
  );
}

function ledgerRows(value: unknown): LedgerEntry[] | null {
  return Array.isArray(value) && value.every(isLedgerEntry) ? value : null;
}

function visibleLedgerCopy(entry: LedgerEntry) {
  // A horse is a player everywhere a customer can see. The journal retains
  // its operational category and labels, but the rendered row cannot expose
  // which funded seat used that internal path.
  if (
    [
      entry.category,
      entry.from_type,
      entry.from_label,
      entry.to_type,
      entry.to_label,
      entry.description,
    ].some((value) => /horse/i.test(value ?? ''))
  ) {
    return {
      category: 'Table Funding',
      path: 'The Club To A Table',
      description: null,
    };
  }
  return {
    category: formatPopupText(entry.category.replace(/_/g, ' ')),
    path: `${formatPopupText(entry.from_label || entry.from_type)} To ${formatPopupText(
      entry.to_label || entry.to_type
    )}`,
    description: entry.description ? formatPopupText(entry.description) : null,
  };
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
  const requestSequence = useRef(0);

  const loadLedger = useCallback(async () => {
    const request = ++requestSequence.current;
    const current = () => requestSequence.current === request;
    setLoading(true);
    setError(null);
    setDenied(false);
    setEntries([]);
    try {
      if (clubScoped) {
        // The RPC takes a uuid. Every club route in this app carries a SLUG,
        // and handing one to a uuid argument is a 22P02 the page then shows as
        // an outage - twice over in phase 6 alone. A caller that has not
        // resolved the club yet gets nothing rather than a false failure.
        if (!clubId || !isUUID(clubId)) {
          if (!current()) return;
          setError(clubId ? 'The Club Ledger Could Not Be Loaded' : null);
          if (clubId)
            reportError(
              new Error(`club ledger called with "${clubId}"`),
              'TransactionLedgerView.unresolved_club'
            );
          return;
        }
        const { data, error: rpcError } = await supabase.rpc('ca_club_chip_ledger', {
          p_club_id: clubId,
          p_limit: limit,
        });
        if (!current()) return;
        if (rpcError) {
          if (isAuthzError(rpcError)) {
            setDenied(true);
          } else {
            reportError(rpcError, 'TransactionLedgerView.club_rpc');
            setError('The Club Ledger Could Not Be Loaded');
          }
        } else {
          const rows = ledgerRows((data as { rows?: unknown } | null)?.rows);
          if (!rows) {
            reportError(
              new Error('Club ledger response did not contain valid rows'),
              'TransactionLedgerView.club_shape'
            );
            setError('The Club Ledger Could Not Be Loaded');
            return;
          }
          setDenied(false);
          setEntries(rows);
        }
        return;
      }

      /* AN UNSCOPED LEDGER READ IS REFUSED (2026-09-10). All three filters
         below are conditional, and the settlement dashboard mounted this
         with none of them - a select('*') on chip_ledger whose only narrowing
         was RLS ("my own movements"), rendered under a heading that called
         it the settlement audit trail. A caller must say WHOSE ledger it
         wants; a panel that cannot say renders this, not somebody's rows. */
      if (!unionId && !clubId && !userId) {
        reportError(
          new Error('TransactionLedgerView mounted with no union, club or user'),
          'TransactionLedgerView.unscoped'
        );
        setError('The Ledger Needs A Club, A Union Or A Player To Show');
        return;
      }

      let query = supabase
        .from('chip_ledger')
        .select('*')
        .order('created_at', { ascending: false })
        .limit(limit);

      if (unionId) query = query.eq('union_id', unionId);
      if (clubId) query = query.eq('club_id', clubId);
      // Both sides. Until 2026-09-07 (phase 7, 9.5) this asked only for
      // performed_by and to_entity_id, so every chip that LEFT the player -
      // a buy-in, an entry, a rebuy - was missing from their own history.
      if (userId)
        query = query.or(
          `performed_by.eq.${userId},to_entity_id.eq.${userId},from_entity_id.eq.${userId}`
        );

      const { data, error: readError } = await query;
      // A discarded error read as "no transactions", which on a ledger is the
      // one answer that must never be guessed.
      if (!current()) return;
      if (readError) {
        reportError(readError, 'TransactionLedgerView.read');
        setError('The Ledger Could Not Be Loaded');
      } else {
        const rows = ledgerRows(data);
        if (!rows) {
          reportError(
            new Error('Ledger response did not contain valid rows'),
            'TransactionLedgerView.read_shape'
          );
          setError('The Ledger Could Not Be Loaded');
        } else {
          setEntries(rows);
        }
      }
    } catch (e) {
      if (!current()) return;
      reportError(e, 'TransactionLedgerView.useCallback');
      setError('The Ledger Could Not Be Loaded');
    } finally {
      if (current()) setLoading(false);
    }
  }, [unionId, clubId, userId, limit, clubScoped]);

  useEffect(() => {
    void loadLedger();
    const request = requestSequence.current;
    return () => {
      if (requestSequence.current === request) requestSequence.current = request + 1;
    };
  }, [loadLedger]);

  // Auto-refresh on new transactions
  useMasterBusSubscriptions(['BALANCE_UPDATED', 'TRANSACTION_LOGGED'], () => loadLedger(), {
    debounce: 2000,
  });

  if (loading) {
    return (
      <div className="tlv-state sc-copy sc-copy--center" role="status" aria-live="polite">
        Loading Transactions...
      </div>
    );
  }

  if (denied) {
    return (
      <div className="tlv-state sc-copy sc-copy--center sc-ink--muted">
        This Ledger Is Available To Club Owners, Admins And Super Agents.
      </div>
    );
  }

  if (error) {
    return (
      <div className="tlv-state sc-copy sc-copy--center sc-ink--red" role="alert">
        <div>{error}</div>
        <button type="button" onClick={() => loadLedger()} className="tlv-word sc-ink--white">
          Try Again
        </button>
      </div>
    );
  }

  if (entries.length === 0) {
    return (
      <div className="tlv-state sc-copy sc-copy--center sc-ink--muted">No Transactions Yet</div>
    );
  }

  return (
    <section className="tlv" aria-label={formatPopupText(title)}>
      <div className="tlv-count sc-label sc-ink--muted">
        {entries.length} Transaction{entries.length !== 1 ? 's' : ''} Shown
      </div>
      <ol className="tlv-list">
        {entries.map((e) => {
          const timeStr = new Date(e.created_at).toLocaleString();
          const copy = visibleLedgerCopy(e);

          return (
            <li key={e.id} className="tlv-row" data-category={copy.category}>
              <div className="tlv-detail">
                <div className="tlv-category sc-label sc-ink--blue">{copy.category}</div>
                <div className="tlv-path sc-copy">{copy.path}</div>
                {copy.description && (
                  <div className="tlv-description sc-ink--muted">{copy.description}</div>
                )}
              </div>
              <div className="tlv-amount">
                <div className="tlv-value sc-ink--silver">{compactChips(Number(e.amount))}</div>
                <time className="tlv-time sc-ink--muted" dateTime={e.created_at}>
                  {timeStr}
                </time>
              </div>
            </li>
          );
        })}
      </ol>
    </section>
  );
}
