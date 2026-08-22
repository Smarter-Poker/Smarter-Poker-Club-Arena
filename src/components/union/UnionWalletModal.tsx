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

export type UnionWalletKey = 'chips' | 'rake' | 'bbj' | 'promo';

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

  // The chip SOURCE follows the wallet that was clicked. BBJ is a reserve, so
  // chips sent from its modal draw on the main bank.
  const chipSource = walletKey === 'rake' ? 'rake' : walletKey === 'promo' ? 'promo' : 'chips';

  useEffect(() => {
    if (!isOpen) return;
    setNotice(null);
    setTarget(null);
    setAmount('');
    setKind(walletKey === 'promo' ? 'promo' : 'chips');
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
    setBusy(true);
    setNotice(null);
    const { data, error } = await supabase.rpc('fn_union_send_to_member', {
      p_union_id: unionId,
      p_target_user_id: target.user_id,
      p_kind: kind,
      p_amount: amt,
      p_source_wallet: kind === 'chips' ? chipSource : null,
      p_note: `${walletLabel} → ${target.display_name || target.username || 'member'}`,
    });
    const res = (data ?? {}) as { success?: boolean; error?: string };
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
      setAmount('');
      onSent?.();
    }
    setBusy(false);
  }, [amount, target, busy, unionId, kind, chipSource, walletLabel, onSent]);

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
        <div style={{ color: '#4599FF', fontSize: 26, fontWeight: 800, marginBottom: 2 }}>
          {fmt(balance)}
        </div>
        <p style={{ color: '#888', fontSize: 12, margin: '0 0 14px' }}>
          Send chips, diamonds or promo funds to any member of the union.
          {walletKey === 'bbj' && ' BBJ funds are reserved for jackpots, so chips sent here draw on the main bank.'}
        </p>

        {/* Kind selector */}
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

        {/* Member picker */}
        <input
          className="admin-input"
          style={{ width: '100%', marginBottom: 8 }}
          placeholder="Search members by name or club…"
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
            <div style={{ padding: 14, color: '#888', fontSize: 13 }}>Loading roster…</div>
          ) : filtered.length === 0 ? (
            <div style={{ padding: 14, color: '#888', fontSize: 13 }}>No members match.</div>
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
                  background: target?.user_id === r.user_id ? 'rgba(69,153,255,0.18)' : 'transparent',
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
