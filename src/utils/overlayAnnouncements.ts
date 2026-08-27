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
 * So an announcement needs the shortfall to be BOTH real and ACTIONABLE:
 *
 *   NEAR       within ANNOUNCE_WITHIN_MS of the start, or already inside late
 *              registration. Far enough out to act on, close enough that the
 *              field is roughly what it is going to be.
 *   MATERIAL   at least MIN_OVERLAY_FRACTION of the guarantee still missing.
 *              A 200-chip gap on a 20,000 guarantee is noise; announcing it
 *              teaches players the flag means nothing.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * TWO TIERS, BECAUSE THEY ARE DIFFERENT CLAIMS
 * ─────────────────────────────────────────────────────────────────────────────
 *
 *   'potential'  The event has not started. The gap is real right now but the
 *                field can still close it, so the copy says POTENTIAL. This is
 *                honest and it is also the better sell: "get in before it
 *                fills" beats "we are losing money".
 *
 *   'live'       Late registration is open on a running event. The field is
 *                known, the shortfall is as close to certain as it gets, and
 *                there is a narrow window to act. This is the one that
 *                deserves to shout.
 *
 * Pure on purpose - no Supabase, no React, no clock of its own. The caller
 * fetches and renders; this decides. Same shape as tournamentScheduleWindow,
 * quickJoinRanking and satelliteAwardPlan.
 */

import { isInLateRegistration, isRunning } from './tournamentFilters';
import { lateRegEndMs, type LobbyTournamentRow } from '../components/lobby/lobbyEntries';

/**
 * RUNNING EVENTS ONLY, AND ONLY LATE IN LATE REGISTRATION.
 *
 * Dan 2026-08-26, overruling the 7-day pre-start window this shipped with the
 * day before: "YOU NEVER ANNOUNCE AN OVERLAY FOR EVENTS IN THE FUTURE, ONLY
 * FOR EVENTS THAT ARE CURRENTLY RUNNING. AND YOU SHOULDN'T MAKE ANY
 * ANNOUNCEMENT OF ANY TOURNAMENT UNTIL IT'S 75% OF THE WAY DOWN WITH LATE
 * REGISTRATION."
 *
 * The reasoning holds up: a Sunday event flagged on Wednesday is not an
 * overlay, it is a field that has not arrived yet — and the prestart horse
 * ramp (mttPrestartHorseTarget) closes most gaps before the start anyway. The
 * only moment a shortfall is both REAL and ACTIONABLE is when the event is
 * running, the field is nearly settled, and the registration door is about to
 * close. That moment is the last quarter of late registration, and that is
 * now the only moment this module will speak.
 *
 * The 'potential' tier still exists in the type for exhaustiveness, but
 * overlayFor never produces it any more.
 */
export const LATE_REG_ANNOUNCE_FRACTION = 0.75;

/**
 * The smallest shortfall worth announcing, as a fraction of the guarantee.
 *
 * Ten per cent. Below that the number is rounding on a real field and saying
 * it out loud devalues every future announcement. A 20,000 guarantee has to be
 * 2,000 short before the ticker mentions it.
 */
export const MIN_OVERLAY_FRACTION = 0.1;

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
  late_reg_levels?: number | null;
  late_reg_mins?: number | null;
  started_at?: string | null;
  current_level?: number | null;
  max_players?: number | null;
  /** Needed by lateRegEndMs to place the 75% point exactly (level-based
   *  windows). Callers that cannot supply them simply never announce
   *  level-gated events — the gate fails closed. */
  blind_structure?: string | null;
  level_started_at?: string | null;
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

  // MATERIAL: both a real fraction and a real number of chips.
  if (overlay < MIN_OVERLAY_CHIPS) return null;
  if (overlay < guarantee * MIN_OVERLAY_FRACTION) return null;

  const startsAt = new Date(t.start_time).getTime();
  if (!Number.isFinite(startsAt)) return null;

  const status = String(t.status || '').toUpperCase();

  // FUTURE EVENTS NEVER ANNOUNCE (Dan 2026-08-26). Not "rarely" — never.
  // A pre-start guarantee gap is a field that has not arrived, not an overlay.
  const running = isRunning(status) || status === 'LATE_REG' || status === 'LATE_REGISTRATION';
  if (!running) return null;

  // The registration door must still be open, or there is nothing to sell.
  if (!isInLateRegistration({ ...t, name: t.name || '', max_players: t.max_players ?? 0 }, now)) {
    return null;
  }

  // …and at least LATE_REG_ANNOUNCE_FRACTION of the late-reg window must have
  // elapsed. Before that the field is still arriving and the "overlay" is
  // noise. If the row cannot prove where the window starts and ends, it
  // cannot prove the 75% point either — fail closed, never announce on a
  // guess. lateRegEndMs is the same derivation the lobby countdown uses, so
  // the ticker can never claim a window the card denies.
  const begun = new Date(t.started_at || t.start_time).getTime();
  const closesAt = lateRegEndMs(t as unknown as LobbyTournamentRow);
  if (!Number.isFinite(begun) || closesAt == null || closesAt <= begun) return null;
  const progress = (now - begun) / (closesAt - begun);
  if (progress < LATE_REG_ANNOUNCE_FRACTION || now >= closesAt) return null;

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
      a.tier === 'live' ? `Late Registration Open` : `${chips(a.entriesToClose)} More To Cover It`
    );
  }
  parts.push(a.tier === 'live' ? 'Jump In Now' : 'Jump In');
  return parts.join(' · ');
}
