/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  PLAYER WALLET (Dan 2026-08-24, BINDING)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * "PLAYER WALLET NEEDS TO BE FULLY CLICKABLE AND OPEN TO SEE ALL TRANSACTIONS
 *  AND OTHER AVAILABLE DATA WHEN CLICKED."
 *
 * The wallet panel's Player Wallet row opens THIS: the viewer's own club
 * statement. Every chip movement they were a party to, newest first, with
 * received / sent / net totals and every balance they hold in the club.
 *
 * It reads through fn_my_wallet_ledger, which is auth.uid() scoped on the
 * server — it can only ever return the CALLER's own rows, so any active
 * member may open it and nobody can open anyone else's. This is a statement,
 * not a cashier: nothing here moves money.
 *
 * Styling rides on the cashier's cbc- classes so the two read as one family.
 */

import { useCallback, useEffect, useState } from 'react';
import { supabase } from '../../lib/supabase';
import { useAuthUser } from '../../hooks/useAuthUser';
import { useIsMounted } from '../../hooks/useIsMounted';
import { reportError } from '../../utils/errorReporter';
import { resolveClubUUID, isUUID } from '../../utils/clubIdResolver';
import { roleLabel } from '../../types/clubRoles';
import { canHoldAgentWallet } from './walletRows';
import './WalletCashierModal.css';

const PAGE = 40;

interface MyLedgerRow {
  id: string;
  created_at: string;
  amount: number;
  transaction_type: string;
  notes: string | null;
  metadata: Record<string, unknown> | null;
  is_reversed: boolean;
  direction: 'in' | 'out';
  from_name: string | null;
  to_name: string | null;
}

interface MyBalances {
  player_wallet: number;
  agent_wallet: number;
  promo_wallet: number;
}

interface MyTotals {
  received: number;
  sent: number;
  net: number;
}

interface PlayerWalletModalProps {
  isOpen: boolean;
  onClose: () => void;
  /** Club code or UUID. Resolved internally, same as the cashier. */
  clubId: string;
}

const fmt = (n: number) =>
  (Number.isFinite(n) ? n : 0).toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });

/** "Club Bank Send" from "club_bank_send". Popup and label casing law. */
function titleCase(raw: string): string {
  return raw
    .replace(/[_-]+/g, ' ')
    .split(' ')
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join(' ');
}

