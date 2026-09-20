/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  SessionSummaryHost — the Session Complete popup, shown in the LOBBY
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Dan, 2026-08-18:
 *   "when you leave table, it should always auto take you to the lobby, your
 *    Session Complete should show up as a pop up in the lobby page. add an X
 *    off to this in the top right corner. and make this better looking and
 *    more dynamic, it looks very boring and basic at the moment."
 *
 * WHY IT LIVES AT THE APP ROOT
 *
 * Mounted once next to <ConfirmHost/>, OUTSIDE <Routes>. Two reasons: it
 * survives the navigate() away from the table (a route-level mount would be
 * torn down mid-transition), and "the lobby" is not one component - a player
 * can land on HomePage, ClubHomePage or ClubLobby depending on where they came
 * from. One root host covers all of them without editing any of them.
 *
 * The numbers arrive via services/pendingSessionSummary, because they used to
 * live in TablePage refs that die when it unmounts. See that file for why.
 *
 * ON "MORE DYNAMIC"
 *
 * The old version was a flat grid of grey boxes. This one earns the moment:
 * the P/L counts up on a spring curve, the tiles stagger in, a win gets a
 * sweep of light across the hero panel, and the card is colour-led by the
 * result instead of uniformly grey. It is all CSS-driven, and every animation
 * is disabled under prefers-reduced-motion.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate } from 'react-router-dom';
import HouseAdRotator from '../ads/HouseAdRotator';
import { useUserStore } from '../../stores/useUserStore';
import {
  clearSessionSummary,
  peekSessionSummary,
  settlePendingSummary,
  subscribeSessionSummary,
  type SessionSummaryPayload,
} from '../../services/pendingSessionSummary';
import { supabase } from '../../lib/supabase';
import { formatGameTitle } from '../../utils/formatGameTitle';
import { titleCase } from '../../utils/titleCase';
import { formatPrizeAtUnit, moneySuffixAtUnit } from '../../utils/format';
import { arenaAssetUnitCents } from '../../lib/arenaUnitCents';
import { CHIP_UNIT_CENTS, normalizeUnitCents } from '../../../server/src/tournament/tournamentUnit';
import './SessionSummaryHost.css';

/** Ease-out-back: overshoots slightly then settles. Reads as "landing". */
function easeOutBack(t: number): number {
  const c1 = 1.70158;
  const c3 = c1 + 1;
  return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2);
}

function useCountUp(target: number, durationMs: number, run: boolean): number {
  const [value, setValue] = useState(0);
  const frameRef = useRef<number | null>(null);

  useEffect(() => {
    if (!run) {
      setValue(target);
      return undefined;
    }
    // Respect the OS setting: no count-up under reduced motion, just the number.
    const reduced =
      typeof window !== 'undefined' &&
      window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    if (reduced) {
      setValue(target);
      return undefined;
    }

    const start = performance.now();
    const tick = (now: number) => {
      const t = Math.min(1, (now - start) / durationMs);
      setValue(target * easeOutBack(t));
      if (t < 1) frameRef.current = requestAnimationFrame(tick);
    };
    frameRef.current = requestAnimationFrame(tick);
    return () => {
      if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
    };
  }, [target, durationMs, run]);

  return value;
}

