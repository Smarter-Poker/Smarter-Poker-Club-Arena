/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  UNION TREASURY DETAIL — the expanded view behind a treasury tile
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Dan 2026-08-24:
 *   "rake treasury should open up to see all the data for all rake accumulated"
 *   "back up BBJ needs to be clickable, and funds are allowed to be moved to
 *    the promo fund or to the main BBJ if the owner chooses too"
 *   "back up BBJ needs to be clickable as well and expand to see data and
 *    transaction history and stats etc"
 *   "the same way we track 'rake credited to players' we should be tracking
 *    the BBJ the same way so agents, clubs and union know who accredited what
 *    to the BBJ, back up BBJ and promo fund"
 *
 * Three modes, one shell, because they answer the same three questions in the
 * same order — what is in the bank, where did it come from, what moved:
 *
 *   'rake'   — wallet balance vs the lifetime ledger, plus the drift between
 *              them, 30 days by day and by club, and recent wallet rows.
 *   'bbj'    — the three jackpot banks, the live split against the 50/25/25
 *              house rule, who was credited for funding them, and movements.
 *   'backup' — the same BBJ payload, opened on the backup bank, with the
 *              transfer control that moves backup into main or into promo.
 *
 * WHY 'backup' IS NOT A SEPARATE FETCH: main, backup and promo are three
 * columns of ONE bbj_pools row. Fetching them separately would let the panel
 * show a backup figure from one instant and a main figure from another, and
 * the 50/25/25 split is meaningless across two reads.
 *
 * WHY THE TRANSFER CONTROL LIVES HERE AND NOT IN UnionWalletModal: that modal
 * sends chips TO A MEMBER. This moves money between the union's own banks and
 * never leaves the union. They share no destination, no validation and no
 * confirmation copy.
 *
 * NUMBERS THIS PANEL DELIBERATELY DOES NOT RECONCILE
 * `drift` (wallet minus ledger net) is shown, never corrected. The audit of
 * 2026-08-23 recorded a real 757.18 divergence; a panel that quietly displayed
 * one of the two figures would have hidden it. Same for splitPct: the 50/25/25
 * rule governs each ALLOCATION, and payouts come out of main only, so a healthy
 * pool drifts away from 50/25/25 as it pays. It is reported, not asserted.
 *
 * `player_hands` is not a hand count. The daily rollups behind these reports are
 * keyed (club_id, day, user_id), so summing their per-player hands across
 * players yields player-hands. The column is named for what it is.
 */
import { useState, useEffect, useCallback } from 'react';
import type { CSSProperties, ReactNode } from 'react';
import { reportError } from '../../utils/errorReporter';
import { fmt } from '../../utils/format';
import unionApi from '../../services/UnionApiService';

export type TreasuryDetailMode = 'rake' | 'bbj' | 'backup';

export interface UnionTreasuryDetailModalProps {
  isOpen: boolean;
  onClose: () => void;
  unionId: string;
  mode: TreasuryDetailMode;
  /** Called after any successful transfer so the dashboard can refetch. */
  onMoved?: () => void;
  /** Opens the send-to-member modal for this wallet. Omit to hide the control. */
  onSendFrom?: () => void;
}

interface TxRow {
  id: string;
  wallet?: string;
  direction: string;
  amount: number;
  tx_type: string;
  notes: string | null;
  created_at: string;
  clubs?: { name: string } | null;
}

interface RakeDetail {
  balance: number;
  updatedAt: string | null;
  windowDays: number;
  ledger: {
    credits: number;
    debits: number;
    net: number;
    rowsSeen: number;
    asOf: string | null;
    lastVerifiedAt: string | null;
    throughDay: string | null;
  } | null;
  drift: number | null;
  byDay: { day: string; rake: number; players: number; player_hands: number }[];
  byClub: {
    club_id: string;
    club_name: string;
    rake: number;
    players: number;
    player_hands: number;
  }[];
  transactions: TxRow[];
}

interface BbjDetail {
  poolId: string | null;
  banks: { main: number; backup: number; promo: number; total: number };
  splitPct: { main: number; backup: number; promo: number } | null;
  allocatedLifetime: number;
  updatedAt: string | null;
  creditedBy: {
    user_id: string;
    username: string;
    club_name: string;
    agent_name: string | null;
    bbj_amount: number;
    main_amount: number;
    backup_amount: number;
    promo_amount: number;
    hands: number;
  }[];
  byDay: {
    day: string;
    bbj: number;
    main: number;
    backup: number;
    promo: number;
    players: number;
    player_hands: number;
  }[];
  transactions: TxRow[];
}

