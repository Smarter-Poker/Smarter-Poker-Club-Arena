import type { Location } from 'react-router-dom';
import type { CashEvidenceMetric } from '../services/StatsEvidenceService';

const STORAGE_KEY = 'club-arena:stats-evidence-return';

interface StatsEvidenceOrigin {
  path: string;
  scrollY: number;
}

type LocationLike = Pick<Location, 'pathname' | 'search' | 'hash'>;

export function currentStatsEvidencePath(location: LocationLike): string {
  return `${location.pathname}${location.search}${location.hash}`;
}

export function rememberStatsEvidenceOrigin(location: LocationLike, scrollY: number): void {
  if (typeof window === 'undefined') return;
  const origin: StatsEvidenceOrigin = {
    path: currentStatsEvidencePath(location),
    scrollY: Math.max(0, Number.isFinite(scrollY) ? scrollY : 0),
  };
  try {
    window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify(origin));
  } catch {
    // Navigation must still work when storage is disabled.
  }
}

export function readStatsEvidenceOrigin(): StatsEvidenceOrigin | null {
  if (typeof window === 'undefined') return null;
  try {
    const value = JSON.parse(window.sessionStorage.getItem(STORAGE_KEY) || 'null') as unknown;
    if (
      !value ||
      typeof value !== 'object' ||
      typeof (value as StatsEvidenceOrigin).path !== 'string' ||
      !Number.isFinite((value as StatsEvidenceOrigin).scrollY)
    ) {
      return null;
    }
    return value as StatsEvidenceOrigin;
  } catch {
    return null;
  }
}

/**
 * Restore only the exact Stats URL that opened the evidence destination.
 * The bounded retries cover the page's cached shell and lazy tab settling
 * without installing a listener, observer, or background repair loop.
 */
export function restoreStatsEvidenceScroll(location: LocationLike): () => void {
  if (typeof window === 'undefined') return () => undefined;
  const origin = readStatsEvidenceOrigin();
  if (!origin || origin.path !== currentStatsEvidencePath(location)) return () => undefined;

  const timers = [0, 80, 280].map((delay) =>
    window.setTimeout(() => window.scrollTo({ top: origin.scrollY, behavior: 'auto' }), delay)
  );
  return () => timers.forEach((timer) => window.clearTimeout(timer));
}

export function buildStatsHandEvidencePath(handId: string, clubId?: string | null): string {
  const params = new URLSearchParams({ hand: handId, source: 'stats' });
  if (clubId) params.set('statsClub', clubId);
  return `/hand-history?${params.toString()}`;
}

export function buildStatsCashEvidencePath(
  metric: CashEvidenceMetric,
  options: {
    clubId?: string | null;
    asset?: 'chips' | 'diamonds';
    from?: string | null;
    to?: string | null;
  } = {}
): string {
  const params = new URLSearchParams({ source: 'stats', statsMetric: metric });
  if (options.clubId) params.set('statsClub', options.clubId);
  if (options.asset) params.set('statsAsset', options.asset);
  if (options.from) params.set('from', options.from);
  if (options.to) params.set('to', options.to);
  return `/hand-history?${params.toString()}`;
}

export function buildStatsTournamentEvidencePath(tournamentId: string): string {
  const params = new URLSearchParams({ source: 'stats' });
  return `/tournaments/${encodeURIComponent(tournamentId)}?${params.toString()}`;
}
