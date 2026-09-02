/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * OVERLAY ANNOUNCEMENTS — telling players there is free money on the table
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Dan 2026-08-26: "We need to add OVERLAY ANNOUNCEMENTS to the ticker, alerting
 * players if there is an overlay or potential overlay to jump in and play!"
 *
 * An OVERLAY is the gap between what a tournament GUARANTEES and what its field
 * has actually paid in. The house covers the difference, so every chip of
 * overlay is value handed to whoever is sitting down. It is the single most
 * persuasive thing a room can say to a player, and it is worth nothing if
 * nobody is told while they can still register.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THIS IS NOT SIMPLY `prize_pool < guaranteed_prize`
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Every guaranteed event is "short" the moment it is created. The Sunday $200
 * Deep Stack opens on the board SIX DAYS early with a 20,000 guarantee and a
 * pool of zero. Announcing a 20,000 overlay on Monday for a Sunday event is not
 * information, it is a lie of omission - the field has six days to arrive - and
 * a ticker that cries wolf on Monday is a ticker nobody reads on Sunday.
 *
 * So an announcement needs the shortfall to be BOTH real and ACTIONABLE. The
 * two gates that decide are documented on the constants below.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * TWO TIERS, BECAUSE THEY ARE DIFFERENT CLAIMS
 * ─────────────────────────────────────────────────────────────────────────────
 *
 *   'potential'  Kept in the type for exhaustiveness. overlayFor has not
 *                produced it since 2026-08-26: a pre-start shortfall is a field
 *                that has not arrived, not an overlay.
 *
 *   'live'       Late registration is open on a running event, on its final
 *                late-reg level, and the field has paid for under half the
 *                guarantee. The shortfall is as close to certain as it gets and
 *                the window to act on it is about to shut.
 *
 * Pure on purpose - no Supabase, no React, no clock of its own. The caller
 * fetches and renders; this decides. Same shape as tournamentScheduleWindow,
 * quickJoinRanking and satelliteAwardPlan.
 */

import { isInLateRegistration, isRunning } from './tournamentFilters';

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * THE TWO GATES (Dan 2026-09-01) — BOTH must hold, or the ticker says nothing
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Dan, verbatim: "the ticker needs to be adjusted to only announce when a MTT
 * Is starting, and only if an overlay alert is in the last level of late
 * registration, and has less then 50% of the prize pool of the guarantee yet
 * registered".
 *
 * What each gate replaced, and why:
 *
 *   WHEN   was "75% of the late-registration window has elapsed", measured in
 *          wall-clock time against lateRegEndMs. That is a decent approximation
 *          of "nearly closed" and a poor statement of it: the window is a sum
 *          of blind-level durations, levels run long when a table is
 *          short-handed or the clock is paused, and a row that did not carry
 *          blind_structure could not place the 75% point at all - so the gate
 *          failed closed on events that were in fact on their final level. It
 *          is the LEVEL itself now, which the row always knows.
 *
 *   HOW    was "at least 10% of the guarantee is missing". Ten per cent of a
 *   MUCH   20,000 guarantee is 2,000, which one late table closes, so the bar
 *          spoke about events that were never really going to overlay. Dan set
 *          the line at half.
 *
 * HORSES ARE PLAYERS (CLAUDE.md 10.5). `prize_pool` and `current_players` are
 * the club's own totals and they already count every horse in the field, at the
 * same buy-in, out of the same club wallet. Nothing here filters on `is_horse`
 * and nothing here ever may: a horse's buy-in closes an overlay exactly as a
 * human's does, and subtracting them would invent a shortfall the house is not
 * actually covering.
 */

/**
 * The most of its own guarantee a field may have paid in and still be worth
 * announcing: Dan's "less then 50% of the prize pool of the guarantee yet
 * registered", stated as the fraction it is. A 20,000 guarantee has to be
 * sitting under a 10,000 prize pool before the ticker mentions it.
 */
export const MAX_REGISTERED_FRACTION = 0.5;

/** Never announce a trivial absolute amount either, whatever the fraction. */
export const MIN_OVERLAY_CHIPS = 100;

export type OverlayTier = 'potential' | 'live';

/** The `tournaments` columns this needs. Anything wider is accepted. */
export interface OverlayCandidate {
  id: string;
  name?: string | null;
  status?: string | null;
  start_time: string;
  guaranteed_prize?: number | string | null;
  prize_pool?: number | string | null;
  current_players?: number | string | null;
  buy_in_amount?: number | string | null;
  buy_in_fee?: number | string | null;
  /** 0-BASED cap: the door is open while `current_level < late_reg_levels`. */
  late_reg_levels?: number | null;
  late_reg_mins?: number | null;
  started_at?: string | null;
  /** 0-BASED index into the blind structure, as the engine keeps it. */
  current_level?: number | null;
  max_players?: number | null;
}

export interface OverlayAnnouncement {
  id: string;
  name: string;
  tier: OverlayTier;
  /** Chips the house is currently covering. */
  overlay: number;
  guarantee: number;
  prizePool: number;
  entered: number;
  /** Entries still needed to close the gap. 0 when unknowable. */
  entriesToClose: number;
  startsAt: number;
}

const num = (v: unknown): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

