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

/**
 * What the tracker says about the hero's standing against the floor.
 *   'none'    the table runs no floor - just the figure
 *   'sample'  fewer hands than the window - the rule cannot judge yet
 *   'safe'    at or above the floor with room to spare
 *   'edge'    at or above the floor, within five points of it
 *   'under'   below the floor after the window - the next boundary stands you up
 */
export type VpipStanding = 'none' | 'sample' | 'safe' | 'edge' | 'under';

export function vpipStanding(s: HeroVpipStatus | null): VpipStanding {
  if (!s || !s.ok || !s.seated) return 'none';
  const floor = Number(s.required ?? 0);
  if (!(floor > 0)) return 'none';
  const hands = Number(s.hands ?? 0);
  const window = Math.max(1, Number(s.window ?? 10));
  const vpip = s.vpip == null ? null : Number(s.vpip);
  if (hands < window || vpip == null) return 'sample';
  if (vpip < floor) return 'under';
  if (vpip < floor + 5) return 'edge';
  return 'safe';
}

export function useHeroVpipStatus(
  tableId: string | null | undefined,
  enabled: boolean,
  handNumber: number
): HeroVpipStatus | null {
  const [status, setStatus] = useState<HeroVpipStatus | null>(null);
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
      if (error || !data || typeof data !== 'object') return;
      setStatus(data as HeroVpipStatus);
    } catch {
      /* the tracker is advisory; a missed read shows the last figure */
    }
  }, [tableId, enabled]);

  // On sit, and on a backstop.
  useEffect(() => {
    if (!enabled) {
      setStatus(null);
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

  return status;
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
  const status = useHeroVpipStatus(tableId, enabled, handNumber);
  if (!enabled || !status?.ok || !status.seated || !heroPos) return null;

  const standing = vpipStanding(status);
  const hands = Number(status.hands ?? 0);
  const vpip = status.vpip == null ? null : Math.round(Number(status.vpip));
  const floor = Number(status.required ?? 0);
  const window = Math.max(1, Number(status.window ?? 10));

  const figure = vpip == null ? '--' : `${vpip}%`;
  const detail =
    floor > 0
      ? hands < window
        ? `Min ${floor}% · ${hands}/${window} Hands`
        : `Min ${floor}% · ${hands} Hands`
      : `${hands} ${hands === 1 ? 'Hand' : 'Hands'}`;
  const label =
    floor > 0
      ? `Your VPIP ${figure}, minimum ${floor} percent after ${window} hands, ${hands} hands played`
      : `Your VPIP ${figure} over ${hands} hands`;

  return (
    <div
      className={`hero-vpip hero-vpip--${standing}`}
      style={{ left: `${heroPos.x}%`, top: `${heroPos.y}%` }}
      role="status"
      aria-live="polite"
      aria-label={label}
      data-testid="hero-vpip"
    >
      <span className="hero-vpip__eyebrow">VPIP</span>
      <span className="hero-vpip__figure">{figure}</span>
      <span className="hero-vpip__detail">{detail}</span>
    </div>
  );
}
