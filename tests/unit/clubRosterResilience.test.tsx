import '@testing-library/jest-dom/vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  RosterReadTimeoutError,
  computeRosterRetryDelay,
  runRosterReadWithRetry,
} from '../../src/utils/rosterReadReliability';
import RosterConnectionStatus from '../../src/components/club/RosterConnectionStatus';
import { readRosterCache } from '../../src/lib/rosterCache';

const PAGE = readFileSync(resolve(__dirname, '../../src/pages/ClubMembersPage.tsx'), 'utf8');
const SERVICE = readFileSync(resolve(__dirname, '../../src/services/ClubRosterService.ts'), 'utf8');
const CHANNEL = readFileSync(resolve(__dirname, '../../src/hooks/useMasterBusChannel.ts'), 'utf8');
const CACHE = readFileSync(resolve(__dirname, '../../src/lib/rosterCache.ts'), 'utf8');
const CSS = readFileSync(resolve(__dirname, '../../src/pages/ClubMembersPage.css'), 'utf8');
const POLICY = readFileSync(resolve(__dirname, '../../src/lib/rosterLoadPolicy.ts'), 'utf8');

describe('Player Command resilient reads', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('retries a transient Supabase-shaped failure and returns the recovered result', async () => {
    const read = vi
      .fn<(signal: AbortSignal) => Promise<string>>()
      .mockRejectedValueOnce({ message: 'Failed to fetch', status: 503 })
      .mockResolvedValue('live roster');

    const result = runRosterReadWithRetry(read, {
      attempts: 3,
      baseDelayMs: 100,
      random: () => 0.5,
    });

    await vi.advanceTimersByTimeAsync(100);
    await expect(result).resolves.toBe('live roster');
    expect(read).toHaveBeenCalledTimes(2);
  });

  it('does not retry authorization failures', async () => {
    const read = vi
      .fn<(signal: AbortSignal) => Promise<string>>()
      .mockRejectedValue({ message: 'JWT expired', status: 401 });

    await expect(runRosterReadWithRetry(read, { attempts: 3 })).rejects.toMatchObject({
      status: 401,
    });
    expect(read).toHaveBeenCalledTimes(1);
  });

  it('aborts during backoff instead of issuing a superseded request', async () => {
    const controller = new AbortController();
    const read = vi
      .fn<(signal: AbortSignal) => Promise<string>>()
      .mockRejectedValue(new TypeError('Failed to fetch'));
    const result = runRosterReadWithRetry(read, {
      attempts: 3,
      baseDelayMs: 500,
      signal: controller.signal,
      random: () => 0.5,
    });

    await vi.advanceTimersByTimeAsync(0);
    controller.abort();

    await expect(result).rejects.toMatchObject({ name: 'AbortError' });
    expect(read).toHaveBeenCalledTimes(1);
  });

  it('turns an attempt deadline into a retryable timeout', async () => {
    const read = vi.fn<(signal: AbortSignal) => Promise<string>>(
      (signal) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
        })
    );
    const result = runRosterReadWithRetry(read, {
      attempts: 2,
      timeoutMs: 50,
      baseDelayMs: 10,
      random: () => 0.5,
    });
    const rejection = expect(result).rejects.toBeInstanceOf(RosterReadTimeoutError);

    await vi.advanceTimersByTimeAsync(50);
    await vi.advanceTimersByTimeAsync(10);
    await vi.advanceTimersByTimeAsync(50);

    await rejection;
    expect(read).toHaveBeenCalledTimes(2);
  });

  it('uses capped exponential jitter instead of synchronized fixed retries', () => {
    expect(computeRosterRetryDelay(0, 1_000, 30_000, () => 0)).toBe(800);
    expect(computeRosterRetryDelay(1, 1_000, 30_000, () => 0.5)).toBe(2_000);
    expect(computeRosterRetryDelay(8, 1_000, 30_000, () => 1)).toBe(30_000);
  });
});

