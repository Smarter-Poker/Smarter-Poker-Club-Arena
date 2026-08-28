/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  MYSTERY BOUNTY CELEBRATION — the whole room hears about the big one
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Dan 2026-08-25, verbatim: "IN ANY MYSTERY BOUNTY POOL, ALL PLAYERS IN THE
 * TOURNAMENT SHOULD GET A CELEBRATION TOAST NOTIFYING ALL PLAYERS (AND
 * OBSERVERS) WHEN THE TOP 3 PRIZES ARE PULLED. IT SHOULD SAY 'KINGFISH JUST
 * PULLED THE TOP MYSTERY BOUNTY WORTH XXX' AND THEN AUTO DISAPPEAR A FEW
 * SECONDS LATER."
 *
 * ── WHY THIS IS DRIVEN BY THE SERVER AND CANNOT BE FAKED ───────────────────
 *
 * The requirement is "all players AND observers". A local event only ever
 * reaches the tab that raised it, so an observer holding no entry - the exact
 * person Dan named - would see nothing. The only thing every client shares is
 * the engine's own broadcast.
 *
 * TournamentManagerBase.broadcast() sends on the supabase channel
 * `t-break-<tournamentId>`, event `tournament_event`, shaped `{ type, payload }`
 * (server/src/tournament/TournamentManagerBase.ts:164). Every knockout in a
 * bounty event publishes there from
 * TournamentManagerEliminations.ts:1119, carrying:
 *
 *     { mode, amount, addedToHead, playerName, eliminatedName, eliminatedUserId,
 *       eliminatedAvatar, knockerName, knockerUserId, avgBounty, poolRemaining,
 *       tableId }
 *
 * That channel is a public broadcast topic, so an observer who joins it
 * receives the same message as a seated player. This component joins it and
 * nothing else. There is no local emit anywhere in this file.
 *
 * ── THE SERVER HALF, CLOSED 2026-08-26 ─────────────────────────────────────
 *
 * Two events reach this component, and both are a mystery pull:
 *
 *   - `bounty_collected` with `mode: 'mystery_pre'` - a head drawn at
 *     registration, claimed before the mystery phase opened. fn_collect_bounty
 *     returns 'pko' | 'mystery_pre' | 'regular' and never 'mystery', so the
 *     engine's old `res.mode === 'mystery'` test was dead; it now sends this
 *     name unconditionally, which is what it was already sending in practice;
 *   - `mystery_bounty_revealed` - a CHEST, from the sealed inventory. This is
 *     where the event's top prizes actually live, and it is the case Dan's
 *     requirement is about. It used to carry the money only as `amountCents`,
 *     so the amount check below saw nothing and the celebration stayed silent
 *     through exactly the moment it exists for. The engine now sends `amount`
 *     beside it (server/src/tournament/TournamentManagerEliminations.ts).
 *
 * Both now carry `prizeRank` as well, computed by the engine against the
 * event's own prize ladder - so the rank is decided once, on the server, from
 * data every client would otherwise have to re-read. rankOf() prefers it.
 *
 * ── HOW "TOP 3" IS DECIDED WHEN THE SERVER DOES NOT SAY ────────────────────
 *
 * The derivation below is the FALLBACK, kept for an engine build that predates
 * `prizeRank`. It reaches the same answer from the same data:
 *
 * A mystery head is drawn ONCE at registration and stored on
 * tournament_players.current_bounty. supabase/migrations/20260821_mystery_-
 * bounty_true_advertised_range.sql records the draw table:
 *
 *     60% x0.5    25% x1    10% x2    4% x3    1% x13
 *
 * applied to tournaments.bounty_amount - production bears this out exactly
 * (a base of 10 gives heads of 130 / 30 / 20 / 10 / 5). fn_collect_bounty
 * zeroes a head when it is claimed and writes the amount to
 * tournament_bounties, so the FULL prize ladder for an event is the distinct
 * values across both tables. The top three of those are the top three prizes,
 * and a pull qualifies when its amount reaches the third rung.
 *
 * The ladder is loaded once, from the database, before anything can fire. If
 * it cannot be loaded, NOTHING is celebrated: a guessed threshold would either
 * interrupt play for a routine head (which Dan explicitly ruled out) or stay
 * silent through a jackpot.
 *
 * An authoritative rank (`prizeRank`) or the tier the chest schema defines
 * (`tier: 'jackpot'`) WINS over the derived ladder - see rankOf().
 *
 * ── HOUSE RULES THIS FILE IS BOUND BY ──────────────────────────────────────
 *
 * POPUP LAW (Dan 2026-08-20): every popup renders First Letter Of Every Word
 * Capitalized and em dashes are forbidden. The message is passed through
 * formatPopupText - the same transform the Toast provider applies at its own
 * door - so this banner cannot drift from every other popup in the app.
 *
 * NEVER STACK, NEVER REPEAT: one celebration on screen at a time, a repeat of
 * an identical message is dropped for a full minute (matching the Toast
 * layer's own cooldown), and the banner dismisses itself. There is no button
 * to press and no retry loop.
 *
 * REDUCED MOTION: the entrance degrades to a plain fade.
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { supabase } from '../../lib/supabase';
import { formatPopupText } from '../../utils/popupStyle';
import { reportError } from '../../utils/errorReporter';
import { masterBus } from '../../core/MasterBus';
import './MysteryBountyCelebration.css';

/** How long the celebration holds the corner before it clears itself. */
const VISIBLE_MS = 6000;
/** Matches Toast's own cooldown: an identical message cannot return inside it. */
const REPEAT_COOLDOWN_MS = 60_000;
/** Fade-out runs inside VISIBLE_MS so the element is gone when it is removed. */
const EXIT_MS = 320;

/** The knockout payload the engine publishes. Every field is optional on the wire. */
interface BountyRevealPayload {
  mode?: string;
  amount?: number | string;
  knockerName?: string;
  knockerUserId?: string;
  eliminatedName?: string;
  playerName?: string;
  poolRemaining?: number | string;
  /** The engine's own 1-based rank on the event's prize ladder. Preferred. */
  prizeRank?: number;
  /** The chest schema's tier, where 'jackpot' is the top rung. */
  tier?: string;
  isJackpot?: boolean;
}

interface TournamentEventEnvelope {
  type?: string;
  payload?: BountyRevealPayload;
}

/** What is on screen right now. */
interface Celebration {
  id: number;
  text: string;
  /** 1 for the top prize, 2 or 3 for the ones below it. Drives the intensity. */
  rank: number;
}

function num(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

/** Money, grouped, whole cents. Never padStart. */
function money(n: number): string {
  const v = num(n);
  return Number.isInteger(v)
    ? v.toLocaleString()
    : v.toLocaleString(undefined, {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      });
}

/**
 * A mystery event's knockouts, under either name the engine may use.
 *
 * Exported for tests/unit/mysteryBountyCelebrationContract.test.ts, which pins
 * it against the modes fn_collect_bounty actually returns.
 */
export function isMysteryPull(type: string | undefined, data: BountyRevealPayload): boolean {
  if (type === 'mystery_bounty_revealed') return true;
  if (type !== 'bounty_collected') return false;
  const mode = String(data.mode || '').toLowerCase();
  return mode === 'mystery' || mode === 'mystery_pre';
}

/**
 * The FALLBACK rank: how many distinct prizes on `ladder` are strictly larger
 * than `amount`, plus one. `ladder` is largest first; an empty one is 0,
 * meaning unknown, which celebrates nothing.
 *
 * Exported so the parity test can prove it agrees with the engine's own
 * `prizeRankOf` for every input. If the two ever disagreed, a client on an
 * older engine build would celebrate a different set of prizes than a client
 * on a newer one, in the same tournament, at the same moment.
 */
export function rankFromLadder(amount: number, ladder: readonly number[]): number {
  if (ladder.length === 0) return 0;
  const target = Math.round(num(amount) * 100) / 100;
  if (target <= 0) return 0;

  let above = 0;
  for (const v of ladder) {
    if (v > target) above += 1;
    else break;
  }
  return above + 1;
}

export default function MysteryBountyCelebration({ tournamentId }: { tournamentId: string }) {
  const [current, setCurrent] = useState<Celebration | null>(null);
  const [exiting, setExiting] = useState(false);

  /**
   * The prize ladder, largest first, distinct values only. Empty until the
   * database answers, and an empty ladder celebrates nothing.
   */
  const ladderRef = useRef<number[]>([]);
  /** Whether this event is a mystery bounty at all, from the tournament row. */
  const isMysteryEventRef = useRef(false);
  /** Message text to the time it was last shown, for the repeat cooldown. */
  const shownRef = useRef<Map<string, number>>(new Map());
  /** Set false on unmount: the shared channel keeps the listener, we stop acting. */
  const liveRef = useRef(true);
  const idRef = useRef(0);
  /** True while a celebration owns the screen, so a second one is dropped. */
  const busyRef = useRef(false);
  const timersRef = useRef<ReturnType<typeof setTimeout>[]>([]);

  const clearTimers = () => {
    timersRef.current.forEach(clearTimeout);
    timersRef.current = [];
  };

  /* ── LOAD THE LADDER ──────────────────────────────────────────────────── */

  useEffect(() => {
    if (!tournamentId) return;
    liveRef.current = true;

    (async () => {
      try {
        const { data: row } = await supabase
          .from('tournaments')
          .select('is_mystery_bounty')
          .eq('id', tournamentId)
          .maybeSingle();
        if (!liveRef.current) return;

        isMysteryEventRef.current = !!row?.is_mystery_bounty;
        if (!isMysteryEventRef.current) return;

        /* Every prize this event ever held: the heads still sealed on live
           players, plus every head already pulled. */
        const [live, claimed] = await Promise.all([
          supabase
            .from('tournament_players')
            .select('current_bounty')
            .eq('tournament_id', tournamentId)
            .gt('current_bounty', 0),
          supabase
            .from('tournament_bounties')
            .select('bounty_amount')
            .eq('tournament_id', tournamentId),
        ]);
        if (!liveRef.current) return;

        const values = new Set<number>();
        for (const r of live.data || []) {
          const v = Math.round(num((r as { current_bounty: unknown }).current_bounty) * 100) / 100;
          if (v > 0) values.add(v);
        }
        for (const r of claimed.data || []) {
          const v = Math.round(num((r as { bounty_amount: unknown }).bounty_amount) * 100) / 100;
          if (v > 0) values.add(v);
        }
        ladderRef.current = [...values].sort((a, b) => b - a);
      } catch (e) {
        // No ladder means no celebration. Silence is the correct failure here:
        // a guessed threshold would interrupt play for a routine knockout.
        ladderRef.current = [];
        reportError(e, 'MysteryBountyCelebration.ladder_load_failed');
      }
    })();

    return () => {
      liveRef.current = false;
    };
  }, [tournamentId]);

  /* ── RANK A PULL ──────────────────────────────────────────────────────── */

  /**
   * 1-based rank of this amount among the event's distinct prizes, or 0 when
   * it cannot be established. The server's own answer is preferred whenever it
   * starts sending one.
   */
  const rankOf = useCallback((data: BountyRevealPayload): number => {
    const declared = num(data.prizeRank);
    if (declared >= 1) return Math.round(declared);
    if (data.isJackpot === true || String(data.tier || '').toLowerCase() === 'jackpot') return 1;

    return rankFromLadder(num(data.amount), ladderRef.current);
  }, []);

  /* ── SHOW ONE ─────────────────────────────────────────────────────────── */

  const raise = useCallback((text: string, rank: number) => {
    /* Never stack. A second big pull while one is on screen is dropped rather
       than queued: two celebrations in a row reads as a bug, and the second
       player's prize is still on the Rewards tab either way. */
    if (busyRef.current) return;

    const now = Date.now();
    const last = shownRef.current.get(text);
    if (last !== undefined && now - last < REPEAT_COOLDOWN_MS) return;
    shownRef.current.set(text, now);
    if (shownRef.current.size > 40) {
      for (const [k, at] of shownRef.current) {
        if (now - at > REPEAT_COOLDOWN_MS) shownRef.current.delete(k);
      }
    }

    busyRef.current = true;
    idRef.current += 1;
    setExiting(false);
    setCurrent({ id: idRef.current, text, rank });

    clearTimers();
    timersRef.current.push(
      setTimeout(() => {
        if (liveRef.current) setExiting(true);
      }, VISIBLE_MS - EXIT_MS)
    );
    timersRef.current.push(
      setTimeout(() => {
        busyRef.current = false;
        if (liveRef.current) {
          setCurrent(null);
          setExiting(false);
        }
      }, VISIBLE_MS)
    );
  }, []);

  /* ── LISTEN TO THE SERVER ─────────────────────────────────────────────── */

  useEffect(() => {
    if (!tournamentId) return;

    const channelKey = `t-break-${tournamentId}`;
    const channel = masterBus.getOrCreateChannel(channelKey);

    channel.on('broadcast', { event: 'tournament_event' }, (message: unknown) => {
      if (!liveRef.current || !isMysteryEventRef.current) return;

      const envelope = (message as { payload?: TournamentEventEnvelope })?.payload;
      const type = envelope?.type;
      const data = (envelope?.payload || {}) as BountyRevealPayload;
      if (!isMysteryPull(type, data)) return;

      const amount = num(data.amount);
      if (amount <= 0) return;

      const rank = rankOf(data);
      // Top three only. A routine head must not interrupt anybody's hand.
      if (rank < 1 || rank > 3) return;

      const puller = String(data.knockerName || '').trim() || 'A Player';
      /* Dan's wording for the top prize, kept as he wrote it. The two rungs
         below it say "A Top", because there is only one top prize and calling
         three of them "the top" is how a celebration stops meaning anything. */
      const article = rank === 1 ? 'The Top' : 'A Top';
      const text = formatPopupText(
        `${puller} Just Pulled ${article} Mystery Bounty Worth ${money(amount)}`
      );

      raise(text, rank);
    });

    if (channel.state !== 'joined') {
      try {
        channel.subscribe();
      } catch (e) {
        reportError(e, 'MysteryBountyCelebration.subscribe_failed');
      }
    }

    return () => {
      liveRef.current = false;
      clearTimers();
      busyRef.current = false;
      /* REFCOUNTED 2026-08-28. This used to leave the channel up on purpose,
         because `removeRegisteredChannel` tore a SHARED `t-break-<id>` down
         under TournamentPage and TournamentDetails and killed their level-up,
         elimination and break handling. MasterBus now counts references and
         only tears down on the last release, so the correct move is to give
         back the reference this effect took at getOrCreateChannel — holding
         it forever would pin the socket open for the life of the session. */
      masterBus.removeRegisteredChannel(`t-break-${tournamentId}`);
    };
  }, [tournamentId, rankOf, raise]);

  if (!current) return null;

  return (
    <div className="mbcel" role="status" aria-live="polite">
      <div
        key={current.id}
        className={`mbcel__card mbcel__card--r${current.rank} ${exiting ? 'mbcel__card--out' : ''}`}
      >
        <span className="mbcel__flare" aria-hidden="true" />
        <span className="mbcel__label">
          {current.rank === 1 ? 'Top Mystery Bounty' : 'Mystery Bounty'}
        </span>
        <span className="mbcel__text">{current.text}</span>
      </div>
    </div>
  );
}
