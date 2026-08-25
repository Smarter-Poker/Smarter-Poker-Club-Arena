/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * GAME LOBBY PANEL — the selected game's dedicated lobby (Lobby V2)
 * ═══════════════════════════════════════════════════════════════════════════════
 * Opens when a lobby row is selected. The player reviews the game here BEFORE
 * committing anything: selecting a row never joins, registers, or spends.
 * Every action button below calls the EXISTING platform flow passed in from
 * ClubHomePage (navigate-to-table seat+buy-in, WaitlistService, TournamentService
 * register/unregister, spinQuickJoin). No parallel join systems.
 *
 * Desktop: right-side drawer. Small screens: full-width sheet. Esc closes.
 */

import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import CasinoPlaque, { PlaqueSeats } from './CasinoPlaque';
import type { LobbyEntry, LobbyTableRow, LobbyTournamentRow } from './lobbyEntries';
import { tournamentBlinds, tournamentLevel } from './tournamentFigures';
import { parseTableSettings } from './lobbyEntries';
import { tournamentService } from '../../services/TournamentService';
import { waitlistService, type WaitlistEntry } from '../../services/WaitlistService';
import { tableService } from '../../services/TableService';
import { supabase } from '../../lib/supabase';
import { useFocusTrap } from '../../hooks/useFocusTrap';
import { formatBuyIn } from '../../utils/buyIn';
import { reportError } from '../../utils/errorReporter';
import type { Tournament, BlindLevel, PayoutEntry } from '../../types/database.types';
import './GameLobbyPanel.css';

export interface GameLobbyPanelProps {
  entry: LobbyEntry;
  clubId: string;
  currentUserId: string | null;
  waitlisted: boolean;
  seated: boolean;
  registered: boolean;
  /** An action (register / unregister / waitlist) is in flight. */
  busy: boolean;
  onClose: () => void;
  onJoinTable: (tableId: string) => void;
  onWaitlistToggle: (tableId: string, joining: boolean) => void;
  onRegister: (t: LobbyTournamentRow) => void;
  onUnregister: (t: LobbyTournamentRow) => void;
  onSpinJoin: (t: LobbyTournamentRow, variant: 'spin' | 'sng') => void;
  /** Club owner / admin only: opens the existing delete confirmation flow. */
  canDelete?: boolean;
  onDeleteTable?: (tableId: string) => void;
  /** True inside the MultiTablePage embed: links must not navigate the host
      page, so the footer back-link becomes a plain close. */
  embedded?: boolean;
}

type TournTab = 'overview' | 'structure' | 'payouts';

interface CtaSpec {
  label: string;
  kind: 'primary' | 'secondary' | 'gold' | 'danger' | 'disabled';
  run?: () => void;
  link?: string;
  needsAuth?: boolean;
  note?: string;
}

const lvlNum = (
  l: BlindLevel,
  snake: 'small_blind' | 'big_blind' | 'duration_minutes',
  camel: 'smallBlind' | 'bigBlind' | 'durationMinutes'
) => Number(l[snake] ?? l[camel] ?? 0);