describe('Player Command connection truth', () => {
  const syncedAt = Date.UTC(2026, 7, 30, 20, 15, 0);

  it('keeps cached rows visibly marked stale until a live read succeeds', () => {
    const retry = vi.fn();
    render(
      <RosterConnectionStatus
        state="stale"
        hasData
        lastSuccessfulSyncAt={syncedAt}
        onRetry={retry}
      />
    );

    const status = screen.getByRole('status');
    const retryButton = screen.getByRole('button', { name: /Retry Live Sync/i });
    expect(status).toHaveAttribute('data-connection-state', 'stale');
    expect(status).toHaveTextContent(/Showing The Last Verified Roster/i);
    expect(status).toHaveTextContent(/Last Live Sync/i);
    expect(status).not.toContainElement(retryButton);
    fireEvent.click(retryButton);
    expect(retry).toHaveBeenCalledTimes(1);
  });

  it('does not claim a saved roster exists when the first live read failed', () => {
    render(<RosterConnectionStatus state="stale" hasData={false} onRetry={() => undefined} />);

    expect(screen.getByRole('status')).toHaveTextContent(/Could Not Be Loaded/i);
    expect(screen.getByRole('status')).not.toHaveTextContent(/Showing The Last Verified Roster/i);
  });

  it('distinguishes offline and realtime-reconnecting states', () => {
    const { rerender } = render(
      <RosterConnectionStatus state="offline" hasData onRetry={() => undefined} />
    );
    expect(screen.getByRole('status')).toHaveTextContent(/Connection Lost/i);

    rerender(<RosterConnectionStatus state="reconnecting" hasData onRetry={() => undefined} />);
    expect(screen.getByRole('status')).toHaveTextContent(/Live Updates Interrupted/i);
  });

  it('renders nothing once both the roster read and realtime channel are healthy', () => {
    const { container } = render(
      <RosterConnectionStatus state="live" hasData onRetry={() => undefined} />
    );
    expect(container).toBeEmptyDOMElement();
  });
});

