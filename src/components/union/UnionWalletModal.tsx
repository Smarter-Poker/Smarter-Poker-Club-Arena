/**
 *  UNION WALLET MODAL — open a union wallet, send funds to any union member or club
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Dan 2026-08-22: "WHEN OWNER, CO OWNER OR ADMIN CLICKS ON ANY OF THE WALLETS
 * IT SHOULD OPEN UP, AND THEY BE ABLE TO SEND CHIPS, DIAMONDS OR PROMO FUNDS
 * TO ANY MEMBER OF THE UNION."
 *
 * Dan 2026-08-27: "pull and send chips to any club, club wallet, player wallet
 * or agent wallet from the union bank wallet, or promo wallet"
 *
 * The member list is the union-wide roster (fn_union_player_directory): every
 * player of every member club, with their role. We also fetch union_clubs to
 * support sending to and clawing back from clubs.
 *
 * The BBJ wallet is a jackpot reserve — fn_union_chip_integrity_check audits
 * it — so it is not offered as a chip SOURCE. Opening it still gives the full
 * send flow, drawing on the main bank instead.
 */

import { useState, useEffect, useMemo, useCallback } from 'react';
import { supabase } from '../../lib/supabase';
import { reportError } from '../../utils/errorReporter';
import { fmt } from '../../utils/format';
import { unionApi } from '../../services/UnionApiService';

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
  const [mode, setMode] = useState<'send' | 'pull'>('send');
  const [clubs, setClubs] = useState<Array<{ id: string; name: string }>>([]);
  const [roster, setRoster] = useState<RosterRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [search, setSearch] = useState('');
  const [target, setTarget] = useState<
    | { type: 'member'; data: RosterRow }
    | { type: 'club'; data: { id: string; name: string } }
    | null
  >(null);
  const [kind, setKind] = useState<SendKind>(walletKey === 'promo' ? 'promo' : 'chips');
  const [amount, setAmount] = useState('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null);
  const [liveBalance, setLiveBalance] = useState(balance);
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

  const chipSource = walletKey === 'rake' ? 'rake' : walletKey === 'promo' ? 'promo' : 'chips';

  useEffect(() => {
    if (!isOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [isOpen, onClose]);

  const readOnly = walletKey === 'spin_reserve';

  useEffect(() => {
    if (!isOpen) return;
    setNotice(null);
    setTarget(null);
    setAmount('');
    setLiveBalance(balance);
    setKind(walletKey === 'promo' ? 'promo' : 'chips');

    if (readOnly) {
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
      setClubs([]);
      setLoading(false);
      return;
    }
    setReserveLedger([]);
    void supabase
      .from('chip_transactions')
      .select('id, amount, notes, transaction_type, created_at')
      .contains('metadata', { union_id: unionId })
      .in('transaction_type', ['union_member_send', 'union_promo_send'])
      .order('created_at', { ascending: false })
      .limit(8)
      .then(({ data }) => setRecent((data as typeof recent) || []));

    setLoading(true);
    void Promise.all([
      supabase.rpc('fn_union_player_directory', { p_union_id: unionId }),
      supabase.from('union_clubs').select('*, clubs:club_id(*)').eq('union_id', unionId),
    ]).then(([rosterRes, clubsRes]) => {
      if (rosterRes.error) {
        reportError(rosterRes.error, 'UnionWalletModal.roster_load_failed');
        setNotice({ ok: false, text: 'Could not load the union roster.' });
        setRoster([]);
      } else {
        setRoster((rosterRes.data as RosterRow[]) || []);
      }

      if (clubsRes.data) {
        const enriched = clubsRes.data.map((uc: any) => ({
          id: uc.club_id,
          name: uc.clubs?.name || 'Unknown Club',
        }));
        setClubs(enriched);
      }
      setLoading(false);
    });
  }, [isOpen, unionId, walletKey]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();

    const matchedClubs = q ? clubs.filter((c) => c.name.toLowerCase().includes(q)) : clubs;

    const matchedRoster = q
      ? roster.filter(
          (r) =>
            (r.display_name || '').toLowerCase().includes(q) ||
            (r.username || '').toLowerCase().includes(q) ||
            (r.club_name || '').toLowerCase().includes(q)
        )
      : roster;

    const sortedRoster = [...matchedRoster].sort(
      (a, b) =>
        (ROLE_ORDER[a.member_role || 'member'] ?? 9) - (ROLE_ORDER[b.member_role || 'member'] ?? 9)
    );

    return { clubs: matchedClubs, roster: sortedRoster };
  }, [clubs, roster, search]);

  const send = useCallback(async () => {
    const amt = Number(amount);
    if (!target || !Number.isFinite(amt) || amt <= 0 || busy) return;
    if (kind === 'diamonds' && amt !== Math.floor(amt)) {
      setNotice({ ok: false, text: 'Diamonds must be a whole number.' });
      return;
    }
    setBusy(true);
    setNotice(null);

    try {
      if (mode === 'send') {
        if (target.type === 'member') {
          const { data, error } = await supabase.rpc('fn_union_send_to_member', {
            p_union_id: unionId,
            p_target_user_id: target.data.user_id,
            p_kind: kind,
            p_amount: amt,
            p_source_wallet: kind === 'chips' ? chipSource : null,
            p_note: `${walletLabel} to ${target.data.display_name || target.data.username || 'member'}`,
          });
          const res = (data ?? {}) as { success?: boolean; error?: string; wallet_after?: number };
          if (error || !res.success)
            throw new Error(error?.message || res.error || 'union send failed');
          setNotice({
            ok: true,
            text: `Sent ${fmt(amt)} ${kind} to ${target.data.display_name || target.data.username}.`,
          });
          if (res.wallet_after != null) setLiveBalance(res.wallet_after);
        } else {
          await unionApi.sendToClub(unionId, target.data.id, amt, `${walletLabel} to club`);
          setNotice({ ok: true, text: `Sent ${fmt(amt)} chips to ${target.data.name}.` });
          setLiveBalance((prev) => prev - amt);
        }
      } else {
        if (target.type === 'member') {
          throw new Error('Member clawbacks must be performed by the club owner.');
        } else {
          const { data: cbRes, error: cbErr } = await supabase.rpc('fn_union_clawback_from_club', {
            p_union_id: unionId,
            p_club_id: target.data.id,
            p_amount: amt,
            p_notes: 'Union clawback',
          });
          if (cbErr) throw new Error(cbErr.message || 'Clawback failed');
          if (cbRes && (cbRes as any).success === false) {
            const msg = (cbRes as any).error || 'Clawback failed';
            throw new Error(
              msg.includes('insufficient') ? 'Club has insufficient treasury balance' : msg
            );
          }
          setNotice({ ok: true, text: `Clawed back ${fmt(amt)} chips from ${target.data.name}.` });
          setLiveBalance((prev) => prev + amt);
        }
      }
      setAmount('');
      if (onSent) onSent();
    } catch (err: any) {
      reportError(err, 'UnionWalletModal.action_failed');
      setNotice({ ok: false, text: err.message || 'The action was refused.' });
    } finally {
      setBusy(false);
    }
  }, [amount, target, busy, kind, mode, unionId, chipSource, walletLabel, onSent]);

  if (!isOpen) return null;

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 9999,
        background: 'rgba(0,0,0,0.65)',
        backdropFilter: 'blur(3px)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 20,
      }}
      onClick={onClose}
    >
      <div
        style={{
          background: '#191b28',
          border: '1px solid rgba(255,255,255,0.08)',
          boxShadow: '0 24px 60px rgba(0,0,0,0.4)',
          borderRadius: 16,
          width: '100%',
          maxWidth: 420,
          padding: 20,
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'flex-start',
            marginBottom: 20,
          }}
        >
          <div>
            <h2 style={{ margin: '0 0 4px', fontSize: 20, color: '#fff' }}>{walletLabel}</h2>

            <p style={{ color: '#888', fontSize: 12, margin: '0 0 14px' }}>
              {readOnly ? (
                <>
                  The Capital Every Spin Bonus Pool Is Seeded From, And Every Spin Prize Is Paid Out
                  Of. It Is Not A Send Source: Add Funds With Fund Spin Reserve On The Wallet Tab.
                </>
              ) : (
                <>
                  Send Chips, Diamonds Or Promo Funds To Any Member Of The Union.
                  {walletKey === 'bbj' &&
                    ' BBJ funds are reserved for jackpots, so chips sent here draw on the main bank.'}
                </>
              )}
            </p>

            <div style={{ color: '#4599FF', fontSize: 16, fontWeight: 700 }}>
              {fmt(liveBalance)}
            </div>
          </div>
          <button
            onClick={onClose}
            style={{
              background: 'transparent',
              border: 'none',
              color: '#888',
              fontSize: 24,
              cursor: 'pointer',
              lineHeight: 1,
              padding: '0 4px',
            }}
          >
            ×
          </button>
        </div>

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

        {!readOnly && (
          <>
            <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
              <button
                style={{
                  flex: 1,
                  padding: '8px',
                  borderRadius: '6px',
                  border: 'none',
                  background: mode === 'send' ? 'rgba(69,153,255,0.2)' : 'rgba(255,255,255,0.05)',
                  color: mode === 'send' ? '#4599FF' : '#888',
                  fontWeight: mode === 'send' ? 700 : 500,
                  cursor: 'pointer',
                }}
                onClick={() => {
                  setMode('send');
                  setTarget(null);
                  setNotice(null);
                }}
              >
                Send
              </button>
              <button
                style={{
                  flex: 1,
                  padding: '8px',
                  borderRadius: '6px',
                  border: 'none',
                  background: mode === 'pull' ? 'rgba(239,68,68,0.2)' : 'rgba(255,255,255,0.05)',
                  color: mode === 'pull' ? '#ef4444' : '#888',
                  fontWeight: mode === 'pull' ? 700 : 500,
                  cursor: 'pointer',
                }}
                onClick={() => {
                  setMode('pull');
                  setTarget(null);
                  setNotice(null);
                }}
              >
                Pull (Clawback)
              </button>
            </div>

            <input
              className="admin-input"
              style={{ width: '100%', marginBottom: 8 }}
              placeholder="Search Clubs Or Members…"
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
                <div style={{ padding: 14, color: '#888', fontSize: 13 }}>Loading Directory…</div>
              ) : filtered.clubs.length === 0 && filtered.roster.length === 0 ? (
                <div style={{ padding: 14, color: '#888', fontSize: 13 }}>No Targets Match.</div>
              ) : (
                <>
                  {filtered.clubs.map((c) => (
                    <button
                      key={`club-${c.id}`}
                      onClick={() => setTarget({ type: 'club', data: c })}
                      aria-pressed={target?.type === 'club' && target.data.id === c.id}
                      style={{
                        display: 'flex',
                        width: '100%',
                        alignItems: 'center',
                        gap: 10,
                        padding: '8px 12px',
                        background:
                          target?.type === 'club' && target.data.id === c.id
                            ? mode === 'pull'
                              ? 'rgba(239,68,68,0.18)'
                              : 'rgba(69,153,255,0.18)'
                            : 'transparent',
                        border: 'none',
                        borderBottom: '1px solid rgba(255,255,255,0.05)',
                        cursor: 'pointer',
                        textAlign: 'left',
                      }}
                    >
                      <span style={{ color: '#fff', fontSize: 13, fontWeight: 700, flex: 1 }}>
                        {c.name}
                      </span>
                      <span
                        style={{
                          fontSize: 10,
                          fontWeight: 700,
                          letterSpacing: '0.06em',
                          color: '#C084FC',
                          background: 'rgba(192,132,252,0.15)',
                          padding: '2px 6px',
                          borderRadius: '4px',
                        }}
                      >
                        CLUB TREASURY
                      </span>
                    </button>
                  ))}
                  {filtered.roster.slice(0, 200).map((r) => {
                    const isDisabled = mode === 'pull';
                    return (
                      <button
                        key={`${r.user_id}-${r.club_id}`}
                        onClick={() => !isDisabled && setTarget({ type: 'member', data: r })}
                        disabled={isDisabled}
                        title={
                          isDisabled
                            ? 'Member Clawbacks Must Be Performed By The Club Owner.'
                            : undefined
                        }
                        aria-pressed={
                          target?.type === 'member' && target.data.user_id === r.user_id
                        }
                        style={{
                          display: 'flex',
                          width: '100%',
                          alignItems: 'center',
                          gap: 10,
                          padding: '8px 12px',
                          background:
                            target?.type === 'member' && target.data.user_id === r.user_id
                              ? 'rgba(69,153,255,0.18)'
                              : 'transparent',
                          border: 'none',
                          borderBottom: '1px solid rgba(255,255,255,0.05)',
                          cursor: isDisabled ? 'not-allowed' : 'pointer',
                          textAlign: 'left',
                          opacity: isDisabled ? 0.4 : 1,
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
                    );
                  })}
                </>
              )}
            </div>

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
                style={mode === 'pull' ? { background: '#ef4444', color: '#fff' } : {}}
                disabled={!target || !(Number(amount) > 0) || busy}
                onClick={() => void send()}
              >
                {busy
                  ? mode === 'send'
                    ? 'Sending…'
                    : 'Pulling…'
                  : target
                    ? mode === 'send'
                      ? `Send to ${target.type === 'club' ? target.data.name : target.data.display_name || target.data.username}`
                      : `Pull from ${target.type === 'club' ? target.data.name : 'Target'}`
                    : 'Pick a member or club'}
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
