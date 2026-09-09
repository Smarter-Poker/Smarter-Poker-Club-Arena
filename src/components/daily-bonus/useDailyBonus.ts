/**
 * useDailyBonus - state for the Daily Club Arena Bonus sheet.
 *
 * Loads the server's view of today, claims one tile at a time, and keeps a
 * live countdown to the Chicago midnight the server reported. Every number
 * rendered comes from the status or claim payload; nothing is computed
 * client-side except the ticking clock.
 *
 * THE CLOCK IS A DEADLINE, NOT A COUNTER (2026-09-09). The first cut
 * decremented the server's `seconds_to_reset` once a second. A background
 * tab's timers run about once a minute, so a sheet left open overnight woke
 * up hours behind, showed a countdown that had long passed and never re-read
 * for the new day. The deadline is now an absolute instant taken when the
 * status arrived; every tick measures the real distance to it, and the
 * re-read fires the first tick at or past it, once.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  claimReasonText,
  dailyBonusService,
  type DailyBonusClaimResult,
  type DailyBonusStatus,
  type DailyBonusTile,
} from '../../services/DailyBonusService';
import { reportError } from '../../utils/errorReporter';

export interface ClaimOutcome {
  slot: number;
  result: DailyBonusClaimResult;
  /** Player-facing text for a refusal; empty on success. */
  refusal: string;
}

/**
 * Apply a successful claim to the status the sheet is showing. Pure, so the
 * tile arithmetic is testable without React: the tile becomes claimed with
 * what the ledger actually granted, the caps move by the diamonds paid, and
 * every other diamond tile re-reads its `capped` flag against the new
 * remaining cap (the flag the server computed before this claim is stale
 * the moment diamonds are paid).
 */
export function applyClaim(
  prev: DailyBonusStatus,
  slot: number,
  result: DailyBonusClaimResult
): DailyBonusStatus {
  const granted = result.granted;
  if (!granted) return prev;
  const caps =
    prev.caps && granted.kind === 'diamonds'
      ? {
          ...prev.caps,
          daily_used: prev.caps.daily_used + granted.diamonds,
          daily_remaining: Math.max(0, prev.caps.daily_remaining - granted.diamonds),
          monthly_used: prev.caps.monthly_used + granted.diamonds,
          monthly_remaining: Math.max(0, prev.caps.monthly_remaining - granted.diamonds),
          bonus_monthly_used: prev.caps.bonus_monthly_used + granted.diamonds,
          bonus_monthly_remaining: Math.max(
            0,
            prev.caps.bonus_monthly_remaining - granted.diamonds
          ),
        }
      : prev.caps;
  const tiles = prev.tiles.map((t) => {
    if (t.slot === slot) {
      return {
        ...t,
        claimed: true,
        claimed_at: new Date().toISOString(),
        granted,
        capped: false,
      };
    }
    if (!t.claimed && !t.locked && t.kind === 'diamonds' && caps) {
      return { ...t, capped: t.diamonds > caps.daily_remaining };
    }
    return t;
  });
  const unclaimed = tiles.filter((t) => !t.claimed && !t.locked).length;
  return {
    ...prev,
    tiles,
    unclaimed,
    claimed_today: true,
    streak: typeof result.streak === 'number' ? result.streak : prev.streak,
    caps,
  };
}

export function useDailyBonus(enabled: boolean) {
  const [status, setStatus] = useState<DailyBonusStatus | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [claimingSlot, setClaimingSlot] = useState<number | null>(null);
  const [secondsToReset, setSecondsToReset] = useState(0);
  const mounted = useRef(true);
  /** Absolute instant of the Chicago midnight the last status reported. */
  const deadline = useRef<number | null>(null);
  /** The deadline a rollover re-read has already been issued for. */
  const rolledOver = useRef<number | null>(null);
  const inFlight = useRef<Promise<void> | null>(null);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const load = useCallback(async () => {
    // One read at a time: a rollover tick, a refusal and a manual retry that
    // land together share the request instead of racing three.
    if (inFlight.current) return inFlight.current;
    setLoading(true);
    setLoadError(null);
    const run = (async () => {
      try {
        const next = await dailyBonusService.getStatus();
        if (!mounted.current) return;
        const seconds = Math.max(0, Number(next.seconds_to_reset) || 0);
        deadline.current = Date.now() + seconds * 1000;
        setStatus(next);
        setSecondsToReset(seconds);
      } catch (err) {
        if (!mounted.current) return;
        setLoadError(err instanceof Error ? err.message : 'Could Not Load Your Daily Bonus');
      } finally {
        inFlight.current = null;
        if (mounted.current) setLoading(false);
      }
    })();
    inFlight.current = run;
    return run;
  }, []);

  useEffect(() => {
    if (!enabled) return;
    void load();
  }, [enabled, load]);

  // The countdown measures the distance to the deadline on every tick, so a
  // throttled background tab catches up the moment it is looked at. Crossing
  // the deadline re-reads once: the day has rolled over and the tiles on
  // screen belong to yesterday.
  useEffect(() => {
    if (!status) return;
    const tick = () => {
      const at = deadline.current;
      if (at == null) return;
      const left = Math.max(0, Math.ceil((at - Date.now()) / 1000));
      setSecondsToReset(left);
      if (left === 0 && rolledOver.current !== at) {
        rolledOver.current = at;
        void load();
      }
    };
    tick();
    const timer = setInterval(tick, 1000);
    return () => clearInterval(timer);
  }, [status, load]);

  const claim = useCallback(
    async (tile: DailyBonusTile): Promise<ClaimOutcome | null> => {
      if (!status || claimingSlot !== null) return null;
      setClaimingSlot(tile.slot);
      try {
        const result = await dailyBonusService.claim(status.today, tile.slot);
        if (!mounted.current) return null;
        if (result.success && result.granted) {
          setStatus((prev) => (prev ? applyClaim(prev, tile.slot, result) : prev));
          return { slot: tile.slot, result, refusal: '' };
        }
        // A refusal the server explains; re-read so the sheet shows the truth
        // (another device may have claimed it, or the day rolled over under
        // the sheet and these tiles belong to yesterday).
        void load();
        return { slot: tile.slot, result, refusal: claimReasonText(result.reason) };
      } catch (err) {
        if (!mounted.current) return null;
        reportError(err, 'useDailyBonus.claim', { slot: tile.slot });
        return {
          slot: tile.slot,
          result: { success: false, reason: 'transport' },
          refusal: err instanceof Error ? err.message : 'Could Not Claim, Try Again',
        };
      } finally {
        if (mounted.current) setClaimingSlot(null);
      }
    },
    [status, claimingSlot, load]
  );

  return { status, loading, loadError, reload: load, claim, claimingSlot, secondsToReset };
}

/** hh:mm:ss for the countdown. */
export function formatCountdown(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  return [h, m, r].map((n) => String(n).padStart(2, '0')).join(':');
}
