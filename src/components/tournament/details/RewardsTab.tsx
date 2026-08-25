/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  REWARDS — what this event pays, and what is left to be pulled out of it
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Dan 2026-08-25, verbatim: "REWARDS PAGE SHOULD SHOW ALL THE PAYOUTS IN ORDER
 * ONLY. IF ITS A BOUNTY SHOW THE BOUNTY POOL. IF ITS A MYSTERY BOUNTY SHOW THE
 * TOTAL BOUNTY POOL AND WHATS LEFT OR 'STILL AVAILABLE' IN THE MYSTERY BOUNTY
 * POOL."
 *
 * The block this replaces (TournamentDetails.tsx:1628-1827) printed the payout
 * list and then printed THE FIRST TEN LEVELS OF THE BLIND STRUCTURE underneath
 * it. The Blinds tab already owns that table in full, so the lobby showed the
 * same levels twice, disagreeing on how many. There is no blind structure in
 * this file and there must never be one again: a tab that answers two questions
 * answers neither, and the duplicate is what Dan actually complained about.
 *
 * ── WHERE EVERY NUMBER COMES FROM (checked against production, not assumed) ──
 *
 *   prize pool          tournaments.prize_pool          (numeric, server owns
 *                       it: recalculated on every registration / rebuy / add-on
 *                       with the fee stripped and horses excluded)
 *   guarantee           tournaments.guaranteed_prize    (numeric)
 *   settled or not      tournaments.prize_pool_finalized (boolean, 20,880 rows
 *                       set) - the ONLY honest way to know whether these
 *                       figures are final or still moving
 *   payout structure    tournaments.payout_structure    (TEXT holding JSON)
 *   bounty flags        tournaments.is_bounty / is_pko / is_mystery_bounty
 *   funded bounty pool  tournaments.bounty_pool / bounty_pool_paid (numeric,
 *                       457 / 449 rows populated - these are real money columns
 *                       maintained by fn_collect_bounty)
 *   base head value     tournaments.bounty_amount
 *   live heads          tournament_players.current_bounty (9,011 rows > 0)
 *   claimed heads       tournament_bounties.bounty_amount (6,790 rows)
 *
 * ── THE MYSTERY LADDER IS REAL, AND IT IS NOT WHERE YOU WOULD LOOK ──────────
 *
 * There IS a chest-inventory schema in production: tournament_bounty_chests
 * (seq, tier, amount_cents, status) with fn_mystery_bounty_inventory() to read
 * it. It holds ZERO ROWS and NOTHING in either repo calls those RPCs. Reading
 * it would render an empty tab on every live event, so this file does not.
 *
 * The ladder that actually exists is the draw taken at registration and stored
 * on the player's head. supabase/migrations/20260821_mystery_bounty_true_-
 * advertised_range.sql records the table:
 *
 *     60% x0.5    25% x1    10% x2    4% x3    1% x13
 *
 * against tournaments.bounty_amount, which is exactly what production shows -
 * a base of 10 yields heads of 130 / 30 / 20 / 10 / 5. So the prizes still in
 * the pool are the non-zero current_bounty values (fn_collect_bounty zeroes a
 * head the moment it is claimed) and the prizes already pulled are the
 * tournament_bounties rows. The top prizes are the largest distinct values
 * across both. Nothing here is invented: every figure is a column.
 *
 * ── ONE QUERY, AND ONLY WHEN IT IS NEEDED ──────────────────────────────────
 *
 * types.ts asks tabs to prefer props. The props carry the tournament row, so
 * the entire payout side of this tab is computed with no query at all. The two
 * bounty queries fire ONLY for a bounty event, are cancelled on unmount, and
 * tolerate an empty result: a bounty panel that never resolves is worse than
 * one that says the pool has not been funded yet.
 */

import React, { useEffect, useMemo, useState } from 'react';
import { supabase } from '../../../lib/supabase';
import { reportError } from '../../../utils/errorReporter';
import type { TournamentTabProps, TournamentEntry } from './types';
import { chips, ordinal } from './types';
import '../../../styles/tournament-lobby-3d.css';
import './RewardsTab.css';

