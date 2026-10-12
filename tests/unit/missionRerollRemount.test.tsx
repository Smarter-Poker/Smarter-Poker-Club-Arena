import React from 'react';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { BrowserRouter, Route, Routes } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { useDailyMissionDashboard } from '../../src/components/challenges/dashboard/useDailyMissionDashboard';
import { useIsMounted } from '../../src/hooks/useIsMounted';

const calls = vi.hoisted(() => ({ getDashboard: vi.fn() }));
vi.mock('../../src/lib/supabase', () => ({
  getAuthUser: async () => ({ data: { user: { id: 'owned-user' } }, error: null }),
}));
vi.mock('../../src/services/DailyChallengeService', () => ({ dailyChallengeService: calls }));
vi.mock('../../src/services/DailyMissionTelemetryService', () => ({
  dailyMissionReasonCode: () => 'fixed-refusal',
  recordDailyMissionOperation: vi.fn(),
}));
vi.mock('../../src/lib/analytics', () => ({ capture: vi.fn() }));
vi.mock('../../src/utils/errorReporter', () => ({ reportError: vi.fn() }));

function Board() {
  const state = useDailyMissionDashboard({ isMountedRef: useIsMounted() });
  return (
    <section id="daily-missions" aria-busy={state.isLoading}>
      {state.loadError && <span role="alert">{state.loadError}</span>}
      <output data-testid="balance">{state.diamondBalance}</output>
      {state.challenges.map((row) => (
        <article key={row.id} data-testid={row.id}>
          {row.challengeId}
        </article>
      ))}
    </section>
  );
}
function projection(ids: string[], balance: number) {
  return {
    missions: ids.map((challengeId, index) => ({ id: `row-${index}`, challengeId })),
    diamondBalance: balance,
    revision: 4,
    syncedAt: new Date().toISOString(),
    periodKeys: { daily: '2026-10-07', weekly: 'W2026-10-05', monthly: 'M2026-10' },
    stats: {},
    streak: {},
    vault: {},
  };
}
async function route(path: string) {
  await act(async () => {
    window.history.pushState({}, '', path);
    window.dispatchEvent(new PopStateEvent('popstate', { state: window.history.state }));
  });
}
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('concurrent mission persistence remount', () => {
  it('retires the real dashboard hook through BrowserRouter and queries both persisted replacements anew', async () => {
    calls.getDashboard
      .mockResolvedValueOnce(projection(['old-a', 'old-b'], 7000))
      .mockResolvedValueOnce(projection(['new-a', 'new-b'], 6998));
    window.history.replaceState({}, '', '/challenges');
    render(
      <BrowserRouter>
        <Routes>
          <Route path="/challenges" element={<Board />} />
          <Route path="/notifications" element={<h1>Notifications</h1>} />
        </Routes>
      </BrowserRouter>
    );
    await screen.findByText('old-a');
    await route('/notifications');
    expect(document.querySelector('#daily-missions')).toBeNull();
    await route('/challenges');
    await screen.findByText('new-a');
    expect(screen.getByTestId('row-1').textContent).toBe('new-b');
    expect(screen.getByTestId('balance').textContent).toBe('6998');
    expect(calls.getDashboard).toHaveBeenCalledTimes(2);
    expect(calls.getDashboard).toHaveBeenNthCalledWith(2, 'owned-user');
  });

  it('demonstrates why a retained old board cannot satisfy positive unmount and fresh-receipt admission', async () => {
    calls.getDashboard.mockResolvedValue(projection(['old-a', 'old-b'], 7000));
    window.history.replaceState({}, '', '/challenges');
    render(
      <BrowserRouter>
        <Board />
        <Routes>
          <Route path="/challenges" element={<span>Challenges</span>} />
          <Route path="/notifications" element={<h1>Notifications</h1>} />
        </Routes>
      </BrowserRouter>
    );
    await screen.findByText('old-a');
    await route('/notifications');
    expect(document.querySelector('#daily-missions')).not.toBeNull();
    await route('/challenges');
    expect(screen.getByTestId('row-0').textContent).toBe('old-a');
    expect(calls.getDashboard).toHaveBeenCalledTimes(1);
  });

  it('keeps a fresh native dashboard refusal visible after remount', async () => {
    calls.getDashboard
      .mockResolvedValueOnce(projection(['old-a', 'old-b'], 7000))
      .mockRejectedValueOnce(new Error('native refusal'));
    window.history.replaceState({}, '', '/challenges');
    render(
      <BrowserRouter>
        <Routes>
          <Route path="/challenges" element={<Board />} />
          <Route path="/notifications" element={<h1>Notifications</h1>} />
        </Routes>
      </BrowserRouter>
    );
    await screen.findByText('old-a');
    await route('/notifications');
    await route('/challenges');
    await waitFor(() =>
      expect(screen.getByRole('alert').textContent).toContain('Challenge Ledger Unavailable')
    );
    expect(screen.queryByText('old-a')).toBeNull();
  });

  it('binds the actual concurrent financial step to positive unmount, fresh receipt, exact pairs and no financial resubmission', () => {
    const spec = readFileSync(
      resolve(import.meta.dirname, '../e2e/production-daily-missions.spec.ts'),
      'utf8'
    );
    const step = spec.slice(
      spec.indexOf("test.step('different-card rerolls"),
      spec.indexOf("test.step('freeze purchase")
    );
    expect(step).toContain('await remountConcurrentMissionReceipts({');
    expect(step).toContain('rowId: row.id');
    expect(step).toContain('catalogId: replacementIds[index]');
    expect(step).toContain('balance: balanceBefore - 2');
    expect(step).toContain("row.tier_snapshot === 'daily'");
    expect(step).toContain('row.assigned_date === currentPeriodKeys().daily');
    expect(step).not.toContain('page.reload(');
    const helper = readFileSync(
      resolve(import.meta.dirname, '../e2e/support/missionRerollRemount.ts'),
      'utf8'
    );
    expect(helper).toContain('toHaveCount(0, { timeout: remaining() })');
    expect(helper).toContain('freshRequests.has(response.request())');
    expect(helper).toContain(
      'row.id === replacement.rowId && row.challenge_id === replacement.catalogId'
    );
    expect(helper).toContain('expect(rerollRequests');
    expect(helper).toContain('documentReloadProven: false');
  });
});
