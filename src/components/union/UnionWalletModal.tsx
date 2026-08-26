/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  UNION WALLET MODAL — open a union wallet, send funds to any union member
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Dan 2026-08-22: "WHEN OWNER, CO OWNER OR ADMIN CLICKS ON ANY OF THE WALLETS
 * IT SHOULD OPEN UP, AND THEY BE ABLE TO SEND CHIPS, DIAMONDS OR PROMO FUNDS
 * TO ANY MEMBER OF THE UNION."
 *
 * Until this component existed the four wallet tiles on the union dashboard
 * were static <div>s — balances you could look at and nothing else. Moving
 * funds meant knowing which RPC to call by hand.
 *
 * The member list is the union-wide roster (fn_union_player_directory): every
 * player of every member club, with their role. Authorization is enforced
 * server-side by fn_union_send_to_member (owner / co-owner / admin only); this
 * UI additionally hides itself from non-admins.
 *
 * The BBJ wallet is a jackpot reserve — fn_union_chip_integrity_check audits
 * it — so it is not offered as a chip SOURCE. Opening it still gives the full
 * send flow, drawing on the main bank instead.
 */

import { useState, useEffect, useMemo, useCallback } from 'react';
import { supabase } from '../../lib/supabase';
import { reportError } from '../../utils/errorReporter';
import { fmt } from '../../utils/format';

/**
 * `spin_reserve` is READ-ONLY and behaves unlike the other four.
 *
 * It is the capital every Spin bonus pool is seeded from and every Spin prize
 * is paid out of, and spinSpec.ts prices the whole format on the pool being
 * net-neutral over volume: E[multiplier] = seats x (1 - rake). Handing an
 * operator a "send to member" button on it would let a single click break the
 * invariant the entire ladder is derived from - and it would do so silently,
 * because the pool's solvency is only ever read afterwards.
 *
 * So the reserve opens, shows its balance and its full ledger, and offers no
 * way to move money out. Money goes IN through the Fund Spin Reserve control
 * on the dashboard, which routes to fn_spin_reserve_wallet_fund_op and is
 * replay-protected; money comes OUT only when a Spin pays a player.
 */
export type UnionWalletKey = 'chips' | 'rake' | 'bbj' | 'promo' | 'spin_reserve';

export interface UnionWalletModalProps {
  isOpen: boolean;
  onClose: () => void;
  unionId: string;
  walletKey: UnionWalletKey;
  walletLabel: string;
  balance: number;
  /** Called after a successful send so the dashboard can refresh balances. */
  onSent?: () => void;
}

interface RosterRow {
  user_id: string;
  username: string | null;
  display_name: string | null;
  avatar_url: string | null;
  club_id: string;
  club_name: string | null;
  member_role: string | null;
  member_status: string | null;
}

type SendKind = 'chips' | 'diamonds' | 'promo';

const ROLE_ORDER: Record<string, number> = {
  owner: 0,
  co_owner: 1,
  admin: 2,
  super_agent: 3,
  agent: 4,
  member: 5,
};