/* ═══════════════════════════════════════════════════════════════════════════
   PAYOUT STRUCTURE
   ═══════════════════════════════════════════════════════════════════════════ */

/** One paid finishing position. */
interface PayoutPlace {
  place: number;
  percentage: number;
}

/**
 * A run of consecutive places paying the same percentage: 1st, 2nd, 3rd, then
 * 4-6, 7-9. Dan asked for the ranges "exactly as the structure defines", so a
 * band is only formed where the STORED structure gives neighbouring places an
 * identical percentage. Nothing is merged for tidiness.
 */
interface PayoutBand {
  fromPlace: number;
  toPlace: number;
  percentage: number;
}

/** Coerce anything the column might hold into a finite number. */
function num(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Parse `payout_structure`, which is a TEXT column holding JSON and has been
 * written by four different generations of code. Accepts a per-place row
 * ({ place | position, percentage }) and the range shapes some builders emit
 * ({ from, to } or place: "4-6"), and returns one entry per PLACE so banding
 * below has a single shape to work from.
 *
 * Returns null - not an empty array - when the column is unusable, so the
 * caller can tell "no structure published" from "a structure that pays nobody".
 */
function parsePayoutStructure(raw: unknown): PayoutPlace[] | null {
  let value: unknown = raw;
  if (typeof value === 'string') {
    if (!value.trim()) return null;
    try {
      value = JSON.parse(value);
    } catch {
      return null;
    }
  }
  if (!Array.isArray(value) || value.length === 0) return null;

  const places: PayoutPlace[] = [];
  for (const row of value as Record<string, unknown>[]) {
    if (!row || typeof row !== 'object') continue;
    const percentage = num(row.percentage ?? row.percent ?? row.pct);
    if (percentage <= 0) continue;

    // Range shapes first, because a range row also carries a `place`.
    const from = num(row.from ?? row.fromPlace ?? row.start);
    const to = num(row.to ?? row.toPlace ?? row.end);
    if (from >= 1 && to >= from && to - from < 5000) {
      for (let p = from; p <= to; p++) places.push({ place: p, percentage });
      continue;
    }

    const rawPlace = row.place ?? row.position ?? row.rank;
    if (typeof rawPlace === 'string' && rawPlace.includes('-')) {
      const [a, b] = rawPlace.split('-').map((s) => num(s.trim()));
      if (a >= 1 && b >= a && b - a < 5000) {
        for (let p = a; p <= b; p++) places.push({ place: p, percentage });
        continue;
      }
    }

    const place = num(rawPlace);
    if (place >= 1) places.push({ place, percentage });
  }

  if (places.length === 0) return null;

  // De-duplicate on place (last write wins) and order the field.
  const byPlace = new Map<number, number>();
  for (const p of places) byPlace.set(p.place, p.percentage);
  return [...byPlace.entries()]
    .map(([place, percentage]) => ({ place, percentage }))
    .sort((a, b) => a.place - b.place);
}

/** Collapse consecutive places paying the same percentage into one band. */
function toBands(places: PayoutPlace[]): PayoutBand[] {
  const bands: PayoutBand[] = [];
  for (const p of places) {
    const last = bands[bands.length - 1];
    if (last && last.percentage === p.percentage && last.toPlace === p.place - 1) {
      last.toPlace = p.place;
    } else {
      bands.push({ fromPlace: p.place, toPlace: p.place, percentage: p.percentage });
    }
  }
  return bands;
}

/** "1st" for a single place, "4-6" for a band. A hyphen, never a dash. */
function bandLabel(band: PayoutBand): string {
  return band.fromPlace === band.toPlace
    ? ordinal(band.fromPlace)
    : `${band.fromPlace}-${band.toPlace}`;
}

/**
 * What one place is paid.
 *
 * The same arithmetic as TournamentService.calculatePayout (multiply, truncate,
 * divide) so the lobby and the money agree to the cent. A rounding difference
 * here reads to a player as the site quietly shaving their prize.
 */
function placePrize(pool: number, percentage: number): number {
  return Math.trunc(pool * percentage) / 100;
}

/** Percentages print without a trailing ".0" but keep a real decimal. */
function pct(n: number): string {
  return `${Number.isInteger(n) ? n : Number(n.toFixed(2))}%`;
}

/* ═══════════════════════════════════════════════════════════════════════════
   BOUNTY POOL
   ═══════════════════════════════════════════════════════════════════════════ */

/** One rung of the mystery ladder: a distinct prize value and its fate. */
interface LadderRung {
  amount: number;
  available: number;
  claimed: number;
}

interface BountyLedger {
  /** Heads still sitting on live players, i.e. prizes nobody has pulled. */
  liveHeads: number[];
  /** Every head already claimed, from the tournament_bounties ledger. */
  claimedHeads: number[];
  loaded: boolean;
}

const EMPTY_LEDGER: BountyLedger = { liveHeads: [], claimedHeads: [], loaded: false };

/** Round money to cents so 20.000000001 and 20 are the same rung. */
function cents(n: number): number {
  return Math.round(num(n) * 100) / 100;
}

/**
 * Tournament columns this tab reads that `Tournament` does not declare by name.
 * The interface carries an index signature so these resolve, but naming them
 * here is what makes the tab readable.
 */
interface RewardColumns {
  prize_pool?: number | null;
  guaranteed_prize?: number | null;
  prize_pool_finalized?: boolean | null;
  payout_structure?: unknown;
  is_bounty?: boolean | null;
  is_pko?: boolean | null;
  is_mystery_bounty?: boolean | null;
  bounty_amount?: number | null;
  bounty_pool?: number | null;
  bounty_pool_paid?: number | null;
  mystery_bounty_min?: number | null;
  mystery_bounty_max?: number | null;
  status?: string | null;
  current_players?: number | null;
}

/** Still holding chips, by the lobby's own definition of "in". */
function isStillIn(e: TournamentEntry): boolean {
  return e.status === 'registered' || e.status === 'playing';
}

export default function RewardsTab({ tournament, entries, currentUserId }: TournamentTabProps) {
  const t = (tournament || {}) as unknown as RewardColumns;
  const tournamentId = tournament?.id;

  const isPko = !!t.is_pko;
  const isMystery = !!t.is_mystery_bounty;
  const isBountyEvent = !!t.is_bounty || isPko || isMystery;

  const [ledger, setLedger] = useState<BountyLedger>(EMPTY_LEDGER);

  /* Two queries, bounty events only, cancelled on unmount. */
  useEffect(() => {
    if (!tournamentId || !isBountyEvent) {
      setLedger(EMPTY_LEDGER);
      return;
    }
    let cancelled = false;

    (async () => {
      try {
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
        if (cancelled) return;

        setLedger({
          liveHeads: (live.data || []).map((r: { current_bounty: unknown }) =>
            cents(num(r.current_bounty))
          ),
          claimedHeads: (claimed.data || []).map((r: { bounty_amount: unknown }) =>
            cents(num(r.bounty_amount))
          ),
          loaded: true,
        });
      } catch (e) {
        if (!cancelled) {
          // A bounty panel that cannot load its ledger still renders from the
          // tournament's own funded-pool columns. Degraded, never blank.
          setLedger({ liveHeads: [], claimedHeads: [], loaded: true });
          reportError(e, 'RewardsTab.bounty_ledger_load_failed');
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [tournamentId, isBountyEvent]);

  /* ── FIELD STATE ──────────────────────────────────────────────────────── */

  const isRunning = String(t.status || '').toUpperCase() === 'RUNNING';
  const isComplete = String(t.status || '').toUpperCase() === 'COMPLETED';

  const entryCount = entries.length || num(t.current_players);
  const playersRemaining = useMemo(() => {
    const live = entries.filter(isStillIn).length;
    return live > 0 ? live : isRunning ? num(t.current_players) : entryCount;
  }, [entries, isRunning, t.current_players, entryCount]);

  /* ── THE POOL ─────────────────────────────────────────────────────────── */

  const dbPool = num(t.prize_pool);
  const guarantee = num(t.guaranteed_prize);
  const hasGuarantee = guarantee > 0;
  /* The advertised pool is whichever is larger. The DB pool is authoritative
     for what was actually collected; the guarantee is what the club promised,
     and the difference is the overlay the club funds itself. */
  const effectivePool = hasGuarantee ? Math.max(dbPool, guarantee) : dbPool;
  const overlay = hasGuarantee ? Math.max(0, guarantee - dbPool) : 0;
  const guaranteeMet = hasGuarantee && overlay <= 0;

  const isFinalised = !!t.prize_pool_finalized;

  /* ── THE LADDER OF PLACES ─────────────────────────────────────────────── */

  const parsedPlaces = useMemo(
    () => parsePayoutStructure(t.payout_structure),
    [t.payout_structure]
  );
  const bands = useMemo(() => (parsedPlaces ? toBands(parsedPlaces) : []), [parsedPlaces]);
  const paidPlaces = parsedPlaces ? parsedPlaces.length : 0;

  /**
   * PROVISIONAL means the figures can still move. Two independent reasons, and
   * both matter: an unfinalised pool moves with every late registration and
   * rebuy, and a missing structure means nobody has decided how many places
   * get paid. Neither is presented as settled fact.
   */
  const provisionalReason = !parsedPlaces
    ? 'No Payout Structure Has Been Published For This Event Yet'
    : !isFinalised && !isComplete
      ? 'Provisional. The Prize Pool Is Still Moving With Entries, Rebuys And Add Ons'
      : null;

  /* ── THE BUBBLE ───────────────────────────────────────────────────────── */

  /* The money bubble is the LAST PAID PLACE. Players still to bust before it
     is how many must go out before the field is all in the money. */
  const bubblePlace = paidPlaces > 0 ? paidPlaces : 0;
  const toTheMoney = bubblePlace > 0 ? Math.max(0, playersRemaining - bubblePlace) : 0;
  const inTheMoney = bubblePlace > 0 && playersRemaining <= bubblePlace;
  const onTheBubble = bubblePlace > 0 && playersRemaining === bubblePlace + 1;

  /* ── THE HERO ─────────────────────────────────────────────────────────── */

  const hero = useMemo(
    () => (currentUserId ? entries.find((e) => e.user_id === currentUserId) : undefined),
    [entries, currentUserId]
  );
  const heroStillIn = !!hero && isStillIn(hero);
  const heroFinish = hero?.position && hero.position > 0 ? hero.position : null;

  /**
   * Which line belongs to the hero.
   *
   * Settled once they have a finishing position. While they are still playing
   * the only defensible projection is the place they would take if they busted
   * on the very next hand, which is exactly `playersRemaining` - and it is
   * labelled as that, not as a prediction of where they will finish.
   */
  const heroPlace = heroFinish ?? (heroStillIn && isRunning ? playersRemaining : null);
  const heroBandIndex = useMemo(() => {
    if (!heroPlace) return -1;
    return bands.findIndex((b) => heroPlace >= b.fromPlace && heroPlace <= b.toPlace);
  }, [bands, heroPlace]);

  /* ── BOUNTY MONEY ─────────────────────────────────────────────────────── */

  const bounty = useMemo(() => {
    if (!isBountyEvent) return null;

    const perKnockout = num(t.bounty_amount);
    const fundedPool = num(t.bounty_pool);
    const fundedPaid = num(t.bounty_pool_paid);

    const liveTotal = ledger.liveHeads.reduce((s, v) => s + v, 0);
    const claimedTotal = ledger.claimedHeads.reduce((s, v) => s + v, 0);

    /* The funded columns are money the server maintains inside the same
       transaction that pays a bounty, so they win when they exist. The head
       ledger is the fallback for an event whose pool was never funded as a
       lump (bounty_pool = 0), where the heads themselves ARE the pool. */
    const total = fundedPool > 0 ? fundedPool : claimedTotal + liveTotal;
    const claimed = fundedPool > 0 ? fundedPaid : claimedTotal;
    const available = Math.max(0, total - claimed);
    const drained = total > 0 ? Math.min(100, Math.max(0, (available / total) * 100)) : 0;

    /* The top rungs, largest first, across prizes pulled AND prizes still in.
       A value that appears in both is partly claimed and partly still out
       there, which is exactly what a player wants to know. */
    const rungs = new Map<number, LadderRung>();
    for (const v of ledger.liveHeads) {
      if (v <= 0) continue;
      const r = rungs.get(v) || { amount: v, available: 0, claimed: 0 };
      r.available += 1;
      rungs.set(v, r);
    }
    for (const v of ledger.claimedHeads) {
      if (v <= 0) continue;
      const r = rungs.get(v) || { amount: v, available: 0, claimed: 0 };
      r.claimed += 1;
      rungs.set(v, r);
    }
    const ladder = [...rungs.values()].sort((a, b) => b.amount - a.amount).slice(0, 3);

    return {
      perKnockout,
      total,
      claimed,
      available,
      drained,
      ladder,
      knockoutsPaid: ledger.claimedHeads.length,
    };
  }, [isBountyEvent, t.bounty_amount, t.bounty_pool, t.bounty_pool_paid, ledger]);

  const bountyKind = isMystery ? 'Mystery Bounty' : isPko ? 'Progressive Knockout' : 'Bounty';

  /* ═════════════════════════════════════════════════════════════════════════
     RENDER
     ═════════════════════════════════════════════════════════════════════════ */

  return (
    <div className="rw">
      {/* ── HEADLINE: the pool, the guarantee, the bubble ─────────────────── */}
      <section className="tl-panel rw-head">
        <div className="tl-section-head">
          <h3>Prizes</h3>
          {paidPlaces > 0 && (
            <span className="tl-section-note">
              {paidPlaces} Paid {paidPlaces === 1 ? 'Place' : 'Places'}
            </span>
          )}
        </div>

        <div className="tl-stat-grid">
          <div className="tl-stat tl-stat--feature rw-pool">
            <span className="tl-stat__label">Total Prize Pool</span>
            <span className="tl-stat__value tl-stat__value--accent rw-pool__value">
              {effectivePool > 0 ? chips(effectivePool) : 'Set By Entries'}
            </span>
            <span className="tl-stat__sub">
              {isFinalised || isComplete ? 'Final' : 'Still Growing'}
            </span>
          </div>

          {hasGuarantee && (
            <div className="tl-stat">
              <span className="tl-stat__label">Guaranteed</span>
              <span className="tl-stat__value">{chips(guarantee)}</span>
              <span className={`tl-stat__sub ${guaranteeMet ? 'rw-sub--good' : 'rw-sub--warn'}`}>
                {guaranteeMet ? 'Guarantee Met' : `${chips(overlay)} Overlay`}
              </span>
            </div>
          )}

          <div className="tl-stat">
            <span className="tl-stat__label">Entries</span>
            <span className="tl-stat__value">{chips(entryCount)}</span>
            {isRunning && <span className="tl-stat__sub">{chips(playersRemaining)} Left</span>}
          </div>

          {bubblePlace > 0 && (
            <div className="tl-stat">
              <span className="tl-stat__label">Money Bubble</span>
              <span className="tl-stat__value">{ordinal(bubblePlace)}</span>
              <span className="tl-stat__sub">
                {!isRunning
                  ? 'Last Paid Place'
                  : inTheMoney
                    ? 'Field Is In The Money'
                    : onTheBubble
                      ? 'One Player To Go'
                      : `${chips(toTheMoney)} To Bust`}
              </span>
            </div>
          )}
        </div>

        {hasGuarantee && !guaranteeMet && effectivePool > 0 && (
          <div className="rw-gtd">
            <div className="rw-gtd__row">
              <span className="rw-gtd__label">Collected Against The Guarantee</span>
              <span className="rw-gtd__figure">
                {chips(dbPool)} Of {chips(guarantee)}
              </span>
            </div>
            <div className="tl-meter">
              <div
                className="tl-meter__fill tl-meter__fill--under"
                style={{ width: `${Math.min(100, (dbPool / guarantee) * 100)}%` }}
              />
            </div>
            <p className="rw-gtd__note">
              The Club Covers The {chips(overlay)} Overlay If The Field Does Not Close It
            </p>
          </div>
        )}

        {provisionalReason && <p className="rw-provisional">{provisionalReason}</p>}
      </section>

      {/* ── THE PAYOUTS, IN FINISHING ORDER, AND NOTHING ELSE ─────────────── */}
      <section className="tl-panel rw-payouts">
        <div className="tl-section-head">
          <h3>Payouts</h3>
          {effectivePool > 0 && paidPlaces > 0 && (
            <span className="tl-section-note">
              {Math.round((paidPlaces / Math.max(1, entryCount)) * 1000) / 10}% Of The Field Paid
            </span>
          )}
        </div>

        {bands.length === 0 ? (
          <div className="tl-empty">
            No Payout Structure Yet
            <span className="tl-empty__hint">
              The Places Are Set When The Field Closes. Check Back At The Start.
            </span>
          </div>
        ) : (
          <ul className="tl-list rw-list">
            {bands.map((band, i) => {
              const isPodium = band.fromPlace <= 3 && band.fromPlace === band.toPlace;
              const isBubbleRow = band.toPlace === bubblePlace;
              const isHeroRow = i === heroBandIndex;
              const prize = effectivePool > 0 ? placePrize(effectivePool, band.percentage) : 0;

              return (
                <li
                  key={`${band.fromPlace}-${band.toPlace}`}
                  className={[
                    'tl-row',
                    'rw-row',
                    isPodium ? `rw-row--podium rw-row--p${band.fromPlace}` : '',
                    isHeroRow ? 'tl-row--hero' : '',
                    isBubbleRow ? 'rw-row--bubble' : '',
                  ]
                    .filter(Boolean)
                    .join(' ')}
                >
                  <span className={`tl-rank rw-rank ${isPodium ? 'tl-rank--podium' : ''}`}>
                    {bandLabel(band)}
                  </span>

                  <span className="rw-row__mid">
                    <span className="rw-pct">{pct(band.percentage)}</span>
                    {isHeroRow && (
                      <span className="tl-badge tl-badge--action rw-tag">
                        {heroFinish ? 'Your Finish' : 'You If You Bust Now'}
                      </span>
                    )}
                    {isBubbleRow && !isHeroRow && (
                      <span className="tl-badge tl-badge--mute rw-tag">Money Bubble</span>
                    )}
                  </span>

                  <span className="tl-num tl-num--accent rw-prize">
                    {prize > 0 ? chips(prize) : '-'}
                  </span>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      {/* ── BOUNTY POOL ──────────────────────────────────────────────────── */}
      {isBountyEvent && bounty && (
        <section className="tl-panel rw-bounty">
          <div className="tl-section-head">
            <h3>{bountyKind} Pool</h3>
            <span className="tl-badge">{isMystery ? 'Mystery' : isPko ? 'PKO' : 'Knockout'}</span>
          </div>

          {bounty.total <= 0 && !ledger.loaded ? (
            <div className="tl-empty">Loading The Bounty Pool</div>
          ) : bounty.total <= 0 ? (
            <div className="tl-empty">
              The Bounty Pool Is Not Funded Yet
              <span className="tl-empty__hint">
                Heads Are Set When Players Register. The Pool Fills As The Field Does.
              </span>
            </div>
          ) : (
            <>
              <div className="tl-stat-grid rw-bounty__stats">
                <div className="tl-stat">
                  <span className="tl-stat__label">Total Pool</span>
                  <span className="tl-stat__value">{chips(bounty.total)}</span>
                </div>
                <div className="tl-stat">
                  <span className="tl-stat__label">Claimed</span>
                  <span className="tl-stat__value">{chips(bounty.claimed)}</span>
                  <span className="tl-stat__sub">
                    {chips(bounty.knockoutsPaid)}{' '}
                    {bounty.knockoutsPaid === 1 ? 'Knockout' : 'Knockouts'}
                  </span>
                </div>
                <div className="tl-stat">
                  <span className="tl-stat__label">Still Available</span>
                  <span className="tl-stat__value tl-stat__value--accent">
                    {chips(bounty.available)}
                  </span>
                </div>
                {bounty.perKnockout > 0 && !isMystery && (
                  <div className="tl-stat">
                    <span className="tl-stat__label">Per Knockout</span>
                    <span className="tl-stat__value">{chips(bounty.perKnockout)}</span>
                  </div>
                )}
              </div>

              {/* The meter DRAINS: it shows what is left, not what has gone. */}
              <div className="rw-drain">
                <div className="rw-drain__row">
                  <span className="rw-drain__label">
                    {isMystery ? 'Still Available In The Mystery Pool' : 'Still In The Pool'}
                  </span>
                  <span className="rw-drain__figure">
                    {chips(bounty.available)} Of {chips(bounty.total)}
                  </span>
                </div>
                <div className="tl-meter">
                  <div className="tl-meter__fill" style={{ width: `${bounty.drained}%` }} />
                </div>
              </div>

              {isPko && (
                <p className="rw-rule">
                  Progressive Knockout. Half Of Every Head You Win Is Paid To You In Cash. The Other
                  Half Is Added To Your Own Head, So Every Knockout Makes You Worth More.
                </p>
              )}

              {!isPko && !isMystery && bounty.perKnockout > 0 && (
                <p className="rw-rule">
                  Every Player Carries A Head Worth {chips(bounty.perKnockout)}. Knock Them Out And
                  It Is Paid To You Immediately.
                </p>
              )}

              {isMystery && (
                <>
                  <p className="rw-rule">
                    Every Head Is Drawn At Registration And Stays Sealed Until It Is Won. The Range
                    Runs From {chips(num(t.mystery_bounty_min))} To{' '}
                    {chips(num(t.mystery_bounty_max))}.
                  </p>

                  <div className="rw-top">
                    <div className="tl-section-head">
                      <span className="tl-section-title">Top Prizes</span>
                      <span className="tl-section-note">Largest First</span>
                    </div>

                    {bounty.ladder.length === 0 ? (
                      <div className="tl-empty">
                        The Prizes Are Sealed Until The Field Registers
                      </div>
                    ) : (
                      <ul className="tl-list rw-top__list">
                        {bounty.ladder.map((rung, i) => {
                          const open = rung.available > 0;
                          return (
                            <li
                              key={rung.amount}
                              className={`tl-row rw-toprow ${open ? 'rw-toprow--open' : 'rw-toprow--gone'}`}
                            >
                              <span className="tl-rank tl-rank--podium rw-toprank">
                                {ordinal(i + 1)}
                              </span>
                              <span className="rw-toprow__mid">
                                <span className="tl-name rw-topamount">{chips(rung.amount)}</span>
                                <span className="tl-sub">
                                  {open
                                    ? `${chips(rung.available)} Still Sealed`
                                    : 'Every One Of These Has Been Pulled'}
                                </span>
                              </span>
                              <span
                                className={`tl-badge ${open ? 'tl-badge--good' : 'tl-badge--mute'} rw-topstate`}
                              >
                                {open ? 'Still Available' : 'Claimed'}
                              </span>
                            </li>
                          );
                        })}
                      </ul>
                    )}
                  </div>
                </>
              )}
            </>
          )}
        </section>
      )}
    </div>
  );
}