const CARD: CSSProperties = {
  background: 'rgba(255,255,255,0.04)',
  border: '1px solid rgba(255,255,255,0.08)',
  borderRadius: 10,
  padding: 12,
};

const TH: CSSProperties = {
  textAlign: 'left',
  padding: '6px 8px',
  color: 'rgba(255,255,255,0.5)',
  fontSize: 11,
  textTransform: 'uppercase',
  letterSpacing: '0.4px',
  whiteSpace: 'nowrap',
};

const TD: CSSProperties = {
  padding: '6px 8px',
  color: 'rgba(255,255,255,0.85)',
  fontSize: 12,
  borderTop: '1px solid rgba(255,255,255,0.06)',
  whiteSpace: 'nowrap',
};

/** Dates render in the viewer's locale; the API sends ISO 8601 UTC. */
function when(iso: string | null | undefined): string {
  if (!iso) return '-';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '-' : d.toLocaleString();
}

function Stat({ label, value, color }: { label: string; value: string; color: string }) {
  return (
    <div style={{ ...CARD, textAlign: 'center', flex: '1 1 120px' }}>
      <div style={{ color, fontSize: 20, fontWeight: 800 }}>{value}</div>
      <div
        style={{
          color: 'rgba(255,255,255,0.5)',
          fontSize: 10,
          textTransform: 'uppercase',
          letterSpacing: '0.5px',
          marginTop: 2,
        }}
      >
        {label}
      </div>
    </div>
  );
}

/** These tables are wider than 375px. The page must never scroll sideways. */
function Scroller({ children }: { children: ReactNode }) {
  return <div style={{ overflowX: 'auto', marginTop: 8 }}>{children}</div>;
}

function TxTable({ rows, heading }: { rows: TxRow[]; heading: string }) {
  return (
    <>
      <h4 style={{ color: '#fff', fontSize: 13, margin: '16px 0 0' }}>{heading}</h4>
      <Scroller>
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead>
            <tr>
              <th style={TH}>When</th>
              <th style={TH}>Type</th>
              <th style={TH}>Club</th>
              <th style={{ ...TH, textAlign: 'right' }}>Amount</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const inbound = r.direction === 'credit';
              return (
                <tr key={r.id}>
                  <td style={TD}>{when(r.created_at)}</td>
                  <td style={TD}>{r.tx_type}</td>
                  <td style={TD}>{r.clubs?.name || '-'}</td>
                  <td style={{ ...TD, textAlign: 'right', color: inbound ? '#39d17a' : '#ff6b6b' }}>
                    {inbound ? '+' : '-'}
                    {fmt(r.amount)}
                  </td>
                </tr>
              );
            })}
            {rows.length === 0 && (
              <tr>
                <td style={TD} colSpan={4}>
                  No Movements Recorded.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </Scroller>
    </>
  );
}