/**
 * Is this event on the FINAL level of its late-registration window?
 *
 * `late_reg_levels` is a 0-based cap and `current_level` is a 0-based index
 * (TournamentManagerBase counts from 0 and closes on `currentLevel >= cap`), so
 * the levels registration is open for are `0 .. late_reg_levels - 1` and the
 * last of them is `late_reg_levels - 1`.
 *
 * Fails CLOSED. An event with no level-based late-reg cap has no "last level"
 * to be on, and a guess is exactly what this gate exists to stop. Verified
 * against production 2026-09-01: all 2,013 guaranteed MTTs carry
 * `late_reg_levels`, so nothing real is silenced by that strictness.
 */
export function isInLastLateRegLevel(t: OverlayCandidate): boolean {
  const cap = Number(t.late_reg_levels);
  if (!Number.isFinite(cap) || cap <= 0) return false;
  const level = Number(t.current_level ?? 0);
  if (!Number.isFinite(level)) return false;
  return level === cap - 1;
}

/**
 * Is this event's shortfall worth announcing, and as what?
 *
 * Returns null for every event that is not - which is most of them, and
 * deliberately so.
 */
export function overlayFor(
  t: OverlayCandidate,
  now: number = Date.now()
): OverlayAnnouncement | null {
  const guarantee = num(t.guaranteed_prize);
  if (guarantee <= 0) return null; // no guarantee, no overlay, ever

  const prizePool = num(t.prize_pool);
  const overlay = Math.round((guarantee - prizePool) * 100) / 100;
  if (overlay <= 0) return null; // the field already covered it

  // GATE 2: the field has paid in less than half the guarantee. Stated the way
  // Dan stated it - against what is REGISTERED - rather than against the
  // shortfall, so the code reads as the rule does.
  if (prizePool >= guarantee * MAX_REGISTERED_FRACTION) return null;
  // ...and never a trivial absolute amount, whatever the fraction says.
  if (overlay < MIN_OVERLAY_CHIPS) return null;

  const startsAt = new Date(t.start_time).getTime();
  if (!Number.isFinite(startsAt)) return null;

  const status = String(t.status || '').toUpperCase();

  // FUTURE EVENTS NEVER ANNOUNCE (Dan 2026-08-26). Not "rarely" - never.
  // A pre-start guarantee gap is a field that has not arrived, not an overlay.
  const running = isRunning(status) || status === 'LATE_REG' || status === 'LATE_REGISTRATION';
  if (!running) return null;

  // The registration door must still be open, or there is nothing to sell.
  if (!isInLateRegistration({ ...t, name: t.name || '', max_players: t.max_players ?? 0 }, now)) {
    return null;
  }

  // GATE 1: and it must be the LAST level of that window (Dan 2026-09-01).
  if (!isInLastLateRegLevel(t)) return null;

  const tier: OverlayTier = 'live';

  /* How many more entries would close the gap. The PRIZE side of the buy-in
     is what reaches the pool - the fee is rake and never does - so using the
     total here would understate the entries needed and overstate how close
     the event is to covering itself. */
  const prizeSide = num(t.buy_in_amount);
  const entriesToClose = prizeSide > 0 ? Math.ceil(overlay / prizeSide) : 0;

  return {
    id: t.id,
    name: t.name || 'Tournament',
    tier,
    overlay,
    guarantee,
    prizePool,
    entered: num(t.current_players),
    entriesToClose,
    startsAt,
  };
}

/**
 * The announcements worth showing, biggest overlay first.
 *
 * LIVE BEATS POTENTIAL regardless of size: a running event with late
 * registration open has a closing door, and a player can act on it now. A
 * bigger number on an event that has not started can wait its turn.
 */
export function rankOverlayAnnouncements(
  candidates: ReadonlyArray<OverlayCandidate>,
  now: number = Date.now(),
  limit = 3
): OverlayAnnouncement[] {
  const found: OverlayAnnouncement[] = [];
  for (const c of candidates || []) {
    if (!c || !c.id) continue;
    const a = overlayFor(c, now);
    if (a) found.push(a);
  }
  found.sort((x, y) => {
    if (x.tier !== y.tier) return x.tier === 'live' ? -1 : 1;
    if (y.overlay !== x.overlay) return y.overlay - x.overlay;
    return x.startsAt - y.startsAt;
  });
  return found.slice(0, Math.max(0, limit));
}

/**
 * The line a player reads. Title Case with no em dashes is the house rule for
 * player-facing copy (popupStyle), so this composes in that register already.
 *
 * Deliberately leads with the CHIPS, not the tournament name: the number is
 * the reason to look, and a marquee gives you about a second of attention.
 */
export function overlayMessage(a: OverlayAnnouncement): string {
  const chips = (n: number) => Math.round(n).toLocaleString('en-US');
  const head =
    a.tier === 'live'
      ? `${chips(a.overlay)} Overlay Right Now`
      : `${chips(a.overlay)} Potential Overlay`;

  const parts = [head, a.name, `${chips(a.guarantee)} Guaranteed`, `${chips(a.entered)} Entered`];
  if (a.entriesToClose > 0) {
    parts.push(
      a.tier === 'live'
        ? `Last Level Of Late Registration`
        : `${chips(a.entriesToClose)} More To Cover It`
    );
  }
  parts.push(a.tier === 'live' ? 'Jump In Now' : 'Jump In');
  return parts.join(' · ');
}
