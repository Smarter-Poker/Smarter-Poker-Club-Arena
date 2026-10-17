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
 * ON THE CASHIER DESK (Dan's sweep, 2026-10-17). Every other union wallet
 * opens on WalletDesk; the treasury details were the last generic modal (a
 * rounded card of inline-styled tables). They now print as the desk's own
 * hairline rows, the same Close, the same painted dock, portaled to the page
 * body so no stacking context can put the bottom nav over it.
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
import { createPortal } from 'react-dom';
import { reportError } from '../../utils/errorReporter';
import { fmt, formatWalletChips } from '../../utils/format';
import { enumToTitleCase, titleCase } from '../../utils/titleCase';
import { exactChipFigure } from '../../utils/cashierAmount';
import unionApi from '../../services/UnionApiService';
import {
  WalletDesk,
  WalletDeskHeading,
  WalletDeskRow,
  type WalletDeskAction,
} from '../wallet/WalletDesk';
import '../wallet/WalletDesk.css';

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

/** Dates render in the viewer's locale; the API sends ISO 8601 UTC. */
function when(iso: string | null | undefined): string {
  if (!iso) return '-';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '-' : d.toLocaleString();
}

function TxRows({ rows, heading }: { rows: TxRow[]; heading: string }) {
  return (
    <>
      <WalletDeskHeading
        title={heading}
        meta={`${fmt(rows.length)} ${rows.length === 1 ? 'Entry' : 'Entries'}`}
      />
      <div className="wdesk__list">
        {rows.map((r) => {
          const inbound = r.direction === 'credit';
          return (
            <WalletDeskRow
              key={r.id}
              name={r.notes ? titleCase(r.notes) : enumToTitleCase(r.tx_type)}
              sub={
                <>
                  {when(r.created_at)}
                  {r.clubs?.name ? <span className="wdesk__sep">{r.clubs.name}</span> : null}
                </>
              }
              figure={
                <span className={inbound ? 'wdesk__in' : 'wdesk__out'}>
                  {inbound ? '+' : '-'}
                  {exactChipFigure(r.amount)}
                </span>
              }
            />
          );
        })}
        {rows.length === 0 && <div className="wdesk__empty">No Movements Recorded.</div>}
      </div>
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
  // whatever is underneath. A transfer in flight holds the desk open.
  useEffect(() => {
    if (!isOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !busy) onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [isOpen, onClose, busy]);

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
      setNotice({ ok: false, text: `Backup Holds Only ${formatWalletChips(available)}.` });
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

  const headline =
    mode === 'rake'
      ? rake
        ? `${formatWalletChips(rake.balance)} Chips`
        : 'Reading The Wallet'
      : bbj
        ? `${formatWalletChips(mode === 'backup' ? bbj.banks.backup : bbj.banks.total)} Chips`
        : 'Reading The Banks';

  const dockLine =
    mode === 'rake'
      ? rake && rake.drift !== null
        ? rake.drift === 0
          ? 'Wallet And Ledger Agree'
          : `Drift ${exactChipFigure(rake.drift)}`
        : null
      : mode === 'backup'
        ? dest === 'main'
          ? 'Move To Main Jackpot'
          : 'Move To Promo Fund'
        : 'Read Only';

  const actions: WalletDeskAction[] = [];
  if (mode === 'backup') {
    actions.push(
      {
        label: 'Max',
        onClick: () => setAmount(String(bbj?.banks.backup ?? 0)),
        disabled: busy || !bbj,
        'aria-label': 'Move The Whole Backup',
      },
      {
        label: busy ? 'Moving...' : 'Move Funds',
        onClick: () => void moveBackup(),
        disabled: busy || !amount,
        lit: true,
      }
    );
  }
  if (onSendFrom) {
    actions.push({ label: 'Send Out', onClick: onSendFrom, 'aria-label': 'Send From This Wallet' });
  }

  return createPortal(
    <WalletDesk
      ariaLabel={title}
      name={title}
      line={headline}
      onClose={onClose}
      closeDisabled={busy}
      dockLine={dockLine}
      actions={actions}
    >
      {notice && (
        <div
          className={`wdesk__empty ${notice.ok ? '' : 'wdesk__empty--bad'}`}
          role={notice.ok ? 'status' : 'alert'}
        >
          {notice.text}
        </div>
      )}

      {loading && <div className="wdesk__empty">Loading...</div>}

      {/* ═══════════ RAKE ═══════════ */}
      {!loading && mode === 'rake' && rake && (
        <>
          <div className="wdesk__list">
            <WalletDeskRow name="Wallet Balance" figure={formatWalletChips(rake.balance)} />
            <WalletDeskRow
              name="Ledger Credits"
              figure={
                <span className="wdesk__in">{exactChipFigure(rake.ledger?.credits ?? 0)}</span>
              }
            />
            <WalletDeskRow
              name="Ledger Debits"
              figure={
                <span className="wdesk__out">{exactChipFigure(rake.ledger?.debits ?? 0)}</span>
              }
            />
            <WalletDeskRow
              name="Drift"
              sub="The Wallet Balance Minus The Ledger Net, Read In One Moment"
              figure={
                <span className={rake.drift ? 'wdesk__out' : 'wdesk__in'}>
                  {rake.drift === null ? '-' : exactChipFigure(rake.drift)}
                </span>
              }
            />
          </div>
          <p className="wdesk__empty">
            Drift Is Reported, Not Corrected. A Non Zero Value Means The Two Records Disagree And
            Someone Should Look.
            {rake.ledger?.asOf ? ` Ledger As Of ${when(rake.ledger.asOf)}.` : ''}
          </p>

          <WalletDeskHeading
            title={`By Club, Last ${rake.windowDays} Days`}
            meta={`${fmt(rake.byClub.length)} ${rake.byClub.length === 1 ? 'Club' : 'Clubs'}`}
          />
          <div className="wdesk__list">
            {rake.byClub.map((c) => (
              <WalletDeskRow
                key={c.club_id}
                name={c.club_name}
                sub={`${fmt(c.players)} Players · ${fmt(c.player_hands)} Player Hands`}
                figure={exactChipFigure(c.rake)}
              />
            ))}
            {rake.byClub.length === 0 && (
              <div className="wdesk__empty">No Rake In This Window.</div>
            )}
          </div>

          <WalletDeskHeading
            title="By Day"
            meta={rake.ledger?.throughDay ? `Through ${rake.ledger.throughDay}` : undefined}
          />
          <div className="wdesk__list">
            {rake.byDay.map((d) => (
              <WalletDeskRow
                key={d.day}
                name={d.day}
                sub={`${fmt(d.players)} Players · ${fmt(d.player_hands)} Player Hands`}
                figure={exactChipFigure(d.rake)}
              />
            ))}
          </div>

          <TxRows rows={rake.transactions} heading="Recent Rake Wallet Movements" />
        </>
      )}

      {/* ═══════════ BBJ / BACKUP ═══════════ */}
      {!loading && isBbj && bbj && (
        <>
          <div className="wdesk__list">
            <WalletDeskRow name="Main Jackpot" figure={formatWalletChips(bbj.banks.main)} />
            <WalletDeskRow name="Backup" figure={formatWalletChips(bbj.banks.backup)} />
            {/* The POOL's promo bank (bbj_pools.promo_balance), which is NOT
                the union Promo Wallet on the dashboard. Backup -> Promo
                credits union_wallets.promo_wallet, so this figure does not
                move when that transfer runs; labelled to say so. */}
            <WalletDeskRow name="Pool Promo Bank" figure={formatWalletChips(bbj.banks.promo)} />
            <WalletDeskRow name="Banked Total" figure={exactChipFigure(bbj.banks.total)} />
          </div>
          <p className="wdesk__empty">
            {bbj.splitPct
              ? `Live Split ${bbj.splitPct.main}% Main, ${bbj.splitPct.backup}% Backup, ${bbj.splitPct.promo}% Promo. `
              : ''}
            The 50/25/25 Rule Governs Each Allocation, And Payouts Come Out Of Main Only, So A
            Healthy Pool Drifts Away From It As It Pays. Allocated Lifetime{' '}
            {exactChipFigure(bbj.allocatedLifetime)}.
          </p>

          {mode === 'backup' && (
            <>
              <WalletDeskHeading title="Move Money Out Of Backup" />
              <p className="wdesk__empty">
                Backup Can Top Up The Main Jackpot Or Become Promotional Budget. It Cannot Be Sent
                To A Club: This Is Jackpot Money Owed To Players. To Promo Fund Credits The Union
                Promo Wallet On The Dashboard, A Different Balance From The Pool Promo Bank Above.
              </p>
              <div className="wdesk__words" role="group" aria-label="Destination">
                <button
                  type="button"
                  className="wdesk__word"
                  aria-pressed={dest === 'main'}
                  onClick={() => setDest('main')}
                  disabled={busy}
                >
                  To Main Jackpot
                </button>
                <button
                  type="button"
                  className="wdesk__word"
                  aria-pressed={dest === 'promo'}
                  onClick={() => setDest('promo')}
                  disabled={busy}
                >
                  To Promo Fund
                </button>
              </div>
              <label className="wdesk__search">
                <input
                  type="number"
                  min="0"
                  step="0.01"
                  inputMode="decimal"
                  placeholder="Amount"
                  value={amount}
                  onChange={(e) => setAmount(e.target.value)}
                  aria-label="Amount To Move"
                  disabled={busy}
                />
              </label>
            </>
          )}

          <WalletDeskHeading
            title="Credited To The Jackpot, Last 30 Days"
            meta={`${fmt(bbj.creditedBy.length)} Players`}
          />
          <div className="wdesk__list">
            {bbj.creditedBy.map((r) => (
              <WalletDeskRow
                key={`${r.user_id}-${r.club_name}`}
                name={r.username}
                sub={
                  <>
                    {r.club_name}
                    {r.agent_name ? <span className="wdesk__sep">{r.agent_name}</span> : null}
                    <span className="wdesk__sep">
                      {`Main ${exactChipFigure(r.main_amount)}, Backup ${exactChipFigure(r.backup_amount)}, Promo ${exactChipFigure(r.promo_amount)}, ${fmt(r.hands)} Hands`}
                    </span>
                  </>
                }
                figure={exactChipFigure(r.bbj_amount)}
              />
            ))}
            {bbj.creditedBy.length === 0 && (
              <div className="wdesk__empty">No Contributions In This Window.</div>
            )}
          </div>

          <WalletDeskHeading title="By Day" />
          <div className="wdesk__list">
            {bbj.byDay.map((d) => (
              <WalletDeskRow
                key={d.day}
                name={d.day}
                sub={`Main ${exactChipFigure(d.main)}, Backup ${exactChipFigure(d.backup)}, Promo ${exactChipFigure(d.promo)}, ${fmt(d.players)} Players`}
                figure={exactChipFigure(d.bbj)}
              />
            ))}
          </div>

          <TxRows rows={bbj.transactions} heading="Recent Jackpot And Promo Movements" />
        </>
      )}
    </WalletDesk>,
    document.body
  );
}
