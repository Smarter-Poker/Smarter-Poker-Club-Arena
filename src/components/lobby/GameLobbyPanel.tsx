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
import { Link, useNavigate } from 'react-router-dom';
import CasinoPlaque, { PlaqueSeats } from './CasinoPlaque';
import ArenaGameCard from './game-cards/ArenaGameCard';
import { arenaGameCardDataFromEntry } from './game-cards/arenaGameCardAdapter';
import type { ArenaGameCardActions } from './game-cards/arenaGameCardTypes';
import type { LobbyEntry, LobbyTableRow, LobbyTournamentRow } from './lobbyEntries';
import { parseBlindStructure, tournamentBlinds, tournamentLevel } from './tournamentFigures';
import { parseTableSettings, seatsTakenLabel, seatFirstJoinable } from './lobbyEntries';
import { cashBuyInRange } from '../../lib/cashBuyIn';
import { tournamentService } from '../../services/TournamentService';
import { waitlistService, type WaitlistEntry } from '../../services/WaitlistService';
import { tableService } from '../../services/TableService';
import { supabase } from '../../lib/supabase';
import { useFocusTrap } from '../../hooks/useFocusTrap';
import { formatBuyIn } from '../../utils/buyIn';
import { reportError } from '../../utils/errorReporter';
import { useInTabLobby } from '../../context/InTabLobbyContext';
import type { Tournament, BlindLevel } from '../../types/database.types';
import { parsePayoutStructure } from '../tournament/details/types';
import type { PayoutPlace } from '../tournament/details/types';
import './GameLobbyPanel.css';
import './PremiumGameLobbyPanel.css';

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

/** How long a queued player has ACTUALLY been waiting, from created_at.
 *  (Dan 2026-08-26: replaced the fabricated ~5m-per-position ETA.) */
