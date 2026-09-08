/**
 * useDailyBonus - state for the Daily Club Arena Bonus sheet.
 *
 * Loads the server's view of today, claims one tile at a time, and keeps a
 * live countdown to the Chicago midnight the server reported. Every number
 * rendered comes from the status or claim payload; nothing is computed
 * client-side except the ticking clock.
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

export function useDailyBonus(enabled: boolean) {
  const [status, setStatus] = useState<DailyBonusStatus | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [claimingSlot, setClaimingSlot] = useState<number | null>(null);
  const [secondsToReset, setSecondsToReset] = useState(0);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const next = await dailyBonusService.getStatus();
      if (!mounted.current) return;
      setStatus(next);
      setSecondsToReset(next.seconds_to_reset);
    } catch (err) {
      if (!mounted.current) return;
      setLoadError(err instanceof Error ? err.message : 'Could Not Load Your Daily Bonus');
    } finally {
      if (mounted.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!enabled) return;
    void load();
  }, [enabled, load]);

  // The countdown ticks from the server's figure; when it hits zero the day
  // has rolled over and the sheet re-reads rather than showing stale tiles.
  useEffect(() => {
    if (!status) return;
    const timer = setInterval(() => {
      setSecondsToReset((s) => {
        if (s <= 1) {
          void load();
          return 0;
        }
        return s - 1;
      });
    }, 1000);
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
          const granted = result.granted;
          setStatus((prev) => {
            if (!prev) return prev;
            const tiles = prev.tiles.map((t) =>
              t.slot === tile.slot
                ? {
                    ...t,
                    claimed: true,
                    claimed_at: new Date().toISOString(),
                    granted,
                    capped: false,
                  }
                : t
            );
            const unclaimed = tiles.filter((t) => !t.claimed && !t.locked).length;
            const caps =
              prev.caps && granted.kind === 'diamonds'
                ? {
                    ...prev.caps,
                    daily_used: prev.caps.daily_used + granted.diamonds,
                    daily_remaining: Math.max(0, prev.caps.daily_remaining - granted.diamonds),
                  }
                : prev.caps;
            return { ...prev, tiles, unclaimed, claimed_today: true, caps };
          });
          return { slot: tile.slot, result, refusal: '' };
        }
        // A refusal the server explains; re-read so the sheet shows the truth
        // (another device may have claimed it).
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