export default function UnionTreasuryDetailModal({
  isOpen,
  onClose,
  unionId,
  mode,
  onMoved,
  onSendFrom,
}: UnionTreasuryDetailModalProps) {
  const [loading, setLoading] = useState(false);
  const [rake, setRake] = useState<RakeDetail | null>(null);
  const [bbj, setBbj] = useState<BbjDetail | null>(null);
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null);

  const [amount, setAmount] = useState('');
  const [dest, setDest] = useState<'main' | 'promo'>('main');
  const [busy, setBusy] = useState(false);

  const isBbj = mode === 'bbj' || mode === 'backup';

  const load = useCallback(async () => {
    if (!unionId) return;
    setLoading(true);
    setNotice(null);
    try {
      if (isBbj) {
        const d = await unionApi.bbjDetail(unionId);
        setBbj(d as unknown as BbjDetail);
      } else {
        const d = await unionApi.rakeDetail(unionId);
        setRake(d as unknown as RakeDetail);
      }
    } catch (e) {
      reportError(e, 'UnionTreasuryDetail.load');
      setNotice({
        ok: false,
        text: e instanceof Error ? e.message : 'Could Not Load This Treasury.',
      });
    }
    setLoading(false);
  }, [unionId, isBbj]);

  useEffect(() => {
    if (isOpen) void load();
  }, [isOpen, load]);

  // Escape closes. Bound only while open so it cannot swallow the key from
  // whatever is underneath.
  useEffect(() => {
    if (!isOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [isOpen, onClose]);

  const moveBackup = useCallback(async () => {
    const amt = Number(amount);
    if (!Number.isFinite(amt) || amt <= 0) {
      setNotice({ ok: false, text: 'Enter An Amount Greater Than Zero.' });
      return;
    }
    const available = bbj?.banks.backup ?? 0;
    if (amt > available) {
      // Checked here for a fast, specific message. fn_union_bbj_backup_transfer
      // checks it again inside the transaction, and that is the one that counts.
      setNotice({ ok: false, text: `Backup Holds Only ${fmt(available)}.` });
      return;
    }
    setBusy(true);
    setNotice(null);
    try {
      const res = await unionApi.bbjBackupTransfer(unionId, amt, dest);
      setNotice({ ok: true, text: String(res.message || 'Transfer Complete.') });
      setAmount('');
      await load();
      onMoved?.();
    } catch (e) {
      reportError(e, 'UnionTreasuryDetail.backupTransfer');
      setNotice({ ok: false, text: e instanceof Error ? e.message : 'Transfer Failed.' });
    }
    setBusy(false);
  }, [amount, dest, bbj, unionId, load, onMoved]);

  if (!isOpen) return null;

  const title =
    mode === 'rake' ? 'Rake Treasury' : mode === 'backup' ? 'Backup Jackpot' : 'Jackpot Banks';

  return (
    <div
      className="admin-modal-overlay"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label={title}
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
          width: 'min(720px, 100%)',
          maxHeight: '88vh',
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
            marginBottom: 12,
            gap: 8,
          }}
        >
          <h3 style={{ margin: 0, color: '#fff', fontSize: 17 }}>{title}</h3>
          <div style={{ display: 'flex', gap: 8 }}>
            {onSendFrom && (
              <button className="admin-btn admin-btn-ghost admin-btn-sm" onClick={onSendFrom}>
                Send From This Wallet
              </button>
            )}
            <button className="admin-btn admin-btn-ghost admin-btn-sm" onClick={onClose}>
              Close
            </button>
          </div>
        </div>

        {notice && (
          <div
            style={{
              ...CARD,
              marginBottom: 12,
              borderColor: notice.ok ? 'rgba(57,209,122,0.4)' : 'rgba(255,107,107,0.4)',
              color: notice.ok ? '#39d17a' : '#ff6b6b',
              fontSize: 13,
            }}
          >
            {notice.text}
          </div>
        )}

        {loading && (
          <div style={{ color: 'rgba(255,255,255,0.6)', padding: '24px 0', textAlign: 'center' }}>
            Loading...
          </div>
        )}

        {/* ═══════════ RAKE ═══════════ */}
        {!loading && mode === 'rake' && rake && (
          <>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <Stat label="Wallet Balance" value={fmt(rake.balance)} color="#31A24C" />
              <Stat label="Ledger Credits" value={fmt(rake.ledger?.credits ?? 0)} color="#4599FF" />
              <Stat label="Ledger Debits" value={fmt(rake.ledger?.debits ?? 0)} color="#F7C52A" />
              <Stat
                label="Drift"
                value={rake.drift === null ? '-' : fmt(rake.drift)}
                color={rake.drift ? '#ff6b6b' : '#39d17a'}
              />
            </div>
            <p style={{ color: 'rgba(255,255,255,0.45)', fontSize: 11, marginTop: 8 }}>
              Drift Is The Wallet Balance Minus The Ledger Net. It Is Reported, Not Corrected. A Non
              Zero Value Means The Two Records Disagree And Someone Should Look.
              {rake.ledger?.asOf ? ` Ledger As Of ${when(rake.ledger.asOf)}.` : ''}
            </p>

            <h4 style={{ color: '#fff', fontSize: 13, margin: '16px 0 0' }}>
              By Club, Last {rake.windowDays} Days
            </h4>
            <Scroller>
              <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                <thead>
                  <tr>
                    <th style={TH}>Club</th>
                    <th style={{ ...TH, textAlign: 'right' }}>Rake</th>
                    <th style={{ ...TH, textAlign: 'right' }}>Players</th>
                    <th style={{ ...TH, textAlign: 'right' }}>Player Hands</th>
                  </tr>
                </thead>
                <tbody>
                  {rake.byClub.map((c) => (
                    <tr key={c.club_id}>
                      <td style={TD}>{c.club_name}</td>
                      <td style={{ ...TD, textAlign: 'right' }}>{fmt(c.rake)}</td>
                      <td style={{ ...TD, textAlign: 'right' }}>{fmt(c.players)}</td>
                      <td style={{ ...TD, textAlign: 'right' }}>{fmt(c.player_hands)}</td>
                    </tr>
                  ))}
                  {rake.byClub.length === 0 && (
                    <tr>
                      <td style={TD} colSpan={4}>
                        No Rake In This Window.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </Scroller>

            <h4 style={{ color: '#fff', fontSize: 13, margin: '16px 0 0' }}>
              By Day{rake.ledger?.throughDay ? ` Through ${rake.ledger.throughDay}` : ''}
            </h4>
            <Scroller>
              <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                <thead>
                  <tr>
                    <th style={TH}>Day</th>
                    <th style={{ ...TH, textAlign: 'right' }}>Rake</th>
                    <th style={{ ...TH, textAlign: 'right' }}>Players</th>
                    <th style={{ ...TH, textAlign: 'right' }}>Player Hands</th>
                  </tr>
                </thead>
                <tbody>
                  {rake.byDay.map((d) => (
                    <tr key={d.day}>
                      <td style={TD}>{d.day}</td>
                      <td style={{ ...TD, textAlign: 'right' }}>{fmt(d.rake)}</td>
                      <td style={{ ...TD, textAlign: 'right' }}>{fmt(d.players)}</td>
                      <td style={{ ...TD, textAlign: 'right' }}>{fmt(d.player_hands)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Scroller>

            <TxTable rows={rake.transactions} heading="Recent Rake Wallet Movements" />
          </>
        )}

        {/* ═══════════ BBJ / BACKUP ═══════════ */}
        {!loading && isBbj && bbj && (
          <>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <Stat label="Main Jackpot" value={fmt(bbj.banks.main)} color="#F7C52A" />
              <Stat label="Backup" value={fmt(bbj.banks.backup)} color="#4599FF" />
              {/* The POOL's promo bank (bbj_pools.promo_balance), which is NOT
                  the union Promo Wallet on the dashboard. Backup -> Promo
                  credits union_wallets.promo_wallet, so this figure does not
                  move when that transfer runs; labelled to say so. */}
              <Stat label="Pool Promo Bank" value={fmt(bbj.banks.promo)} color="#C084FC" />
              <Stat label="Banked Total" value={fmt(bbj.banks.total)} color="#39d17a" />
            </div>
            <p style={{ color: 'rgba(255,255,255,0.45)', fontSize: 11, marginTop: 8 }}>
              {bbj.splitPct
                ? `Live Split ${bbj.splitPct.main}% Main, ${bbj.splitPct.backup}% Backup, ${bbj.splitPct.promo}% Promo. `
                : ''}
              The 50/25/25 Rule Governs Each Allocation, And Payouts Come Out Of Main Only, So A
              Healthy Pool Drifts Away From It As It Pays. Allocated Lifetime{' '}
              {fmt(bbj.allocatedLifetime)}.
            </p>

            {mode === 'backup' && (
              <div style={{ ...CARD, marginTop: 16 }}>
                <h4 style={{ color: '#fff', fontSize: 13, margin: '0 0 4px' }}>
                  Move Money Out Of Backup
                </h4>
                <p style={{ color: 'rgba(255,255,255,0.45)', fontSize: 11, margin: '0 0 10px' }}>
                  Backup Can Top Up The Main Jackpot Or Become Promotional Budget. It Cannot Be Sent
                  To A Club: This Is Jackpot Money Owed To Players.
                </p>
                <p style={{ color: 'rgba(255,255,255,0.45)', fontSize: 11, margin: '0 0 10px' }}>
                  To Main Jackpot Moves Backup Into The Main Bank Above. To Promo Fund Credits The
                  Union Promo Wallet On The Dashboard, Which Is A Different Balance From The Pool
                  Promo Bank Shown Above, So That Tile Will Not Move.
                </p>
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
                  <select
                    className="admin-input"
                    style={{ maxWidth: 200 }}
                    value={dest}
                    onChange={(e) => setDest(e.target.value as 'main' | 'promo')}
                    aria-label="Destination"
                  >
                    <option value="main">To Main Jackpot</option>
                    <option value="promo">To Promo Fund</option>
                  </select>
                  <input
                    className="admin-input"
                    style={{ maxWidth: 160 }}
                    type="number"
                    min="0"
                    step="0.01"
                    inputMode="decimal"
                    placeholder="Amount"
                    value={amount}
                    onChange={(e) => setAmount(e.target.value)}
                    aria-label="Amount To Move"
                  />
                  <button
                    className="admin-btn admin-btn-primary"
                    disabled={busy || !amount}
                    onClick={() => void moveBackup()}
                  >
                    {busy ? 'Moving...' : 'Move Funds'}
                  </button>
                  <button
                    className="admin-btn admin-btn-ghost admin-btn-sm"
                    disabled={busy}
                    onClick={() => setAmount(String(bbj.banks.backup))}
                  >
                    Max
                  </button>
                </div>
              </div>
            )}

            <h4 style={{ color: '#fff', fontSize: 13, margin: '16px 0 0' }}>
              Credited To The Jackpot, Last 30 Days
            </h4>
            <p style={{ color: 'rgba(255,255,255,0.45)', fontSize: 11, margin: '2px 0 0' }}>
              Who Funded Each Bank, And Which Agent They Sit Under.
            </p>
            <Scroller>
              <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                <thead>
                  <tr>
                    <th style={TH}>Player</th>
                    <th style={TH}>Club</th>
                    <th style={TH}>Agent</th>
                    <th style={{ ...TH, textAlign: 'right' }}>Total</th>
                    <th style={{ ...TH, textAlign: 'right' }}>Main</th>
                    <th style={{ ...TH, textAlign: 'right' }}>Backup</th>
                    <th style={{ ...TH, textAlign: 'right' }}>Promo</th>
                    <th style={{ ...TH, textAlign: 'right' }}>Hands</th>
                  </tr>
                </thead>
                <tbody>
                  {bbj.creditedBy.map((r) => (
                    <tr key={`${r.user_id}-${r.club_name}`}>
                      <td style={TD}>{r.username}</td>
                      <td style={TD}>{r.club_name}</td>
                      <td style={TD}>{r.agent_name || '-'}</td>
                      <td style={{ ...TD, textAlign: 'right' }}>{fmt(r.bbj_amount)}</td>
                      <td style={{ ...TD, textAlign: 'right' }}>{fmt(r.main_amount)}</td>
                      <td style={{ ...TD, textAlign: 'right' }}>{fmt(r.backup_amount)}</td>
                      <td style={{ ...TD, textAlign: 'right' }}>{fmt(r.promo_amount)}</td>
                      <td style={{ ...TD, textAlign: 'right' }}>{fmt(r.hands)}</td>
                    </tr>
                  ))}
                  {bbj.creditedBy.length === 0 && (
                    <tr>
                      <td style={TD} colSpan={8}>
                        No Contributions In This Window.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </Scroller>

            <h4 style={{ color: '#fff', fontSize: 13, margin: '16px 0 0' }}>By Day</h4>
            <Scroller>
              <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                <thead>
                  <tr>
                    <th style={TH}>Day</th>
                    <th style={{ ...TH, textAlign: 'right' }}>Total</th>
                    <th style={{ ...TH, textAlign: 'right' }}>Main</th>
                    <th style={{ ...TH, textAlign: 'right' }}>Backup</th>
                    <th style={{ ...TH, textAlign: 'right' }}>Promo</th>
                    <th style={{ ...TH, textAlign: 'right' }}>Players</th>
                  </tr>
                </thead>
                <tbody>
                  {bbj.byDay.map((d) => (
                    <tr key={d.day}>
                      <td style={TD}>{d.day}</td>
                      <td style={{ ...TD, textAlign: 'right' }}>{fmt(d.bbj)}</td>
                      <td style={{ ...TD, textAlign: 'right' }}>{fmt(d.main)}</td>
                      <td style={{ ...TD, textAlign: 'right' }}>{fmt(d.backup)}</td>
                      <td style={{ ...TD, textAlign: 'right' }}>{fmt(d.promo)}</td>
                      <td style={{ ...TD, textAlign: 'right' }}>{fmt(d.players)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Scroller>

            <TxTable rows={bbj.transactions} heading="Recent Jackpot And Promo Movements" />
          </>
        )}
      </div>
    </div>
  );
}