export function UnionWalletModal({
  isOpen,
  onClose,
  unionId,
  walletKey,
  walletLabel,
  balance,
  onSent,
}: UnionWalletModalProps) {
  const [roster, setRoster] = useState<RosterRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [search, setSearch] = useState('');
  const [target, setTarget] = useState<RosterRow | null>(null);
  const [kind, setKind] = useState<SendKind>(walletKey === 'promo' ? 'promo' : 'chips');
  const [amount, setAmount] = useState('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null);
  /**
   * The header balance, kept live. The `balance` prop is a snapshot from when
   * the tile was clicked; after a send it would go stale while the modal is
   * still open, showing money that has already left. The RPC returns
   * `wallet_after` for chip/promo sends, so the display can follow the truth.
   */
  const [liveBalance, setLiveBalance] = useState(balance);
  /**
   * The reserve's own ledger. A different table from `recent` on purpose:
   * chip_transactions records member sends, while every movement of the Spin
   * reserve is written to union_wallet_transactions by the RPCs that seed,
   * fund and settle it. Reading the wrong one would show an empty feed on a
   * wallet that had been moving all day.
   */
  const [reserveLedger, setReserveLedger] = useState<
    Array<{
      id: string;
      amount: number;
      direction: string;
      tx_type: string;
      notes: string | null;
      balance_after: number | null;
      created_at: string;
    }>
  >([]);
  const [recent, setRecent] = useState<
    {
      id: string;
      amount: number;
      notes: string | null;
      transaction_type: string;
      created_at: string;
    }[]
  >([]);

  // The chip SOURCE follows the wallet that was clicked. BBJ is a reserve, so
  // chips sent from its modal draw on the main bank.
  const chipSource = walletKey === 'rake' ? 'rake' : walletKey === 'promo' ? 'promo' : 'chips';

  useEffect(() => {
    if (!isOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [isOpen, onClose]);

  /** The reserve is a balance to inspect, never a source to spend from. */
  const readOnly = walletKey === 'spin_reserve';

  useEffect(() => {
    if (!isOpen) return;
    setNotice(null);
    setTarget(null);
    setAmount('');
    setLiveBalance(balance);
    setKind(walletKey === 'promo' ? 'promo' : 'chips');

    if (readOnly) {
      // Its own ledger, and NOT the roster: with no send flow there is nobody
      // to pick, so the directory RPC is a round trip for a list this view
      // never renders.
      setRecent([]);
      void supabase
        .from('union_wallet_transactions')
        .select('id, amount, direction, tx_type, notes, balance_after, created_at')
        .eq('union_id', unionId)
        .eq('wallet', 'spin_reserve_wallet')
        .order('created_at', { ascending: false })
        .limit(25)
        .then(({ data, error }) => {
          if (error) {
            reportError(error, 'UnionWalletModal.reserve_ledger_load_failed');
            setNotice({ ok: false, text: 'Could Not Load The Spin Reserve Ledger.' });
          }
          setReserveLedger((data as typeof reserveLedger) || []);
        });
      setRoster([]);
      setLoading(false);
      return;
    }
    setReserveLedger([]);
    // Recent outbound sends from this union. RLS scopes this to what the
    // viewer may see (their own sends at minimum), so an empty feed is normal
    // for a brand-new admin.
    void supabase
      .from('chip_transactions')
      .select('id, amount, notes, transaction_type, created_at')
      .eq('club_id', unionId)
      .in('transaction_type', ['union_member_send', 'union_promo_send'])
      .order('created_at', { ascending: false })
      .limit(8)
      .then(({ data }) => setRecent((data as typeof recent) || []));
    setLoading(true);
    void supabase
      .rpc('fn_union_player_directory', { p_union_id: unionId })
      .then(({ data, error }) => {
        if (error) {
          reportError(error, 'UnionWalletModal.roster_load_failed');
          setNotice({ ok: false, text: 'Could not load the union roster.' });
          setRoster([]);
        } else {
          setRoster((data as RosterRow[]) || []);
        }
        setLoading(false);
      });
  }, [isOpen, unionId, walletKey]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    const rows = q
      ? roster.filter(
          (r) =>
            (r.display_name || '').toLowerCase().includes(q) ||
            (r.username || '').toLowerCase().includes(q) ||
            (r.club_name || '').toLowerCase().includes(q)
        )
      : roster;
    return [...rows].sort(
      (a, b) =>
        (ROLE_ORDER[a.member_role || 'member'] ?? 9) - (ROLE_ORDER[b.member_role || 'member'] ?? 9)
    );
  }, [roster, search]);

  const send = useCallback(async () => {
    const amt = Number(amount);
    if (!target || !Number.isFinite(amt) || amt <= 0 || busy) return;
    // Mirror of the server rule, surfaced before the round trip.
    if (kind === 'diamonds' && amt !== Math.floor(amt)) {
      setNotice({ ok: false, text: 'Diamonds must be a whole number.' });
      return;
    }
    setBusy(true);
    setNotice(null);
    const { data, error } = await supabase.rpc('fn_union_send_to_member', {
      p_union_id: unionId,
      p_target_user_id: target.user_id,
      p_kind: kind,
      p_amount: amt,
      p_source_wallet: kind === 'chips' ? chipSource : null,
      p_note: `${walletLabel} to ${target.display_name || target.username || 'member'}`,
    });
    const res = (data ?? {}) as { success?: boolean; error?: string; wallet_after?: number };
    if (error || !res.success) {
      reportError(
        new Error(error?.message || res.error || 'union send failed'),
        'UnionWalletModal.send_failed'
      );
      setNotice({ ok: false, text: error?.message || res.error || 'The send was refused.' });
    } else {
      setNotice({
        ok: true,
        text: `Sent ${fmt(amt)} ${kind} to ${target.display_name || target.username}.`,
      });
      // Keep the header honest while the modal stays open. `wallet_after` is
      // the source wallet's post-send figure; it only maps onto the header
      // when the wallet on screen IS the source (chips from the BBJ modal
      // draw on the main bank, and diamonds never touch a union wallet).
      if (typeof res.wallet_after === 'number' && kind !== 'diamonds' && walletKey !== 'bbj') {
        setLiveBalance(res.wallet_after);
      }
      setRecent((prev) =>
        [
          {
            id: `local-${Date.now()}`,
            amount: amt,
            notes: `${walletLabel} to ${target.display_name || target.username || 'member'}`,
            transaction_type: kind === 'promo' ? 'union_promo_send' : 'union_member_send',
            created_at: new Date().toISOString(),
          },
          ...prev,
        ].slice(0, 8)
      );
      setAmount('');
      onSent?.();
    }
    setBusy(false);
  }, [amount, target, busy, unionId, kind, chipSource, walletLabel, walletKey, onSent]);

  if (!isOpen) return null;

  return (
    <div
      className="admin-modal-overlay"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label={`${walletLabel} wallet`}
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 4000,
        background: 'rgba(0,0,0,0.7)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 16,
      }}
    >
      <div
        className="admin-card"
        onClick={(e) => e.stopPropagation()}
        style={{
          width: 'min(560px, 100%)',
          maxHeight: '85vh',
          overflowY: 'auto',
          padding: 20,
          background: '#12121c',
          border: '1px solid rgba(255,255,255,0.12)',
          borderRadius: 14,
        }}
      >
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'baseline',
            marginBottom: 4,
          }}
        >
          <h3 style={{ margin: 0, color: '#fff', fontSize: 17 }}>{walletLabel}</h3>
          <button className="admin-btn admin-btn-ghost admin-btn-sm" onClick={onClose}>
            Close
          </button>
        </div>
        <div
          style={{
            color: readOnly ? '#39d17a' : '#4599FF',
            fontSize: 26,
            fontWeight: 800,
            marginBottom: 2,
          }}
        >
          {fmt(liveBalance)}
        </div>
        <p style={{ color: '#888', fontSize: 12, margin: '0 0 14px' }}>
          {readOnly ? (
            <>
              The Capital Every Spin Bonus Pool Is Seeded From, And Every Spin Prize Is Paid Out Of.
              It Is Not A Send Source: Add Funds With Fund Spin Reserve On The Wallet Tab.
            </>
          ) : (
            <>
              Send Chips, Diamonds Or Promo Funds To Any Member Of The Union.
              {walletKey === 'bbj' &&
                ' BBJ funds are reserved for jackpots, so chips sent here draw on the main bank.'}
            </>
          )}
        </p>

        {/* Kind selector — hidden for the reserve, which has no send flow. */}
        {!readOnly && (
          <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
            {(['chips', 'diamonds', 'promo'] as SendKind[]).map((k) => (
              <button
                key={k}
                className={`admin-btn admin-btn-sm ${kind === k ? '' : 'admin-btn-ghost'}`}
                aria-pressed={kind === k}
                onClick={() => setKind(k)}
              >
                {k === 'chips' ? 'Chips' : k === 'diamonds' ? 'Diamonds' : 'Promo'}
              </button>
            ))}
          </div>
        )}

        {/* Member picker + amount + send — the whole outbound flow, which the
            reserve does not have. */}
        {!readOnly && (
          <>
            {/* Member picker */}
            <input
              className="admin-input"
              style={{ width: '100%', marginBottom: 8 }}
              placeholder="Search Members By Name Or Club…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
            <div
              style={{
                maxHeight: 220,
                overflowY: 'auto',
                border: '1px solid rgba(255,255,255,0.08)',
                borderRadius: 8,
                marginBottom: 12,
              }}
            >
              {loading ? (
                <div style={{ padding: 14, color: '#888', fontSize: 13 }}>Loading Roster…</div>
              ) : filtered.length === 0 ? (
                <div style={{ padding: 14, color: '#888', fontSize: 13 }}>No Members Match.</div>
              ) : (
                filtered.slice(0, 200).map((r) => (
                  <button
                    key={`${r.user_id}-${r.club_id}`}
                    onClick={() => setTarget(r)}
                    aria-pressed={target?.user_id === r.user_id}
                    style={{
                      display: 'flex',
                      width: '100%',
                      alignItems: 'center',
                      gap: 10,
                      padding: '8px 12px',
                      background:
                        target?.user_id === r.user_id ? 'rgba(69,153,255,0.18)' : 'transparent',
                      border: 'none',
                      borderBottom: '1px solid rgba(255,255,255,0.05)',
                      cursor: 'pointer',
                      textAlign: 'left',
                    }}
                  >
                    <span style={{ color: '#fff', fontSize: 13, fontWeight: 600, flex: 1 }}>
                      {r.display_name || r.username || r.user_id.slice(0, 8)}
                    </span>
                    <span
                      style={{
                        fontSize: 10,
                        fontWeight: 700,
                        letterSpacing: '0.06em',
                        color:
                          r.member_role === 'owner'
                            ? '#F7C52A'
                            : r.member_role === 'co_owner' || r.member_role === 'admin'
                              ? '#4599FF'
                              : r.member_role === 'agent' || r.member_role === 'super_agent'
                                ? '#31A24C'
                                : '#888',
                      }}
                    >
                      {(r.member_role || 'member').replace('_', ' ').toUpperCase()}
                    </span>
                    <span style={{ color: '#666', fontSize: 11 }}>{r.club_name || ''}</span>
                  </button>
                ))
              )}
            </div>

            {/* Amount + send */}
            <div style={{ display: 'flex', gap: 8 }}>
              <input
                className="admin-input"
                style={{ flex: '0 0 160px' }}
                type="number"
                min="1"
                placeholder="Amount"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
              />
              <button
                className="admin-btn"
                disabled={!target || !(Number(amount) > 0) || busy}
                onClick={() => void send()}
              >
                {busy
                  ? 'Sending…'
                  : target
                    ? `Send to ${target.display_name || target.username}`
                    : 'Pick a member'}
              </button>
            </div>
          </>
        )}

        {readOnly && (
          <div>
            <div
              style={{
                fontSize: 11,
                fontWeight: 700,
                letterSpacing: '0.07em',
                color: '#6b7392',
                marginBottom: 6,
              }}
            >
              RESERVE LEDGER
            </div>
            {reserveLedger.length === 0 ? (
              <p style={{ color: '#666', fontSize: 12, margin: '8px 0 0' }}>
                Nothing Has Moved Through This Wallet Yet. Seeding A Pool Or Funding The Reserve
                Writes A Row Here.
              </p>
            ) : (
              reserveLedger.map((r) => {
                const inbound = r.direction === 'credit';
                return (
                  <div
                    key={r.id}
                    style={{
                      display: 'flex',
                      justifyContent: 'space-between',
                      gap: 8,
                      padding: '6px 0',
                      borderBottom: '1px solid rgba(255,255,255,0.05)',
                      fontSize: 12,
                    }}
                  >
                    <span style={{ minWidth: 0 }}>
                      <span
                        style={{
                          color: '#ddd',
                          display: 'block',
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          whiteSpace: 'nowrap',
                        }}
                      >
                        {r.notes || r.tx_type}
                      </span>
                      <span style={{ color: '#6b7392', fontSize: 11 }}>
                        {new Date(r.created_at).toLocaleString()}
                        {r.balance_after != null && ` · balance ${fmt(r.balance_after)}`}
                      </span>
                    </span>
                    <span
                      style={{
                        color: inbound ? '#39d17a' : '#e74c3c',
                        fontWeight: 700,
                        flexShrink: 0,
                      }}
                    >
                      {inbound ? '+' : '-'}
                      {fmt(r.amount)}
                    </span>
                  </div>
                );
              })
            )}
          </div>
        )}

        {recent.length > 0 && (
          <div style={{ marginTop: 14 }}>
            <div
              style={{
                fontSize: 11,
                fontWeight: 700,
                letterSpacing: '0.07em',
                color: '#6b7392',
                marginBottom: 6,
              }}
            >
              RECENT SENDS
            </div>
            {recent.map((r) => (
              <div
                key={r.id}
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  gap: 8,
                  padding: '5px 0',
                  borderBottom: '1px solid rgba(255,255,255,0.05)',
                  fontSize: 12,
                }}
              >
                <span
                  style={{
                    color: '#aaa',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  }}
                >
                  {r.notes ||
                    (r.transaction_type === 'union_promo_send' ? 'Promo send' : 'Chip send')}
                </span>
                <span style={{ color: '#e74c3c', fontWeight: 700, flexShrink: 0 }}>
                  -{fmt(r.amount)}
                </span>
              </div>
            ))}
          </div>
        )}

        {notice && (
          <div
            role={notice.ok ? 'status' : 'alert'}
            style={{
              marginTop: 12,
              padding: '9px 12px',
              borderRadius: 8,
              fontSize: 13,
              background: notice.ok ? 'rgba(49,162,76,0.15)' : 'rgba(231,76,60,0.15)',
              border: `1px solid ${notice.ok ? 'rgba(49,162,76,0.5)' : 'rgba(231,76,60,0.5)'}`,
              color: notice.ok ? '#7ee2a0' : '#ffb4ab',
            }}
          >
            {notice.text}
          </div>
        )}
      </div>
    </div>
  );
}

export default UnionWalletModal;