function waitedLabel(joinedAt: string): string {
  const t = new Date(joinedAt).getTime();
  if (!Number.isFinite(t)) return '';
  const mins = Math.floor((Date.now() - t) / 60000);
  if (mins < 1) return 'Just Joined';
  if (mins < 60) return `${mins}m`;
  return `${Math.floor(mins / 60)}h ${mins % 60}m`;
}

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
  const navigate = useNavigate();
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

  /**
   * Am I rendered inside a MultiTablePage lobby tab?
   *
   * The context is the authority — it is non-null exactly when a lobby tab is
   * hosting this subtree — and the prop is kept as an override so existing
   * callers are untouched. Either one being true is enough; see the back link
   * at the foot of this component for what turns on it.
   */
  const isEmbedded = useInTabLobby() !== null || Boolean(embedded);

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
  const [waitlistError, setWaitlistError] = useState(false);
  const [avgPot, setAvgPot] = useState<number | null>(null);
  const [seatMap, setSeatMap] = useState<{ seat_number: number; user_id: string }[] | null>(null);
  const [tab, setTab] = useState<TournTab>('overview');
  const [detailError, setDetailError] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setTournament(null);
    setWaitlist([]);
    setWaitlistError(false);
    setAvgPot(null);
    setTab('overview');
    setDetailError(false);

    if (isCash) {
      waitlistService
        .getTableWaitlist(entry.id)
        .then((rows) => {
          if (cancelled) return;
          /* NULL means the READ failed (query-level, which the .catch below
             can never see — a Supabase builder only rejects on transport).
             "Waiting 0" beside a Join Waitlist button is a promise that you
             are first in line; on a failed read it was a guess. The service
             now says which is which, and '-' renders for "could not find
             out" (ITEM E audit, 2026-08-26). */
          if (rows === null) {
            setWaitlistError(true);
          } else {
            setWaitlist(rows);
            setWaitlistError(false);
          }
        })
        .catch((e) => {
          if (!cancelled) setWaitlistError(true);
          reportError(e, 'GameLobbyPanel.loadWaitlist');
        });
      tableService
        .getAveragePot(entry.id)
        .then((v: number | null) => {
          if (!cancelled && v != null && Number.isFinite(Number(v))) setAvgPot(Number(v));
        })
        .catch((e) => reportError(e, 'GameLobbyPanel.loadAveragePot'));
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
        if (cancelled) return;
        if (error) {
          /* `!error && data` swallowed this silently. The seat map is read-only
             enrichment and correctly stays HIDDEN on failure - it is never drawn
             as "every seat empty" - but a failure nobody records is a failure
             nobody can fix. */
          reportError(error, 'GameLobbyPanel.loadSeatMap');
          setSeatMap(null);
          return;
        }
        setSeatMap(data ?? []);
      } catch (err) {
        /* transport failure - the panel simply shows no seat map */
        reportError(err, 'GameLobbyPanel.loadSeatMap');
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
      /* A RUNNING SPIN CANNOT BE JOINED (2026-08-28 audit). This branch had
         no `running` case, so a spin already in progress whose seat count had
         dipped below capacity (a bust-out closes a seat row and
         fn_sync_seat_first_player_count decrements the counter) offered a
         gold "Join Spin" on the buy-in screen — while the board row behind it
         correctly said Watch. `seatFirstJoinable` is the ONE list of dead
         states (running / completed / closed, plus capacity) and LobbyTable
         already uses it; this panel was re-spelling a narrower rule by hand. */
      if (!seatFirstJoinable(entry))
        return { label: 'Watch', kind: 'secondary' as const, run: () => onSpinJoin(t, 'spin') };
      return {
        label: 'Join Spin',
        kind: 'primary' as const,
        run: () => onSpinJoin(t, 'spin'),
        needsAuth: true,
      };
    }
    /* ONLY A HEADS-UP SNG IS SEAT-FIRST (2026-08-28).
       `classifyTournament` calls anything with max_players <= 10 an 'sng',
       but the database's seat-first rule is `variant='spin' OR max_players
       <= 2`, and every other surface applies that split (LobbyTable's action
       column, ClubHomePage's lobbyCtx and handleRegister). This panel did
       not: it sent 6-max and 9-max SNGs down the seat-first path too, where
       `fn_take_seat_and_buy_in` answers not_a_seat_first_game. The player was
       navigated to a table whose seats are inert, never registered and never
       charged — a CTA whose only effect was to relocate them, and no
       reachable entry path to a multi-seat SNG from this panel at all.
       Those are registration games; they fall through to the MTT branch. */
    if (entry.kind === 'sng' && entry.capacity > 0 && entry.capacity <= 2) {
      if (registered)
        return { label: 'Return To Table', kind: 'gold' as const, run: () => onSpinJoin(t, 'sng') };
      if (st === 'completed' || st === 'closed')
        return { label: 'Game Over', kind: 'disabled' as const };
      const full = entry.players >= entry.capacity;
      // Same rule as spins: no seat exists at 2/2, whatever the status label.
      if (full) return { label: 'Table Full', kind: 'disabled' as const };
      // Same rule as the spin branch above — one list of dead states.
      if (!seatFirstJoinable(entry))
        return { label: 'Watch', kind: 'secondary' as const, run: () => onSpinJoin(t, 'sng') };
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

  /* The selected cash-table view must be the SAME approved machine as the
     card that opened it. The previous implementation drew a second, generic
     CSS plaque here, so the player moved from real machined artwork into a
     cheaper imitation after one click. Keep one live data adapter and one
     hardware renderer; only the action handlers belong to this dialog. */
  const cashMachineData = useMemo(
    () => ({ ...arenaGameCardDataFromEntry(entry), registeredByViewer: seated }),
    [entry, seated]
  );
  const cashMachineActions = useMemo<ArenaGameCardActions>(() => {
    const primaryTone =
      cta.kind === 'gold'
        ? 'green'
        : cta.kind === 'danger'
          ? 'red'
          : cta.kind === 'disabled'
            ? 'neutral'
            : 'blue';
    return {
      primaryLabel: cta.label,
      primaryTone,
      primaryDisabled: ctaDisabled,
      busy,
      onPrimary: () => {
        if (cta.link) navigate(cta.link);
        else cta.run?.();
      },
      secondaryLabel: 'View Table',
      onSecondary: () => navigate(`/table/${entry.id}`),
    };
  }, [busy, cta, ctaDisabled, entry.id, navigate]);

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

  /**
   * ── THE STRUCTURE TAB WAS CRASHING THE PANEL ────────────────────────────
   *
   * `tournaments.blind_structure` is a TEXT column holding a JSON array, and
   * TournamentService.getTournament returns the raw row without parsing — but
   * the `Tournament` type declares the field as `BlindLevel[]`, so TypeScript
   * had nothing to say about it. At runtime it is a STRING: `.length` is the
   * character count, which is truthy, and `.map` is not a function. Opening
   * Structure on any MTT threw and took the whole panel down.
   *
   * Every other consumer already guards — TournamentInfoPanel with asArray,
   * TablePage and the lobby table through parseBlindStructure. This was the
   * last one that did not. Array input is passed through so a caller that
   * ever does parse for us keeps working.
   */
  const panelBlindLevels = useMemo<BlindLevel[]>(() => {
    const raw = tournament?.blind_structure as unknown;
    if (Array.isArray(raw)) return raw as BlindLevel[];
    return (parseBlindStructure(typeof raw === 'string' ? raw : null) as BlindLevel[] | null) ?? [];
  }, [tournament?.blind_structure]);

  /**
   * ── AND THE SAME BUG, ONE FIELD OVER (ITEM E audit, 2026-08-26) ─────────
   *
   * `payout_structure` is the SAME kind of TEXT-holding-JSON column as
   * `blind_structure` above, and this panel rendered it raw: on a string,
   * `.length` is the character count (truthy) and `.map` is not a function —
   * the whole panel went down opening Payouts. And even on a real array, the
   * range shapes builders emit ({from:2,to:9} / place:"4-6") rendered as one
   * row with an empty Place cell while RewardsTab showed one row per paid
   * place — two answers about who gets paid, on the buy-in surface.
   *
   * parsePayoutStructure is the ONE parser every tab already uses; it expands
   * ranges to one entry per place, which also gives the rows a real key.
   */
  const panelPayouts = useMemo<PayoutPlace[]>(
    () => parsePayoutStructure(tournament?.payout_structure) ?? [],
    [tournament?.payout_structure]
  );

  const cashRaw = isCash ? (entry.raw as LobbyTableRow) : null;
  /* One helper, so the panel and the card behind it cannot quote different
     buy-ins for the same table — see src/lib/cashBuyIn.ts for why the raw
     columns were the wrong thing to print. It also coerces before it falls
     back, which is what stopped the literal text "NaN" appearing on the
     buy-in plaque when a row carried a null big_blind. */
  const cashRange = cashRaw ? cashBuyInRange(cashRaw) : null;
  const minBuy = cashRange ? cashRange.min : 0;
  const maxBuy = cashRange ? cashRange.max : 0;
  /* ITEM E audit, 2026-08-26: cashBuyInRange returns {min:0,max:0,unknown:true}
     for a row that cannot price itself, and cashBuyIn.ts names the bug of
     ignoring that flag: "Returning 0/0 printed the literal '0' on the card
     and '0 Min / 0 Max' in the panel — a claim about money that is not
     merely unknown but wrong." The card honours it (buyInLabel → '-'); the
     panel read only .min/.max. One formatter, used at every money site. */
  const cashMoney = (n: number): string =>
    cashRange && cashRange.unknown ? '-' : n.toLocaleString();

  const joinZone = (
    <>
      <span className="cplaque__join-label">
        {isCash ? 'BUY-IN' : entry.kind === 'mtt' ? 'ENTRY' : 'BUY-IN'}
      </span>
      <div className="cplaque__join-figures">
        {isCash ? (
          <>
            <span className="cplaque__join-figure">
              <b>{cashMoney(minBuy)}</b>
              <span>Min</span>
            </span>
            <span className="cplaque__join-figure">
              <b>{cashMoney(maxBuy)}</b>
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
      <PlaqueSeats
        players={entry.players}
        capacity={entry.capacity}
        bareCount={entry.kind === 'mtt'}
      />
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
        <Link className="cplaque__observe-link" to={`/table/${entry.id}`}>
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
        className={`glp${isCash ? ' glp--cash' : ''}`}
        role="dialog"
        aria-modal="true"
        aria-label={`${entry.name} Lobby`}
        onClick={(e) => e.stopPropagation()}
      >
        <header className="glp__head">
          <span className="glp__head-title" title={entry.name}>
            {isCash && <small>Table Lobby</small>}
            <b>{entry.name}</b>
          </span>
          <button
            type="button"
            className="glp__close"
            aria-label="Close Game Lobby"
            onClick={onClose}
          >
            &#10005;
          </button>
        </header>

        <div className="glp__scroll">
          {isCash ? (
            <ArenaGameCard
              data={cashMachineData}
              actions={cashMachineActions}
              presentation="auto"
              className="glp__arena-card"
            />
          ) : (
            <CasinoPlaque entry={entry}>{joinZone}</CasinoPlaque>
          )}

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
                  {/* `stakesLabel: string | null` — null means "this row cannot
                      say its stakes", and the contract (lobbyEntries) is that
                      it then says NOTHING. Printing the heading over an empty
                      cell broke that; the board's COL_STAKES already drops the
                      cell (ITEM E audit, 2026-08-26). */}
                  {entry.stakesLabel && (
                    <div>
                      <dt>Blinds</dt>
                      <dd className="glp__mono">{entry.stakesLabel}</dd>
                    </div>
                  )}
                  <div>
                    <dt>Buy-In</dt>
                    <dd className="glp__mono">
                      {/* cashMoney honours cashBuyInRange's `unknown` flag the
                          way the card's buyInLabel does — 0/0 was "a claim
                          about money that is not merely unknown but wrong". */}
                      {cashMoney(minBuy)} - {cashMoney(maxBuy)}
                    </dd>
                  </div>
                  <div>
                    <dt>Players</dt>
                    <dd className="glp__mono">
                      {/* `|| '-'` to match the tournament row below: a table
                          with no seat count rendered "3 / 0", which reads as a
                          zero-seat table rather than an unknown one. */}
                      {entry.players} / {entry.capacity || '-'}
                    </dd>
                  </div>
                  {/* COLUMNS, not the settings blob. `settings` is {} on every
                      live cash table, so this branch never fired while the CARD
                      showed an ANTE medallion read off the column — the row and
                      the panel you open by clicking it disagreed about the same
                      table. Falls back to the blob for a table created through
                      the older modal, which does write it. */}
                  {(cashRaw?.ante_enabled === true || settings?.ante_enabled === true) && (
                    <div>
                      <dt>Ante</dt>
                      <dd className="glp__mono">
                        {Number(cashRaw?.ante ?? settings?.ante_amount) > 0
                          ? Number(cashRaw?.ante ?? settings?.ante_amount).toLocaleString()
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
                    <dd className="glp__mono">{waitlistError ? '-' : waitlist.length}</dd>
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
                  {/* Dan 2026-08-26: real names, real times. Every non-hero row
                      used to render the literal string 'Player' with a
                      fabricated ~5m-per-position ETA. The service now resolves
                      display names, and the time column shows how long each
                      player has actually been waiting (from created_at) —
                      truthful, and the only wait figure the data can prove. */}
                  <ol className="glp__waitlist">
                    {waitlist.slice(0, 10).map((w, i) => (
                      <li key={w.id || i}>
                        <span className="glp__wl-pos">{i + 1}</span>
                        <span className="glp__wl-name">
                          {w.userId && currentUserId && w.userId === currentUserId
                            ? 'You'
                            : w.displayName || 'Player'}
                        </span>
                        <span className="glp__wl-time">{waitedLabel(w.joinedAt)}</span>
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
                <nav className="glp__tabs" role="tablist" aria-label="Tournament Details">
                  {(['overview', 'structure', 'payouts'] as TournTab[]).map((t, i, all) => (
                    <button
                      key={t}
                      type="button"
                      id={`glp-tab-${t}`}
                      role="tab"
                      aria-selected={tab === t}
                      aria-controls={`glp-panel-${t}`}
                      /* Roving tabindex: a tablist is ONE tab stop, and the
                         arrows move within it. Three separate tab stops with
                         dead arrow keys is what this was, which is the exact
                         anti-pattern LobbyAdStrip documents avoiding. */
                      tabIndex={tab === t ? 0 : -1}
                      className={`glp__tab${tab === t ? ' is-active' : ''}`}
                      onClick={() => setTab(t)}
                      onKeyDown={(ev) => {
                        const step = ev.key === 'ArrowRight' ? 1 : ev.key === 'ArrowLeft' ? -1 : 0;
                        if (step === 0 && ev.key !== 'Home' && ev.key !== 'End') return;
                        ev.preventDefault();
                        const nextIdx =
                          ev.key === 'Home'
                            ? 0
                            : ev.key === 'End'
                              ? all.length - 1
                              : (i + step + all.length) % all.length;
                        const next = all[nextIdx];
                        setTab(next);
                        document.getElementById(`glp-tab-${next}`)?.focus();
                      }}
                    >
                      {t === 'overview' ? 'Overview' : t === 'structure' ? 'Structure' : 'Payouts'}
                    </button>
                  ))}
                </nav>
              )}

              {(entry.kind !== 'mtt' || tab === 'overview') && (
                <section
                  className="glp__section"
                  {...(entry.kind === 'mtt'
                    ? {
                        id: 'glp-panel-overview',
                        role: 'tabpanel',
                        'aria-labelledby': 'glp-tab-overview',
                        tabIndex: 0,
                      }
                    : {})}
                >
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
                        {/* seatsTakenLabel is the canonical rule (Dan
                            2026-08-24): a bare count for an MTT — max_players
                            is not a cap there and "45 / 500" was the exact
                            string ruled out — a fraction for spin/sng. */}
                        {seatsTakenLabel(entry)}
                      </dd>
                    </div>
                    <div>
                      <dt>Starts</dt>
                      <dd>
                        {entry.startTime && Number.isFinite(new Date(entry.startTime).getTime())
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
                <section
                  className="glp__section"
                  id="glp-panel-structure"
                  role="tabpanel"
                  aria-labelledby="glp-tab-structure"
                  tabIndex={0}
                >
                  <h3 className="glp__h">Blind Structure</h3>
                  {panelBlindLevels.length ? (
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
                          {panelBlindLevels.map((l, i) =>
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
                      {detailError
                        ? 'The Structure Could Not Be Loaded'
                        : tournament
                          ? 'No Structure Published For This Event'
                          : 'Loading Structure'}
                    </p>
                  )}
                </section>
              )}

              {entry.kind === 'mtt' && tab === 'payouts' && (
                <section
                  className="glp__section"
                  id="glp-panel-payouts"
                  role="tabpanel"
                  aria-labelledby="glp-tab-payouts"
                  tabIndex={0}
                >
                  <h3 className="glp__h">Payouts</h3>
                  {tournament && panelPayouts.length > 0 ? (
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
                            {panelPayouts.map((p) => (
                              <tr key={p.place}>
                                <td>{p.place}</td>
                                <td>{p.percentage}%</td>
                                {Number(tournament.prize_pool) > 0 && (
                                  <td>
                                    {Math.floor(
                                      ((Number(tournament.prize_pool) || 0) * p.percentage) / 100
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
                      {detailError
                        ? 'The Payouts Could Not Be Loaded'
                        : tournament
                          ? 'Payouts Are Set When The Field Closes'
                          : 'Loading Payouts'}
                    </p>
                  )}
                </section>
              )}

              {/* NO TAB CONDITION (2026-08-26). The board's Rules column is
                  gone, so this list is the only place in the app that spells a
                  game's tags out. Hiding it on Structure and Payouts left the
                  plaque medallions' `title` as the last explanation, and a
                  title attribute needs a hover this panel's traffic does not
                  have. It renders under all three tabs, as the plaque does. */}
              {entry.rules.length > 0 && (
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
                Close Table
              </button>
            )}
            {/**
             * `isEmbedded`, not `embedded` (Dan 2026-08-28 round 3).
             *
             * This link goes to a route outside /table/*, so rendering it
             * inside the in-tab lobby is a one-tap exit from the felt. It was
             * safe only because ClubHomePage passes `embedded={Boolean(
             * clubIdOverride)}` and the in-tab lobby always sets that prop —
             * a coincidence of two unrelated flags, not an invariant. An
             * optional boolean defaulting to false meant the NEXT render site
             * of this panel would silently get the escaping variant.
             *
             * The in-tab context answers the question directly: "is a lobby
             * tab hosting me right now". The prop is still honoured so
             * existing callers keep working, but the context alone is enough.
             */}
            {isEmbedded ? (
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
