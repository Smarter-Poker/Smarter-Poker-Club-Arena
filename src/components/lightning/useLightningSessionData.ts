/**
 * LIGHTNING PHASE 8: the reads behind the room's Session panel and pool badge.
 *
 * CHEAP BY CONSTRUCTION. The Session panel reads fn_lightning_session_stats
 * when it opens and again when the hand on the felt changes (one read per
 * hand, never a per-second poll), and only while it is open. The pool badge
 * reads fn_lightning_pool_status every 30 s, only while it is mounted, its
 * room is visible and the browser tab is in front.
 */
import { useEffect, useState } from 'react';
import {
  fetchLightningAutoRebuyStatus,
  fetchLightningPoolHealth,
  fetchLightningSessionStats,
  type LightningAutoRebuyStatus,
  type LightningPoolHealth,
  type LightningSessionStats,
} from '../../lightning/lightningSessionApi';
import { reportError } from '../../utils/errorReporter';

export const LIGHTNING_POOL_STATUS_REFRESH_MS = 30_000;

export function useLightningSessionStats(
  poolSessionId: string | null,
  refreshKey: string | null,
  enabled: boolean
): { stats: LightningSessionStats | null; failed: boolean } {
  const [stats, setStats] = useState<LightningSessionStats | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    if (!enabled || !poolSessionId) return;
    let live = true;
    fetchLightningSessionStats(poolSessionId)
      .then((s) => {
        if (!live) return;
        setStats(s);
        setFailed(false);
      })
      .catch((err: unknown) => {
        if (!live) return;
        setFailed(true);
        reportError(err, 'LightningSession.stats_read_failed', { poolSessionId });
      });
    return () => {
      live = false;
    };
  }, [poolSessionId, refreshKey, enabled]);
  return { stats, failed };
}

export function useLightningPoolHealth(
  clusterId: string | null,
  active: boolean
): LightningPoolHealth | null {
  const [health, setHealth] = useState<LightningPoolHealth | null>(null);
  useEffect(() => {
    if (!active || !clusterId) return;
    let live = true;
    const read = () => {
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
      fetchLightningPoolHealth(clusterId)
        .then((h) => {
          if (live && h) setHealth(h);
        })
        .catch((err: unknown) => {
          if (live) reportError(err, 'LightningSession.pool_status_read_failed', { clusterId });
        });
    };
    read();
    const timer = setInterval(read, LIGHTNING_POOL_STATUS_REFRESH_MS);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [clusterId, active]);
  return health;
}

/**
 * LIGHTNING PHASE 10: the Cluster's auto-rebuy status, read once when the
 * Session panel opens (never a poll). LIGHTNING PHASE 12: it comes from
 * fn_lightning_pool_status (`auto_rebuy`), the authenticated door - the
 * browser never asks fn_lightning_config. `null` means it cannot be said -
 * the function absent (deploy window), an older payload, or unreadable - and
 * the status line is simply not shown.
 */
export function useLightningAutoRebuyStatus(
  clusterId: string | null,
  enabled: boolean
): LightningAutoRebuyStatus | null {
  const [status, setStatus] = useState<LightningAutoRebuyStatus | null>(null);
  useEffect(() => {
    if (!enabled || !clusterId) return;
    let live = true;
    fetchLightningAutoRebuyStatus(clusterId).then((s) => {
      if (live) setStatus(s);
    });
    return () => {
      live = false;
    };
  }, [clusterId, enabled]);
  return status;
}