function formatDuration(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m`;
  return `${s}s`;
}

function formatChips(n: number): string {
  const v = Math.round(n);
  return Math.abs(v) >= 1000 ? v.toLocaleString() : String(v);
}

/**
 * THE SAME FIGURE AT THE UNIT THE SESSION WAS PLAYED IN (2026-09-20).
 *
 * The tournament tiles below are payouts - Prize, Bounties, Mystery Winnings,
 * Largest Mystery, Total Payout - and every one of them went through
 * `formatChips`, which is the chip contract. At a Diamond event that prints a
 * figure on the wrong grid and, worse, prints it with no noun at all, so "500"
 * beside a Diamond prize says nothing about what was won. `formatChips`
 * unchanged at a chip session, by construction.
 */
function chipsAtUnit(n: number, unitCents: number): string {
  return normalizeUnitCents(unitCents) === CHIP_UNIT_CENTS
    ? formatChips(n)
    : formatPrizeAtUnit(n, unitCents);
}

/**
 * Dan 2026-08-22 (mobile audit item 8): "ALL GAMES OVER .50/1 SHOULD BE
 * DISPLAYED PLO4 5/10" — whole-number stakes drop their trailing zeros.
 * "PLO4 5.00/10.00" -> "PLO4 5/10", while genuine sub-unit stakes keep their
 * decimals: "NLH 0.50/1.00" -> "NLH 0.50/1" and "0.10/0.25" is untouched.
 */
function stripWholeDecimals(title: string): string {
  return title.replace(/(\d+)\.0+(?=\D|$)/g, '$1');
}

/** 1 -> "1st", 2 -> "2nd", 3 -> "3rd", 11 -> "11th", 22 -> "22nd". */
function ordinal(n: number): string {
  const abs = Math.abs(Math.round(n));
  const tens = abs % 100;
  if (tens >= 11 && tens <= 13) return `${abs}th`;
  switch (abs % 10) {
    case 1:
      return `${abs}st`;
    case 2:
      return `${abs}nd`;
    case 3:
      return `${abs}rd`;
    default:
      return `${abs}th`;
  }
}

export function SessionSummaryHost() {
  const [payload, setPayload] = useState<SessionSummaryPayload | null>(() => peekSessionSummary());
  /* This host is mounted outside <Routes> but inside <BrowserRouter>, so it can
     route. It needs to: a house ad in this card carries its own destination. */
  const navigate = useNavigate();
  const currentClubId = useUserStore((s) => s.currentClubId);

  useEffect(() => subscribeSessionSummary(setPayload), []);

  const close = useCallback(() => {
    clearSessionSummary();
  }, []);

  /* ── Settlement reconciliation (Phase 4, 2026-08-22) ──
     While the card shows a deferred estimate, poll for the ledger row the
     engine's processLeavePending writes at settlement (wallet_transactions,
     category 'cashout', this table, this user, after the leave). When it
     lands, the module swaps the estimate for `amount - totalBuyIn` and the
     card re-renders without the annotation — the count-up re-runs on the
     corrected number, which doubles as the "this just updated" cue.

     Polling, not realtime: the card lives on screen for seconds and the
     settlement lands within one hand's tail. A realtime channel would spend
     its whole life in setup/teardown, and its failure mode (silently no
     events) is exactly the one this feature exists to close. 3s cadence,
     3 minute cap; if the row never appears the annotation simply stays,
     which remains an honest card. */
  useEffect(() => {
    const pc = payload?.plPending ? payload.pendingCashout : undefined;
    if (!pc) return undefined;

    const totalBuyIn = payload?.totalBuyIn ?? 0;
    /* 2 min of slack: the engine stamps the row from its own clock, which can
       run ahead of the client's `sinceMs`. The tableId + category filters do
       the real disambiguation; the time bound only fences off past sessions. */
    const sinceIso = new Date(pc.sinceMs - 120_000).toISOString();
    let stopped = false;

    const check = async () => {
      try {
        if (payload?.arenaAsset === 'diamonds') {
          if (!pc.occupancyId) return;
          const { data, error } = await supabase.rpc('fn_poker_diamond_cashout_receipt', {
            p_table_id: pc.tableId,
            p_occupancy_id: pc.occupancyId,
          });
          if (
            stopped ||
            error ||
            !data ||
            data.asset !== 'diamonds' ||
            data.table_id !== pc.tableId ||
            data.occupancy_id !== pc.occupancyId ||
            !Number.isSafeInteger(data.amount) ||
            data.amount < 0
          )
            return;
          settlePendingSummary(data.amount - totalBuyIn);
          return;
        }
        const { data } = await supabase
          .from('wallet_transactions')
          .select('amount, created_at')
          .eq('user_id', pc.userId)
          .eq('table_id', pc.tableId)
          .eq('category', 'cashout')
          .gte('created_at', sinceIso)
          .order('created_at', { ascending: false })
          .limit(1)
          .maybeSingle();
        if (stopped) return;
        if (data && data.amount != null) {
          settlePendingSummary(Number(data.amount) - totalBuyIn);
        }
      } catch {
        /* transient read failure — the next tick retries */
      }
    };

    void check();
    const interval = window.setInterval(() => void check(), 3000);
    const cap = window.setTimeout(() => {
      stopped = true;
      window.clearInterval(interval);
    }, 180_000);
    return () => {
      stopped = true;
      window.clearInterval(interval);
      window.clearTimeout(cap);
    };
  }, [payload]);

  // Escape closes. The old modal had no keyboard dismissal at all.
  useEffect(() => {
    if (!payload) return undefined;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [payload, close]);

  /* Dan 2026-08-20: "tournaments are never displayed by chips, only what place
     you finished and how much you made." The presence of the tournament block
     switches both the hero and the tiles. */
  const tourney = payload?.tournament;
  const isTournament = !!tourney;

  /* THE GRID THIS SESSION WAS PLAYED ON (2026-09-20). The payload already
     carries the table's arena asset - the cash hero line below has appended
     " Diamonds" from it since the wallet learned the arena - and
     `parseArenaIdentity` only writes 'diamonds' for a row satisfying all three
     conditions `fn_ca_tournament_unit_cents` tests, so it IS the unit. The
     tournament tiles now read it too. */
  const unitCents = arenaAssetUnitCents(payload?.arenaAsset);
  const unitSuffix = moneySuffixAtUnit(unitCents);

  /* A tournament "wins" by cashing, not by ending with more chips than you sat
     down with — tournament chips are not money. */
  const totalWon = (tourney?.prize ?? 0) + (tourney?.bountyWinnings ?? 0);
  const isProfit = isTournament ? totalWon > 0 : (payload?.profitLoss ?? 0) >= 0;

  const heroTarget = isTournament ? totalWon : (payload?.profitLoss ?? 0);
  const displayPL = useCountUp(heroTarget, 900, !!payload);

  const stats = useMemo(() => {
    if (!payload) return [];
    const handsPerHour =
      payload.duration > 60 ? Math.round((payload.handsPlayed / payload.duration) * 3600) : 0;

    if (payload.tournament) {
      const t = payload.tournament;
      /* Deliberately no profit/loss, biggest pot, peak stack or win rate here.
         Every one of those is a chip statistic, and the screenshot that
         prompted this showed them as a wall of zeroes next to a meaningless
         "+265 profit" for a tournament seat. */
      /* Title Case throughout, and no em dashes (Dan 2026-08-20). The unknown
         placeholder was an em dash; it is a plain hyphen now. */
      const out = [
        {
          label: 'Finished',
          value: t.finishPlace != null ? ordinal(t.finishPlace) : '-',
        },
        { label: 'Entrants', value: t.entrants != null ? String(t.entrants) : '-' },
        { label: 'Prize', value: `${chipsAtUnit(t.prize, unitCents)}${unitSuffix}` },
        { label: 'Duration', value: formatDuration(payload.duration) },
        { label: 'Hands Played', value: String(payload.handsPlayed) },
        { label: 'Hands Per Hour', value: String(handsPerHour) },
      ];
      if (t.knockouts > 0) out.push({ label: 'Knockouts', value: String(t.knockouts) });
      if (t.bountyWinnings > 0) {
        out.push({
          label: 'Bounties',
          value: `${chipsAtUnit(t.bountyWinnings, unitCents)}${unitSuffix}`,
        });
      }
      /* MYSTERY BOUNTY (Dan section 43). The chest half, broken out from the
         Bounties tile above, which also holds the flat bounties paid before the
         mystery phase opened. Cents on the payload, divided by 100 here. */
      const mysteryCount = Number(t.mysteryBounties) || 0;
      const mysteryCents = Number(t.mysteryBountyCents) || 0;
      const mysteryLargestCents = Number(t.largestMysteryBountyCents) || 0;
      if (mysteryCount > 0) {
        out.push({ label: 'Mystery Bounties', value: String(mysteryCount) });
      }
      if (mysteryCents > 0) {
        out.push({
          label: 'Mystery Winnings',
          value: `${chipsAtUnit(mysteryCents / 100, unitCents)}${unitSuffix}`,
        });
      }
      if (mysteryLargestCents > 0) {
        out.push({
          label: 'Largest Mystery',
          value: `${chipsAtUnit(mysteryLargestCents / 100, unitCents)}${unitSuffix}`,
        });
      }
      /* Section 44: the total is prize + bounty, and it is only worth a tile of
         its own when the two differ. */
      if (t.bountyWinnings > 0) {
        out.push({
          label: 'Total Payout',
          value: `${chipsAtUnit(t.prize + t.bountyWinnings, unitCents)}${unitSuffix}`,
        });
      }
      if (t.rebuys > 0) out.push({ label: 'Rebuys', value: String(t.rebuys) });
      if (t.addOns > 0) out.push({ label: 'Add Ons', value: String(t.addOns) });
      return out;
    }

    const winRate =
      payload.handsPlayed > 0 ? Math.round((payload.handsWon / payload.handsPlayed) * 100) : 0;

    /* Dan 2026-08-22 (mobile audit item 8): Hands Per Hour is gone from the
       cash card — VPIP takes its slot — and the total buy-in gets a tile. */
    const out = [
      { label: 'Duration', value: formatDuration(payload.duration) },
      { label: 'Hands Played', value: String(payload.handsPlayed) },
      { label: 'VPIP', value: `${payload.vpipPercent ?? 0}%` },
      /* Dan 2026-08-23: "remove biggest pot as a field". It was the one tile
         that measured the TABLE rather than the session — the biggest pot you
         saw, win or lose, which says nothing about how you did. */
      { label: 'Peak Stack', value: formatChips(payload.peakStack) },
      { label: 'Win Rate', value: `${winRate}%` },
    ];
    if (payload.totalBuyIn != null && payload.totalBuyIn > 0) {
      /* Dan 2026-08-26 mobile pass, item 12: "Buy In", not "Buy In's". */
      out.push({ label: 'Buy In', value: formatChips(payload.totalBuyIn) });
    }
    if (payload.totalRebuys > 0) {
      out.push({ label: 'Rebuys', value: String(payload.totalRebuys) });
    }
    return out;
  }, [payload, unitCents, unitSuffix]);

  /* Dan 2026-08-20 gave a reference for the tournament card, and it is a
     different card entirely — RANKING, a medal, a place band, Stay Observing /
     Play Again. TournamentRankingHost owns that one and reads the same feed,
     so this host stands down whenever the payload carries a tournament result.
     The split is on the data, not a flag: a tournament cannot fall through to
     the cash summary and report a chip profit on a seat where chips are not
     money. */
  const [shareLabel, setShareLabel] = useState('Share');

  const share = useCallback(async () => {
    if (!payload) return;
    const money = `${payload.profitLoss >= 0 ? '+' : '-'}${formatChips(Math.abs(payload.profitLoss))}`;
    const text =
      `${payload.tableName || 'Table Session'} - ${money}${payload.arenaAsset === 'diamonds' ? ' Diamonds' : ''} over ` +
      `${payload.handsPlayed} hands on Smarter.Poker`;

    try {
      if (typeof navigator !== 'undefined' && navigator.share) {
        await navigator.share({ title: 'Session Complete', text });
        return;
      }
      await navigator.clipboard.writeText(text);
      setShareLabel('Copied');
      window.setTimeout(() => setShareLabel('Share'), 1800);
    } catch {
      /* A cancelled share sheet rejects. That is the player changing their
         mind, not a failure, and it must not raise anything at them. */
    }
  }, [payload]);

  if (!payload || payload.tournament) return null;
  if (typeof document === 'undefined') return null;

  return createPortal(
    <div className="ssh-overlay" onClick={close} role="presentation">
      <div
        /* Two distinct cards, not one card with different numbers in it
           (Dan 2026-08-20). --tourney repaints the whole surface cyan so a
           player knows which kind of result they are reading before they read
           a word of it; --win/--loss still tints the money line. */
        className={`ssh-card ${isTournament ? 'ssh-card--tourney ' : ''}${
          isProfit ? 'ssh-card--win' : 'ssh-card--loss'
        }`}
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby="ssh-title"
      >
        {/* Dan asked for an X in the top-right. The old modal could only be
            dismissed by the backdrop or the big button. */}
        <button className="ssh-close" onClick={close} aria-label="Close Session Summary">
          &times;
        </button>

        <header className="ssh-head">
          <span className="ssh-eyebrow">
            {isTournament ? 'Tournament Complete' : 'Session Complete'}
          </span>
          <h2 className="ssh-title" id="ssh-title">
            {/* titleCase runs BEFORE formatGameTitle: it capitalises the words
                and strips any em dash out of a club-authored table name, then
                formatGameTitle shouts the variant acronyms back to NLH/PLO4.
                Reversing the order would let titleCase re-case "NLH" to "Nlh". */}
            {stripWholeDecimals(
              formatGameTitle(
                titleCase(
                  (isTournament ? tourney?.name : undefined) ||
                    payload.tableName ||
                    (isTournament ? 'Tournament' : 'Table Session')
                )
              )
            )}
          </h2>
          {payload.sessionEnd && (
            <div className="ssh-date">
              {new Date(payload.sessionEnd).toLocaleDateString()} At{' '}
              {new Date(payload.sessionEnd).toLocaleTimeString([], {
                hour: 'numeric',
                minute: '2-digit',
              })}
            </div>
          )}
        </header>

        {isTournament ? (
          /* The result IS the finish. Place leads, money follows — the reverse
             of the cash panel, where the money is the whole story. */
          <div className="ssh-hero ssh-hero--tourney">
            <span className="ssh-hero__label">
              {tourney?.finishPlace != null ? 'Finished' : 'Result'}
            </span>
            <span className="ssh-hero__value">
              {tourney?.finishPlace != null ? ordinal(tourney.finishPlace) : '-'}
            </span>
            {tourney?.entrants != null && tourney.entrants > 0 && (
              <span className="ssh-hero__sub">Of {tourney.entrants.toLocaleString()} Entrants</span>
            )}
            <span className="ssh-hero__sub ssh-hero__sub--money">
              {totalWon > 0 ? `Won ${chipsAtUnit(displayPL, unitCents)}${unitSuffix}` : 'No Prize'}
            </span>
            <span className="ssh-hero__sweep" aria-hidden="true" />
          </div>
        ) : (
          <div className="ssh-hero">
            <span className="ssh-hero__label">{isProfit ? 'Profit' : 'Loss'}</span>
            <span className="ssh-hero__value">
              {isProfit ? '+' : '-'}
              {formatChips(Math.abs(displayPL))}
              {payload.arenaAsset === 'diamonds' ? ' Diamonds' : ''}
            </span>
            {/* Phase 3 (2026-08-22): a mid-hand leave defers the cashout to
                settlement, so this figure is the live stack at the moment of
                leaving, not the settled number. Say so, rather than presenting
                an estimate as fact. Title Case, no em dashes (house popup
                rules). */}
            {payload.plPending && (
              <span className="ssh-hero__sub ssh-hero__sub--pending">Pending Settlement</span>
            )}
            <span className="ssh-hero__sweep" aria-hidden="true" />
          </div>
        )}

        <div className="ssh-grid">
          {stats.map((s, i) => (
            <div
              className="ssh-tile"
              key={s.label}
              /* Stagger: each tile lands a beat after the one before it. */
              style={{ animationDelay: `${120 + i * 55}ms` }}
            >
              <span className="ssh-tile__value">{s.value}</span>
              <span className="ssh-tile__label">{s.label}</span>
            </div>
          ))}
        </div>

        {/* HOUSE ADS, `session_summary` (2026-08-28; pictures 2026-09-03).
            Three rotating 3:1 creatives under the numbers and above the
            actions, so they never come between a player and Done.

            The club comes from useUserStore.currentClubId: this host lives at
            the app root and survives the navigate() off the table, so it has
            no route club in hand, but the store remembers the last one the
            player was in. That is what lets Spins and the jackpot, whose
            destinations carry {clubId}, be placed here at all. When the store
            has nothing the resolver drops those rows rather than serving a
            link it knows is broken. */}
        {/* close() BEFORE navigate(), and it is not tidiness. This host is a
            createPortal overlay that nothing but clearSessionSummary() takes
            down: the backdrop closes it, but the card stops propagation, and
            the ad lives inside the card. Navigating without closing routed the
            page underneath a Session Complete panel still covering it, with
            the click already logged - so the panel read it as a campaign that
            worked while the player was looking at a dead end. */}
        <HouseAdRotator
          slot="session_summary"
          clubId={currentClubId}
          onNavigate={(path) => {
            close();
            navigate(path);
          }}
        />

        {/* Dan 2026-08-23: "add a share button to this." Uses the platform
            share sheet where there is one (every phone, and desktop Safari),
            and falls back to the clipboard everywhere else — a share control
            that silently does nothing on desktop is worse than none. */}
        <div className="ssh-actions">
          <button className="ssh-share" onClick={share} aria-label="Share This Session">
            {shareLabel}
          </button>
          <button className="ssh-done" onClick={close}>
            Done
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
}

export default SessionSummaryHost;