export default function GameLobbyPanel(props: GameLobbyPanelProps) {
  const {
    entry,
    clubId,
    currentUserId,
    waitlisted,
    seated,
    registered,
    busy,
    onClose,
    onJoinTable,
    onWaitlistToggle,
    onRegister,
    onUnregister,
    onSpinJoin,
    canDelete,
    onDeleteTable,
    embedded,
  } = props;

  const isCash = entry.kind === 'cash';
  /* The drawer declared role=dialog aria-modal=true and trapped nothing:
     focus stayed on the lobby row behind it, Tab walked the page underneath,
     and a screen-reader user was never taken into the dialog they had just
     opened. useFocusTrap moves focus in, cycles Tab inside, and restores it
     to the row on close. */
  const panelRef = useFocusTrap(true);

  /* Lock the page behind the drawer. On a phone the sheet is full-screen and
     the lobby scrolled underneath it, so closing put the player somewhere
     they had never scrolled to. */
  useEffect(() => {
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = previous;
    };
  }, []);

  // ── Esc closes the panel ──
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  // ── Detail data (read-only enrichment; actions never depend on it) ──
  const [tournament, setTournament] = useState<Tournament | null>(null);
  const [waitlist, setWaitlist] = useState<WaitlistEntry[]>([]);
  const [avgPot, setAvgPot] = useState<number | null>(null);
  const [seatMap, setSeatMap] = useState<{ seat_number: number; user_id: string }[] | null>(null);
  const [tab, setTab] = useState<TournTab>('overview');
  const [detailError, setDetailError] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setTournament(null);
    setWaitlist([]);
    setAvgPot(null);
    setTab('overview');
    setDetailError(false);

    if (isCash) {
      waitlistService
        .getTableWaitlist(entry.id)
        .then((rows) => {
          if (!cancelled) setWaitlist(rows || []);
        })
        .catch((e) => reportError(e, 'GameLobbyPanel.loadWaitlist'));
      tableService
        .getAveragePot(entry.id)
        .then((v: number | null) => {
          if (!cancelled && v != null && Number.isFinite(Number(v))) setAvgPot(Number(v));
        })
        .catch(() => undefined);
    } else {
      tournamentService
        .getTournament(entry.id)
        .then((t) => {
          if (!cancelled) setTournament(t);
        })
        .catch((e) => {
          reportError(e, 'GameLobbyPanel.loadTournament');
          if (!cancelled) setDetailError(true);
        });
    }
    return () => {
      cancelled = true;
    };
  }, [entry.id, isCash]);

  // ── Seat map (cash only; table_seats is public-read). Keyed on
  //    entry.players so a realtime seat change refreshes the map without
  //    refetching the waitlist or the average pot. Read-only enrichment:
  //    nothing below ever depends on it. ──
  useEffect(() => {
    if (!isCash || entry.capacity <= 0) {
      setSeatMap(null);
      return;
    }
    let cancelled = false;
    /* Awaited inside a try, not left as a bare `.then`. A Supabase builder is
       a PromiseLike that REJECTS on a transport failure - it only resolves
       with `{ error }` for query-level errors - and a PromiseLike has no
       `.catch`, so there was nowhere to put the handler and a dropped
       connection here surfaced as an unhandled rejection. The seat map is a
       nice-to-have; failing to get it must not raise. */
    void (async () => {
      try {
        const { data, error } = await supabase
          .from('table_seats')
          .select('seat_number, user_id')
          .eq('table_id', entry.id)
          .is('left_at', null);
        if (!cancelled && !error && data) setSeatMap(data);
      } catch {
        /* transport failure - the panel simply shows no seat map */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [entry.id, isCash, entry.capacity, entry.players]);

  // ── CTA derivation from EXISTING state, never invented ──
  const cta = useMemo<CtaSpec>(() => {
    if (isCash) {
      const t = entry.raw as LobbyTableRow;
      const status = String(t.status || '').toLowerCase();
      if (seated)
        return {
          label: 'Return To Table',
          kind: 'gold' as const,
          run: () => onJoinTable(entry.id),
        };
      if (status === 'closed' || status === 'deleted')
        return { label: 'Table Closed', kind: 'disabled' as const };
      if (status === 'paused') return { label: 'Game Paused', kind: 'disabled' as const };
      const full = entry.capacity > 0 && entry.players >= entry.capacity;
      if (full && waitlisted)
        return {
          label: 'Leave Waitlist',
          kind: 'danger' as const,
          run: () => onWaitlistToggle(entry.id, false),
          needsAuth: true,
        };
      if (full)
        return {
          label: 'Join Waitlist',
          kind: 'secondary' as const,
          run: () => onWaitlistToggle(entry.id, true),
          needsAuth: true,
        };
      return {
        label: 'Join Table',
        kind: 'primary' as const,
        run: () => onJoinTable(entry.id),
        note: 'Pick Your Seat And Buy In At The Table',
      };
    }

    const t = entry.raw as LobbyTournamentRow;
    const st = entry.status;
    if (entry.kind === 'spin') {
      if (registered)
        return { label: 'Return To Game', kind: 'gold' as const, run: () => onSpinJoin(t, 'spin') };
      if (st === 'completed' || st === 'closed')
        return { label: 'Game Over', kind: 'disabled' as const };
      const full = entry.capacity > 0 && entry.players >= entry.capacity;
      /* Full is full, whatever the status says: a 2/2 spin still waiting to
         flip to RUNNING has no seat either (QA 2026-08-22 found live 2/2
         games offering an active CTA because this only checked 'running'). */
      if (full) return { label: 'Game Full', kind: 'disabled' as const };
      return {
        label: 'Join Spin',
        kind: 'primary' as const,
        run: () => onSpinJoin(t, 'spin'),
        needsAuth: true,
      };
    }
    if (entry.kind === 'sng') {
      if (registered)
        return { label: 'Return To Table', kind: 'gold' as const, run: () => onSpinJoin(t, 'sng') };
      if (st === 'completed' || st === 'closed')
        return { label: 'Game Over', kind: 'disabled' as const };
      const full = entry.capacity > 0 && entry.players >= entry.capacity;
      // Same rule as spins: no seat exists at 2/2, whatever the status label.
      if (full) return { label: 'Table Full', kind: 'disabled' as const };
      return {
        label: 'Take Seat',
        kind: 'primary' as const,
        run: () => onSpinJoin(t, 'sng'),
        needsAuth: true,
      };
    }
    // MTT
    if (registered && (st === 'running' || st === 'late_reg'))
      return {
        label: 'Return To Tournament',
        kind: 'gold' as const,
        link: `/tournaments/${entry.id}`,
      };
    if (registered)
      return {
        label: 'Unregister',
        kind: 'danger' as const,
        run: () => onUnregister(t),
        needsAuth: true,
      };
    if (st === 'completed' || st === 'closed')
      return { label: 'Registration Closed', kind: 'disabled' as const };
    if (st === 'running') return { label: 'Registration Closed', kind: 'disabled' as const };
    const full = entry.capacity > 0 && entry.players >= entry.capacity;
    if (full) return { label: 'Tournament Full', kind: 'disabled' as const };
    if (st === 'late_reg')
      return {
        label: 'Late Register',
        kind: 'primary' as const,
        run: () => onRegister(t),
        needsAuth: true,
      };
    return {
      label: 'Register',
      kind: 'primary' as const,
      run: () => onRegister(t),
      needsAuth: true,
    };
  }, [
    entry,
    isCash,
    seated,
    waitlisted,
    registered,
    onJoinTable,
    onWaitlistToggle,
    onRegister,
    onUnregister,
    onSpinJoin,
  ]);

  const ctaDisabled = cta.kind === 'disabled' || busy || (cta.needsAuth === true && !currentUserId);

  // ── Right zone of the plaque ──
  /* The lobby row is the fallback for the two figures the table now prints
     in columns of their own. When the detail fetch fails the panel used to
     hide a Starting Stack the card behind it was still showing, and it never
     showed Current Level at all - so opening a row could tell you LESS than
     the row did. Both come off `entry.raw` when the fetched tournament has
     nothing to add. */
  const tRaw = entry.kind === 'cash' ? null : (entry.raw as LobbyTournamentRow);
  const panelStartingChips = Number(tournament?.starting_chips ?? tRaw?.starting_chips ?? 0) || 0;
  const panelLevel = tRaw ? tournamentLevel(tRaw) : 0;
  const panelBlinds = tRaw ? tournamentBlinds(tRaw) : null;

  const cashRaw = isCash ? (entry.raw as LobbyTableRow) : null;
  /* `cashRaw.big_blind * 20` is NaN the moment big_blind is null, and
     NaN.toLocaleString() renders the literal text "NaN" on the buy-in plaque
     and in the Buy-In row. Coerce first, then fall back. */
  const bigBlind = Number(cashRaw?.big_blind) || 0;
  const minBuy = cashRaw ? Number(cashRaw.min_buy_in) || bigBlind * 20 : 0;
  const maxBuy = cashRaw ? Number(cashRaw.max_buy_in) || bigBlind * 100 : 0;

  const joinZone = (
    <>
      <span className="cplaque__join-label">
        {isCash ? 'BUY-IN' : entry.kind === 'mtt' ? 'ENTRY' : 'BUY-IN'}
      </span>
      <div className="cplaque__join-figures">
        {isCash ? (
          <>
            <span className="cplaque__join-figure">
              <b>{minBuy.toLocaleString()}</b>
              <span>Min</span>
            </span>
            <span className="cplaque__join-figure">
              <b>{maxBuy.toLocaleString()}</b>
              <span>Max</span>
            </span>
          </>
        ) : (
          <>
            <span className="cplaque__join-figure">
              <b>{entry.buyInLabel}</b>
              <span>Buy-In</span>
            </span>
            {entry.guaranteeValue > 0 && (
              <span className="cplaque__join-figure">
                <b>{entry.guaranteeValue.toLocaleString()}</b>
                <span>Guaranteed</span>
              </span>
            )}
          </>
        )}
      </div>
      <PlaqueSeats players={entry.players} capacity={entry.capacity} />
      {cta.link && !busy ? (
        <Link
          className={`cplaque__cta${cta.kind !== 'primary' && cta.kind !== 'disabled' ? ` cplaque__cta--${cta.kind}` : ''}`}
          to={cta.link}
        >
          {cta.label}
        </Link>
      ) : (
        <button
          type="button"
          className={`cplaque__cta${cta.kind !== 'primary' && cta.kind !== 'disabled' ? ` cplaque__cta--${cta.kind}` : ''}`}
          /* When an action is in flight the link CTA renders as this button
             instead, so "Return To Tournament" cannot be tapped a second time
             mid-registration and shows the same One Moment state every other
             CTA shows. */
          disabled={ctaDisabled}
          onClick={() => cta.run?.()}
        >
          {busy ? 'One Moment' : cta.label}
        </button>
      )}
      {cta.needsAuth && !currentUserId && (
        <span className="cplaque__cta-note">Sign In To Play</span>
      )}
      {cta.note && <span className="cplaque__cta-note">{cta.note}</span>}
      {isCash && (
        <Link
          className="cplaque__observe-link"
          to={`/table/${entry.id}`}
          style={{
            marginTop: '0.5rem',
            display: 'block',
            textAlign: 'center',
            fontSize: '0.9rem',
            color: 'var(--text-muted)',
          }}
        >
          Observe Table
        </Link>
      )}
    </>
  );

  // ── Detailed rules list (complete explanations under the plaque) ──
  const settings = isCash ? parseTableSettings(cashRaw?.settings) : null;

  return (
    <div className="glp-backdrop" onClick={onClose} role="presentation">
      <aside
        ref={panelRef}
        className="glp"
        role="dialog"
        aria-modal="true"
        aria-label={`${entry.name} lobby`}
        onClick={(e) => e.stopPropagation()}
      >
        <header className="glp__head">
          <span className="glp__head-title" title={entry.name}>
            {entry.name}
          </span>
          <button
            type="button"
            className="glp__close"
            aria-label="Close game lobby"
            onClick={onClose}
          >
            &#10005;
          </button>
        </header>

        <div className="glp__scroll">
          <CasinoPlaque entry={entry}>{joinZone}</CasinoPlaque>

          {/* ── CASH GAME LOBBY ── */}
          {isCash && cashRaw && (
            <>
              <section className="glp__section">
                <h3 className="glp__h">Game Information</h3>
                <dl className="glp__grid">
                  <div>
                    <dt>Game</dt>
                    <dd>{entry.variantLabel}</dd>
                  </div>
                  <div>
                    <dt>Blinds</dt>
                    <dd className="glp__mono">{entry.stakesLabel}</dd>
                  </div>
                  <div>
                    <dt>Buy-In</dt>
                    <dd className="glp__mono">
                      {minBuy.toLocaleString()} - {maxBuy.toLocaleString()}
                    </dd>
                  </div>
                  <div>
                    <dt>Players</dt>
                    <dd className="glp__mono">
                      {entry.players} / {entry.capacity}
                    </dd>
                  </div>
                  {settings?.ante_enabled === true && (
                    <div>
                      <dt>Ante</dt>
                      <dd className="glp__mono">
                        {Number(settings.ante_amount) > 0
                          ? Number(settings.ante_amount).toLocaleString()
                          : 'On'}
                      </dd>
                    </div>
                  )}
                  {avgPot != null && avgPot > 0 && (
                    <div>
                      <dt>Avg Pot</dt>
                      <dd className="glp__mono">{Math.round(avgPot).toLocaleString()}</dd>
                    </div>
                  )}
                  <div>
                    <dt>Waiting</dt>
                    <dd className="glp__mono">{waitlist.length}</dd>
                  </div>
                  <div>
                    <dt>Status</dt>
                    <dd>{entry.statusLabel}</dd>
                  </div>
                </dl>
              </section>

              {seatMap && entry.capacity > 0 && (
                <section className="glp__section">
                  <h3 className="glp__h">Seat Map</h3>
                  <div className="glp__seatmap">
                    {Array.from({ length: entry.capacity }).map((_, i) => {
                      const n = i + 1;
                      const taken = seatMap.find((x) => x.seat_number === n);
                      const mine = Boolean(
                        taken && currentUserId && taken.user_id === currentUserId
                      );
                      return (
                        <span
                          key={n}
                          className={`glp__seat${taken ? ' is-taken' : ''}${mine ? ' is-you' : ''}`}
                        >
                          <i>{n}</i>
                          <em>{mine ? 'You' : taken ? 'Taken' : 'Open'}</em>
                        </span>
                      );
                    })}
                  </div>
                </section>
              )}

              {entry.rules.length > 0 && (
                <section className="glp__section">
                  <h3 className="glp__h">Rules</h3>
                  <ul className="glp__rules">
                    {entry.rules.map((r) => (
                      <li key={r.key}>
                        <b>
                          {r.label}
                          {r.detail ? ` ${r.detail}` : ''}
                        </b>
                        <span>{r.tip}</span>
                      </li>
                    ))}
                  </ul>
                </section>
              )}

              {waitlist.length > 0 && (
                <section className="glp__section">
                  <h3 className="glp__h">Waiting List</h3>
                  <ol className="glp__waitlist">
                    {waitlist.slice(0, 10).map((w, i) => (
                      <li key={w.id || i}>
                        <span className="glp__wl-pos">{i + 1}</span>
                        <span className="glp__wl-name">
                          {w.userId && currentUserId && w.userId === currentUserId
                            ? 'You'
                            : 'Player'}
                        </span>
                      </li>
                    ))}
                  </ol>
                </section>
              )}
            </>
          )}

          {/* ── TOURNAMENT / SPIN / HEADS-UP LOBBY ── */}
          {!isCash && (
            <>
              {entry.kind === 'mtt' && (
                <nav className="glp__tabs" role="tablist" aria-label="Tournament details">
                  {(['overview', 'structure', 'payouts'] as TournTab[]).map((t) => (
                    <button
                      key={t}
                      role="tab"
                      aria-selected={tab === t}
                      className={`glp__tab${tab === t ? ' is-active' : ''}`}
                      onClick={() => setTab(t)}
                    >
                      {t === 'overview' ? 'Overview' : t === 'structure' ? 'Structure' : 'Payouts'}
                    </button>
                  ))}
                </nav>
              )}

              {(entry.kind !== 'mtt' || tab === 'overview') && (
                <section className="glp__section">
                  <h3 className="glp__h">{entry.kind === 'mtt' ? 'Overview' : 'Details'}</h3>
                  <dl className="glp__grid">
                    <div>
                      <dt>Game</dt>
                      <dd>{entry.variantLabel}</dd>
                    </div>
                    <div>
                      <dt>Buy-In</dt>
                      <dd className="glp__mono">
                        {tournament
                          ? formatBuyIn(tournament.buy_in_amount, tournament.buy_in_fee)
                          : entry.buyInLabel}
                      </dd>
                    </div>
                    {entry.guaranteeValue > 0 && (
                      <div>
                        <dt>Guarantee</dt>
                        <dd className="glp__mono">{entry.guaranteeValue.toLocaleString()}</dd>
                      </div>
                    )}
                    {tournament && Number(tournament.prize_pool) > 0 && (
                      <div>
                        <dt>Prize Pool</dt>
                        <dd className="glp__mono">
                          {Number(tournament.prize_pool).toLocaleString()}
                        </dd>
                      </div>
                    )}
                    <div>
                      <dt>Players</dt>
                      <dd className="glp__mono">
                        {entry.players} / {entry.capacity || '-'}
                      </dd>
                    </div>
                    <div>
                      <dt>Starts</dt>
                      <dd>
                        {entry.startTime
                          ? new Date(entry.startTime).toLocaleString('en-US', {
                              month: 'short',
                              day: 'numeric',
                              hour: 'numeric',
                              minute: '2-digit',
                            })
                          : 'When Full'}
                      </dd>
                    </div>
                    {/* The lobby row already carries starting_chips, and the
                        table now prints it in a column of its own - so when
                        the detail fetch fails this panel was hiding a figure
                        the card behind it is still showing. Fall back to the
                        row, the way the note below promises. */}
                    {panelStartingChips > 0 && (
                      <div>
                        <dt>Starting Stack</dt>
                        <dd className="glp__mono">{panelStartingChips.toLocaleString()}</dd>
                      </div>
                    )}
                    {panelLevel > 0 && (
                      <div>
                        <dt>Current Level</dt>
                        <dd className="glp__mono">
                          {panelLevel}
                          {panelBlinds ? ` (${panelBlinds})` : ''}
                        </dd>
                      </div>
                    )}
                    {tournament &&
                      (Number(tournament.late_reg_mins) > 0 ||
                        Number(tournament.late_reg_levels) > 0) && (
                        <div>
                          <dt>Late Reg</dt>
                          <dd>
                            {Number(tournament.late_reg_levels) > 0
                              ? `${tournament.late_reg_levels} Levels`
                              : `${tournament.late_reg_mins} Min`}
                          </dd>
                        </div>
                      )}
                    {tournament?.is_reentry === true && (
                      <div>
                        <dt>Re-Entry</dt>
                        <dd>Allowed</dd>
                      </div>
                    )}
                    <div>
                      <dt>Status</dt>
                      <dd>{entry.statusLabel}</dd>
                    </div>
                  </dl>
                  {detailError && (
                    <p className="glp__note">
                      Full Details Could Not Be Loaded. The Figures Above Come From The Lobby.
                    </p>
                  )}
                </section>
              )}

              {entry.kind === 'mtt' && tab === 'structure' && (
                <section className="glp__section">
                  <h3 className="glp__h">Blind Structure</h3>
                  {tournament?.blind_structure?.length ? (
                    <div className="glp__tablewrap">
                      <table className="glp__table">
                        <thead>
                          <tr>
                            <th>Lvl</th>
                            <th>Small</th>
                            <th>Big</th>
                            <th>Ante</th>
                            <th>Mins</th>
                          </tr>
                        </thead>
                        <tbody>
                          {tournament.blind_structure.map((l, i) =>
                            l.isBreak ? (
                              <tr key={i} className="glp__break">
                                <td colSpan={5}>Break</td>
                              </tr>
                            ) : (
                              <tr key={i}>
                                <td>{l.level ?? i + 1}</td>
                                <td>{lvlNum(l, 'small_blind', 'smallBlind').toLocaleString()}</td>
                                <td>{lvlNum(l, 'big_blind', 'bigBlind').toLocaleString()}</td>
                                <td>{Number(l.ante || 0).toLocaleString()}</td>
                                <td>{lvlNum(l, 'duration_minutes', 'durationMinutes') || '-'}</td>
                              </tr>
                            )
                          )}
                        </tbody>
                      </table>
                    </div>
                  ) : (
                    <p className="glp__note">
                      {tournament ? 'No Structure Published For This Event' : 'Loading Structure'}
                    </p>
                  )}
                </section>
              )}

              {entry.kind === 'mtt' && tab === 'payouts' && (
                <section className="glp__section">
                  <h3 className="glp__h">Payouts</h3>
                  {tournament?.payout_structure?.length ? (
                    <>
                      <div className="glp__tablewrap">
                        <table className="glp__table">
                          <thead>
                            <tr>
                              <th>Place</th>
                              <th>Share</th>
                              {Number(tournament.prize_pool) > 0 && <th>Projected</th>}
                            </tr>
                          </thead>
                          <tbody>
                            {tournament.payout_structure.map((p: PayoutEntry) => (
                              <tr key={p.place}>
                                <td>{p.place}</td>
                                <td>{p.percentage}%</td>
                                {Number(tournament.prize_pool) > 0 && (
                                  <td>
                                    {Math.floor(
                                      (Number(tournament.prize_pool) * p.percentage) / 100
                                    ).toLocaleString()}
                                  </td>
                                )}
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                      <p className="glp__note">
                        Projected Amounts Are Estimates From The Current Prize Pool, Not Final
                        Payouts.
                      </p>
                    </>
                  ) : (
                    <p className="glp__note">
                      {tournament ? 'Payouts Are Set When The Field Closes' : 'Loading Payouts'}
                    </p>
                  )}
                </section>
              )}

              {entry.rules.length > 0 && (entry.kind !== 'mtt' || tab === 'overview') && (
                <section className="glp__section">
                  <h3 className="glp__h">Format</h3>
                  <ul className="glp__rules">
                    {entry.rules.map((r) => (
                      <li key={r.key}>
                        <b>
                          {r.label}
                          {r.detail ? ` ${r.detail}` : ''}
                        </b>
                        <span>{r.tip}</span>
                      </li>
                    ))}
                  </ul>
                </section>
              )}

              {entry.kind === 'mtt' && (
                <Link className="glp__fulllink" to={`/tournaments/${entry.id}`}>
                  Open Full Tournament Lobby
                </Link>
              )}
            </>
          )}

          <div className="glp__foot">
            {isCash && canDelete && onDeleteTable && (
              <button
                type="button"
                className="glp__deletebtn"
                onClick={() => onDeleteTable(entry.id)}
              >
                Delete Table
              </button>
            )}
            {embedded ? (
              <button type="button" className="glp__backlink" onClick={onClose}>
                Back To All Games
              </button>
            ) : (
              <Link className="glp__backlink" to={`/clubs/${clubId}`} onClick={onClose}>
                Back To All Games
              </Link>
            )}
          </div>
        </div>
      </aside>
    </div>
  );
}