describe('Player Command resilience wiring', () => {
  it('routes both first-page reads through the bounded retry utility', () => {
    expect(SERVICE.match(/runRosterReadWithRetry/g)?.length).toBeGreaterThanOrEqual(3);
    expect(SERVICE).toContain('{ attempts: 1, signal: query.signal, timeoutMs: 20_000 }');
    expect(PAGE).toContain('signal: controller.signal');
  });

  it('does not multiply an expensive cold page read across nested retry loops', () => {
    expect(PAGE).toContain('const recoveryScheduled = scheduleConnectionRecovery(1)');
    expect(SERVICE).not.toContain('{ attempts: 3, signal: query.signal');
    expect(SERVICE).not.toContain('{ signal: query.signal, timeoutMs: 8_000 }');
  });

  it('normalizes an older sparse cache row before the UI can render it', () => {
    const cachedAt = Date.now();
    sessionStorage.setItem(
      'roster_cache_v5_viewer_club',
      JSON.stringify({
        version: 5,
        at: cachedAt,
        rows: [{ user_id: 'player-1', alias: 'KingFish' }],
        summary: {
          viewer_role: 'player',
          capabilities: {
            can_view_financials: false,
            can_export: false,
            can_manage_members: false,
            can_view_notes: false,
          },
          counts: { total: 1, online: 0, seated: 0, agents: 0, admins: 0 },
          data_version: null,
          page_size: 80,
        },
      })
    );

    const cached = readRosterCache('viewer', 'club');
    expect(cached?.cachedAt).toBe(cachedAt);
    expect(cached?.rows[0]).toMatchObject({
      user_id: 'player-1',
      alias: 'KingFish',
      role: 'player',
      player_wallet: null,
      is_online: false,
    });
  });

  it('uses strict route resolution and gives a failed resolver a working retry path', () => {
    expect(PAGE).toContain('resolveClubUUIDStrict(routeClub)');
    expect(PAGE).toContain('error instanceof ClubNotFoundError');
    expect(PAGE).toContain('setResolutionAttempt((current) => current + 1)');
    expect(PAGE).toContain('onClick={retryLiveSync}');
  });

  it('keeps the cache timestamp and exposes realtime recovery completion', () => {
    expect(CACHE).toContain('cachedAt: parsed.at');
    expect(PAGE).toContain('setLastSuccessfulSyncAt(cached.cachedAt)');
    expect(CHANNEL).toContain('onSubscriptionStatus?: (status: string) => void');
    expect(PAGE).toContain("status !== 'SUBSCRIBED'");
  });

  it('uses inline persistent state instead of a repeated background failure toast', () => {
    expect(PAGE).toContain("setDataFreshness(membersRef.current.length > 0 ? 'stale' : 'failed')");
    expect(PAGE).not.toContain("toast.error('Failed To Load Members')");
    expect(PAGE).toContain('<RosterConnectionStatus');
  });

  it('keeps the last-known-good cache through transient refreshes', () => {
    expect(PAGE.match(/purgeRosterCache/g)?.length).toBe(2);
    expect(PAGE).toMatch(/if \(!nextSummary\) {[\s\S]*purgeRosterCache/);
    expect(PAGE).not.toMatch(/const refresh = useCallback\([\s\S]*purgeRosterCache/);
  });

  it('revokes every previously loaded capability and cursor when access disappears', () => {
    expect(PAGE).toMatch(
      /if \(!nextSummary\) {[\s\S]*setSummary\(DEFAULT_SUMMARY\)[\s\S]*setCursor\(null\)[\s\S]*setHasMore\(false\)[\s\S]*setFilteredTotal\(0\)/
    );
  });

  it('maps a failed online read to a retryable connection state', () => {
    expect(PAGE).toContain("dataFreshness === 'failed'");
  });

  it('recovers a cold first-page timeout without making the player retry manually', () => {
    expect(PAGE).toContain('const recoveryScheduled = scheduleConnectionRecovery(1)');
    expect(PAGE).toContain('setLoadError(!recoveryScheduled && !hasSavedRows)');
    expect(PAGE).toContain("recoveryScheduled ? 'loading' : 'failed'");
    expect(PAGE).toMatch(/recoveryAttemptRef\.current >= maxAttempts/);
  });

  it('gives every new query and explicit retry a fresh bounded recovery budget', () => {
    expect(PAGE).toContain("const recoveryRequestKeyRef = useRef('')");
    expect(PAGE).toContain('recoveryRequestKeyRef.current !== recoveryRequestKey');
    expect(PAGE).toMatch(
      /options\.resetRecovery === true[\s\S]*recoveryAttemptRef\.current = 0[\s\S]*recoveryRequestKeyRef\.current = recoveryRequestKey/
    );
    expect(PAGE).toContain('{ forceSummary: true, resetRecovery: true }');
  });

  it('does not export a previous query while the visible search is still settling', () => {
    expect(PAGE).toContain('searchQuery.trim() !== debouncedSearch.trim()');
    expect(PAGE).toContain('isExporting || searchIsSettling');
  });

  it('exposes virtualized roster positions as one accessible list', () => {
    expect(PAGE).toContain('role="list"');
    expect(PAGE).toContain('role="listitem"');
    expect(PAGE).toContain('aria-posinset={position}');
    expect(PAGE).toContain('aria-setsize={total}');
  });

  it('settles summary and directory reads independently', () => {
    expect(PAGE).toContain('settleRosterReadsIndependently');
    expect(POLICY).toContain('Promise.allSettled');
    expect(PAGE).toContain('RosterSummaryCoordinator');
    expect(PAGE).toContain("reportError(error, 'ClubMembersPage.loadSummary')");
    expect(PAGE).toMatch(/onPage: \(page\) => {[\s\S]*setMembers\(page\.items\)/);
  });

  it('announces a summary label before its value and exposes independent freshness', () => {
    expect(PAGE).toMatch(
      /<dt className="stat-label">\{label\}<\/dt>[\s\S]*<dd className="stat-value">\{value\}<\/dd>/
    );
    expect(PAGE).toContain('members-summary__status');
    expect(PAGE).toContain("summaryFreshness === 'failed'");
  });

  it('compresses the cinematic command deck on short desktop viewports', () => {
    expect(CSS).toContain('@media (min-width: 721px) and (max-height: 820px)');
    expect(CSS).toMatch(/max-height:\s*820px[\s\S]*\.members-hero[\s\S]*min-height:\s*222px/);
  });
});
