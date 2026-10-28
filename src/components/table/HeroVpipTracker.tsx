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
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
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
    let t: ReturnType<typeof setInterval> | null = null;
    const startBackstop = () => {
      if (!t) t = setInterval(() => void refresh(), VPIP_BACKSTOP_MS);
    };
    const stopBackstop = () => {
      if (t) {
        clearInterval(t);
        t = null;
      }
    };
    startBackstop();

    const onVis = () => {
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') {
        stopBackstop();
      } else {
        startBackstop();
        void refresh();
      }
    };
    document.addEventListener('visibilitychange', onVis);
    return () => {
      stopBackstop();
      document.removeEventListener('visibilitychange', onVis);
    };
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
  /** Existing engine stay-clock projection; no client-side lock decision. */
  leaveClockRemainingMs?: number | null;
  leaveClockRunning?: boolean;
}

export default function HeroVpipTracker({
  tableId,
  heroSeated,
  isTournament,
  handNumber,
  heroPos,
  leaveClockRemainingMs = null,
  leaveClockRunning = false,
}: Props) {
  const enabled = Boolean(tableId) && heroSeated && !isTournament;
  const { status, freshness } = useHeroVpipStatus(tableId, enabled, handNumber);
  const anchor = useRef<HTMLDivElement>(null);
  const vpip = status?.vpip == null ? null : Number(status.vpip);
  const floor = Number(status?.required ?? 0);
  const showVpip = Boolean(status?.ok && status.seated && floor > 0);
  const showClock =
    leaveClockRunning && leaveClockRemainingMs !== null && leaveClockRemainingMs > 0;

  useLayoutEffect(() => {
    const node = anchor.current;
    const plane = node?.parentElement;
    const info = plane?.querySelector<HTMLElement>('.seat-wrapper--hero .seat__info');
    const page = plane?.closest('.table-page');
    let observedPanel: HTMLElement | null = null;
    let observer: ResizeObserver | null = null;
    if (!node || !plane || !info) return;
    const place = () => {
      // The action panel can mount after the tracker during a cold table load.
      // Resolve it on each placement instead of retaining that initial null.
      const actionPanel = page?.querySelector<HTMLElement>('.action-panel') ?? null;
      if (actionPanel !== observedPanel) {
        if (observedPanel) observer?.unobserve(observedPanel);
        if (actionPanel) observer?.observe(actionPanel);
        observedPanel = actionPanel;
      }
      const parent = plane.getBoundingClientRect();
      const plate = info.getBoundingClientRect();
      if (
        !parent.width ||
        !parent.height ||
        !plane.offsetWidth ||
        !plane.offsetHeight ||
        !plate.width
      )
        return;
      const scaleX = parent.width / plane.offsetWidth;
      const scaleY = parent.height / plane.offsetHeight;
      // The real name/stack plate is the anchor, including its responsive lift.
      // Center the indicator column beside the plate and keep its clock
      // above the plate's bottom edge, clear of the action bar.
      node.style.left = `${(plate.left - parent.left) / scaleX - (window.innerWidth <= 480 ? 6 : 12)}px`;
      const center = (plate.top + plate.height / 2 - parent.top) / scaleY;
      const actions = actionPanel?.getBoundingClientRect();
      const bottomEdge =
        actions && actions.height > 0 ? Math.min(plate.bottom, actions.top - 4) : plate.bottom;
      const bottom = (bottomEdge - parent.top) / scaleY;
      const height = node.getBoundingClientRect().height / scaleY;
      node.style.top = `${Math.min(center, bottom - height / 2)}px`;
    };
    if (typeof ResizeObserver !== 'undefined') {
      observer = new ResizeObserver(place);
      observer.observe(plane);
      observer.observe(info);
      observer.observe(node);
      if (info.parentElement) observer.observe(info.parentElement);
    }
    place();
    const mounts = typeof MutationObserver !== 'undefined' ? new MutationObserver(place) : null;
    if (page) mounts?.observe(page, { childList: true, subtree: true });
    return () => {
      observer?.disconnect();
      mounts?.disconnect();
    };
  }, [tableId, enabled, heroPos?.x, heroPos?.y, showVpip, showClock]);

  if (!enabled || !heroPos || (!showVpip && !showClock)) return null;
  const seconds = Math.max(0, Math.ceil((leaveClockRemainingMs ?? 0) / 1000));
  const clockText = `${Math.floor(seconds / 60)}:${seconds % 60 < 10 ? `0${seconds % 60}` : seconds % 60}`;

  return (
    <div
      ref={anchor}
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
      {showVpip && (
        <VpipRequirementBadge minimumVpip={floor} currentVpip={vpip} status={freshness} />
      )}
      {showClock && (
        <div className="hero-vpip__clock" data-testid="hero-profit-clock">
          <span>Your Time Clock Has Started</span>
          <time aria-label={`Time Clock ${clockText}`}>{clockText}</time>
        </div>
      )}
    </div>
  );
}
