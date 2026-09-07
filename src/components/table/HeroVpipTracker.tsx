/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  THE HERO'S VPIP TRACKER (Dan 2026-09-04)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Dan, verbatim: "VPIP SHOULD BE DISPLAYED AS A REALTIME PERCENTAGE TRACKER TO
 * THE LEFT OF THE HERO (ONLY VISIBLE FOR THE USER). AND IF ANYONE FALLS UNDER
 * THE SET THRESHOLD FOR THE GAME AFTER 10 HANDS, OR ANYTIME AFTER THE 10
 * HANDS, THEY GET BOOTED."
 *
 * THE NUMBER IS THE JUDGED NUMBER. It comes from `fn_cash_vpip_status`, which
 * reads ca_hand_facts for this table and this sitting exactly as fn_nit_check
 * does when it decides an eviction - not from the client's own session count,
 * which is a different figure (it starts when the tab opened, not when the
 * seat was taken, and it counts what the tab saw). A tracker that disagrees
 * with the rule it is warning about is worse than none.
 *
 * ONLY VISIBLE FOR THE USER, at the database: the function is keyed on
 * auth.uid(), so a browser can only ever ask about itself. This component
 * renders nothing for a spectator and nothing on a tournament table.
 *
 * REALTIME means every hand: refreshed when the hand number moves (after a
 * short delay so the hand's fact row has landed), when the hero sits, and on
 * a slow backstop timer. One small RPC per hand per human.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { supabase } from '../../lib/supabase';
import VpipRequirementBadge from './VpipRequirementBadge';
import './HeroVpipTracker.css';

export interface HeroVpipStatus {
  ok: boolean;
  seated?: boolean;
  nit_game?: boolean;
  /** The floor, percent; 0 when the table runs none. */
  required?: number;
  /** Hands before the rule can judge. */
  window?: number;
  /** Hands on file this sitting. */
  hands?: number;
  /** VPIP over those hands, percent; null until the first hand is on file. */
  vpip?: number | null;
  reason?: string;
}

/** Fact rows land at settlement; the hand number moves at the next deal. */
export const VPIP_REFRESH_DELAY_MS = 1500;
/** Backstop so a missed hand boundary never leaves the figure stale for long. */
export const VPIP_BACKSTOP_MS = 45_000;

/* ── `vpipStanding` WAS DELETED HERE (2026-09-07) ───────────────────────────
   It graded the hero against the floor into none / sample / safe / edge /
   under, and the tracker emitted the result as a `hero-vpip--<standing>`
   class. Dan's badge specification section 25 forbids the badge colouring
   itself by whether the player is passing - "The approved artwork is
   silver/black/blue ... If product later wants eligibility indicators,
   implement them separately" - so when the rectangle became the badge, all
   five classes lost their styling and the grade was computed, stringified into
   a class name, and discarded. Its 'none' branch had also become unreachable:
   the component already returns null for every condition that produced it.

   Deleted rather than left in place, because a well-tested pure function that
   nothing consumes is the most convincing kind of dead code - the next reader
   assumes the standing reaches the screen. When an eligibility indicator is
   approved, it comes back deliberately, with a consumer. */

/**
 * How fresh the figure on screen is (spec section 21).
 *   'loading'   nothing has arrived yet - the badge prints `--%`
 *   'connected' the last read succeeded
 *   'stale'     a read failed while we already had a figure; the LAST KNOWN
 *               value stays on screen and is dimmed, never blanked
 */
export type VpipFreshness = 'loading' | 'connected' | 'stale';

export function useHeroVpipStatus(
  tableId: string | null | undefined,
  enabled: boolean,
  handNumber: number
): { status: HeroVpipStatus | null; freshness: VpipFreshness } {
  const [status, setStatus] = useState<HeroVpipStatus | null>(null);
  const [freshness, setFreshness] = useState<VpipFreshness>('loading');
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const refresh = useCallback(async () => {
    if (!tableId || !enabled) return;
    try {
      const { data, error } = await supabase.rpc('fn_cash_vpip_status', { p_table_id: tableId });
      if (!alive.current) return;
      if (error || !data || typeof data !== 'object') {
        /* A MISSED READ IS REPORTED, NOT SWALLOWED (spec section 21).
           The figure itself is left exactly as it was - never blanked, never
           zeroed, because 0% is a real statistic and a reconnect must not
           accuse a player of it. What changes is that the badge can now SAY
           the number is not fresh. Before this the failure was silent and the
           `[data-status='stale']` rule was unreachable. */
        setFreshness((prev) => (prev === 'loading' ? 'loading' : 'stale'));
        return;
      }
      setStatus(data as HeroVpipStatus);
      setFreshness('connected');
    } catch {
      if (!alive.current) return;
      setFreshness((prev) => (prev === 'loading' ? 'loading' : 'stale'));
    }
  }, [tableId, enabled]);

  // On sit, and on a backstop.
  useEffect(() => {
    if (!enabled) {
      setStatus(null);
      setFreshness('loading');
      return;
    }
    void refresh();
    const t = setInterval(() => void refresh(), VPIP_BACKSTOP_MS);
    return () => clearInterval(t);
  }, [enabled, refresh]);

  // Every hand, once the fact row has had time to land.
  useEffect(() => {
    if (!enabled || !(handNumber > 0)) return;
    const t = setTimeout(() => void refresh(), VPIP_REFRESH_DELAY_MS);
    return () => clearTimeout(t);
  }, [enabled, handNumber, refresh]);

  return { status, freshness };
}

interface Props {
  tableId: string | null | undefined;
  /** The hero holds a seat at this table. Nothing renders otherwise. */
  heroSeated: boolean;
  /** Tournaments carry no VPIP floor and no tracker. */
  isTournament: boolean;
  handNumber: number;
  /** Where the hero's seat is, percent of the table; the tracker sits to its left. */
  heroPos: { x: number; y: number } | null;
}

export default function HeroVpipTracker({
  tableId,
  heroSeated,
  isTournament,
  handNumber,
  heroPos,
}: Props) {
  const enabled = Boolean(tableId) && heroSeated && !isTournament;
  const { status, freshness } = useHeroVpipStatus(tableId, enabled, handNumber);
  if (!enabled || !status?.ok || !status.seated || !heroPos) return null;

  const vpip = status.vpip == null ? null : Number(status.vpip);
  const floor = Number(status.required ?? 0);

  /* A TABLE WITH NO FLOOR HAS NOTHING TO PLACARD (Dan 2026-09-07, item 3).
     The badge he designed is a REQUIREMENT badge - its bottom row is the game
     rule. On a table that runs no VPIP rule there is no requirement to print,
     and the old rectangle's fallback ("7 Hands") was the generic readout he
     asked to be rid of. So the tracker renders nothing there rather than
     inventing a minimum to fill the row. */
  if (!(floor > 0)) return null;

  return (
    <div
      className="hero-vpip"
      style={{ left: `${heroPos.x}%`, top: `${heroPos.y}%` }}
      data-testid="hero-vpip"
    >
      {/* The badge owns its own aria-label and role - see
          VpipRequirementBadge. This wrapper is position only: it places the
          square beside the hero's seat and does not draw.

          The `hero-vpip--<standing>` modifier that used to be here is gone
          with `vpipStanding` itself: the badge is forbidden from colouring
          itself by whether the player is passing (spec section 25), so the
          five classes it emitted were styled by nothing and the value was
          computed and discarded. If an eligibility indicator is approved it
          gets built deliberately, per that section, rather than left lying
          around looking wired. */}
      <VpipRequirementBadge minimumVpip={floor} currentVpip={vpip} status={freshness} />
    </div>
  );
}