export default function PlayerWalletModal({ isOpen, onClose, clubId }: PlayerWalletModalProps) {
  const { user } = useAuthUser();
  const isMounted = useIsMounted();

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [role, setRole] = useState<string>('player');
  const [balances, setBalances] = useState<MyBalances | null>(null);
  const [totals, setTotals] = useState<MyTotals | null>(null);
  const [total, setTotal] = useState(0);
  const [rows, setRows] = useState<MyLedgerRow[]>([]);

  const load = useCallback(
    async (offset: number) => {
      if (!clubId) return;
      setLoading(true);
      if (offset === 0) setError(null);
      try {
        const uuid = await resolveClubUUID(clubId);
        if (!isMounted.current) return;
        if (!isUUID(uuid)) {
          setError('That Club Could Not Be Resolved');
          return;
        }
        const { data, error: rpcError } = await supabase.rpc('fn_my_wallet_ledger', {
          p_club_id: uuid,
          p_limit: PAGE,
          p_offset: offset,
        });
        if (rpcError) throw rpcError;
        const res = (Array.isArray(data) ? data[0] : data) as {
          authorized?: boolean;
          error?: string;
          role?: string;
          total?: number;
          balances?: MyBalances;
          totals?: MyTotals;
          rows?: MyLedgerRow[];
        } | null;
        if (!isMounted.current) return;
        if (!res?.authorized) {
          setError(res?.error || 'Your Wallet Could Not Be Read');
          return;
        }
        setRole(res.role || 'player');
        setBalances(res.balances ?? null);
        setTotals(res.totals ?? null);
        setTotal(Number(res.total) || 0);
        setRows((prev) => (offset === 0 ? res.rows || [] : [...prev, ...(res.rows || [])]));
      } catch (e) {
        reportError(e, 'PlayerWalletModal.load');
        if (isMounted.current) setError('Could Not Load Your Wallet');
      } finally {
        if (isMounted.current) setLoading(false);
      }
    },
    [clubId, isMounted]
  );

  useEffect(() => {
    if (!isOpen || !user?.id) return;
    setRows([]);
    setTotal(0);
    setBalances(null);
    setTotals(null);
    load(0);
  }, [isOpen, user?.id, load]);

  // Escape closes, and the page behind stops scrolling — same manners as the
  // cashier, for the same reasons.
  useEffect(() => {
    if (!isOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = prevOverflow;
    };
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  const isAgentShaped = canHoldAgentWallet(role);

  return (
    <div
      className="cbc-overlay"
      role="dialog"
      aria-modal="true"
      aria-label="Player Wallet"
      onClick={onClose}
    >
      <div className="cbc-panel" onClick={(e) => e.stopPropagation()}>
        {/* ── Header ─────────────────────────────────────────────────────── */}
        <div className="cbc-head">
          <div>
            <div className="cbc-title">PLAYER WALLET</div>
          </div>
          <button className="cbc-x" onClick={onClose} aria-label="Close">
            &times;
          </button>
        </div>

        <div className="cbc-bank">
          <span>Player Wallet Balance</span>
          <strong aria-live="polite">
            {balances === null ? '...' : fmt(balances.player_wallet)}
          </strong>
        </div>

        <div className="cbc-body">
          {error && <div className="cbc-empty cbc-empty--bad">{error}</div>}

          {/* Every balance the member holds in this club. The agent rows only
              exist for agent-shaped roles — a plain player has one wallet and
              is shown one wallet. */}
          {!error && balances && (
            <div className="cbc-totals">
              <div>
                <span>Role</span>
                <strong>{roleLabel(role)}</strong>
              </div>
              {isAgentShaped && (
                <div>
                  <span>Agent Wallet</span>
                  <strong>{fmt(balances.agent_wallet)}</strong>
                </div>
              )}
              {isAgentShaped && (
                <div>
                  <span>Promo Wallet</span>
                  <strong>{fmt(balances.promo_wallet)}</strong>
                </div>
              )}
            </div>
          )}

          {!error && totals && (
            <div className="cbc-totals">
              <div>
                <span>Received</span>
                <strong className="cbc-in">{fmt(totals.received)}</strong>
              </div>
              <div>
                <span>Sent</span>
                <strong className="cbc-out">{fmt(totals.sent)}</strong>
              </div>
              <div>
                <span>Net</span>
                <strong>{fmt(totals.net)}</strong>
              </div>
            </div>
          )}

          {!error && (
            <div className="cbc-ledger-head">
              <span>{total.toLocaleString('en-US')} Transactions</span>
            </div>
          )}

          {!error &&
            rows.map((row) => (
              <div key={row.id} className={row.is_reversed ? 'cbc-tx cbc-tx--reversed' : 'cbc-tx'}>
                <div className="cbc-tx-top">
                  <span className="cbc-tx-type">{titleCase(row.transaction_type)}</span>
                  <span className="cbc-tx-amount">
                    {row.direction === 'in' ? '+' : '-'}
                    {fmt(row.amount)}
                  </span>
                </div>
                <div className="cbc-tx-mid">
                  <span>
                    {row.from_name || 'Club Bank'}
                    {' → '}
                    {row.to_name || 'Club Bank'}
                  </span>
                  <span className="cbc-tx-when">
                    {new Date(row.created_at).toLocaleString('en-US', {
                      month: 'short',
                      day: 'numeric',
                      hour: 'numeric',
                      minute: '2-digit',
                    })}
                  </span>
                </div>
                <div className="cbc-tx-foot">
                  {row.notes && <span>{row.notes}</span>}
                  {row.is_reversed && <span className="cbc-tx-rev">Reversed</span>}
                </div>
              </div>
            ))}

          {!error && !loading && rows.length === 0 && (
            <div className="cbc-empty">No Transactions Yet. Your Chip Movements Land Here.</div>
          )}
          {loading && <div className="cbc-empty">Loading Your Wallet...</div>}
          {!error && !loading && rows.length < total && (
            <button className="cbc-more" onClick={() => load(rows.length)}>
              Load More
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
