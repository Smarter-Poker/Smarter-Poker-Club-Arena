/**
 * LIGHTNING PHASE 12: THE OPERATOR DASHBOARD (Spec Phase 21).
 *
 * The page reads five operator doors. Every fixture below is built from the
 * shapes the DB branch's migration produces (tests/lightning/fixtures), so a
 * field the database cannot produce never passes here.
 */
import { readFileSync } from 'node:fs';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CLUB_ID,
  CLUSTER_A,
  CLUSTER_B,
  CLUSTER_C,
  HAND_ID,
  MISSING_FUNCTION_ERROR,
  NOT_AUTHORIZED_ANSWER,
  NOT_FOUND_ANSWER,
  POOL_SESSION,
  clusterAnswer,
  handReplayAnswer,
  overviewAnswer,
  sessionTrailAnswer,
  signalReviewAnswer,
} from './fixtures/lightningOperatorDoors';

const state = vi.hoisted(() => ({
  rpc: vi.fn(),
  toast: { success: vi.fn(), error: vi.fn() },
  reportError: vi.fn(),
}));

vi.mock('../../src/lib/supabase', () => ({ supabase: { rpc: state.rpc } }));
vi.mock('../../src/components/common/Toast', () => ({ useToast: () => state.toast }));
vi.mock('../../src/utils/errorReporter', () => ({ reportError: state.reportError }));
vi.mock('../../src/pages/club/lightning/LightningLatencyChart', () => ({
  default: () => <div data-testid="latency-chart" />,
}));
vi.mock('../../src/components/console/SpadeConsole', () => ({
  SpadeConsole: ({ children, plates, title, pill }: any) => (
    <section>
      <h2>{title}</h2>
      {pill ? <span data-testid="pill">{pill}</span> : null}
      {children}
      {plates?.secondary ? (
        <button type="button" onClick={plates.secondary.onClick}>
          {plates.secondary.label}
        </button>
      ) : null}
      {plates?.primary ? (
        <button type="button" onClick={plates.primary.onClick} disabled={plates.primary.disabled}>
          {plates.primary.label}
        </button>
      ) : null}
    </section>
  ),
}));

import {
  fetchLightningOverview,
  foldLabel,
  interpretAnswer,
  interpretHandReplay,
  modeBadge,
  parseClusterDetail,
  parseOverview,
  parseSessionTrail,
  reconcileGap,
  shadowMetricLabel,
  verdictLabel,
} from '../../src/lightning/operator/lightningOperatorApi';
import { keepsPolling } from '../../src/lightning/operator/useLightningOperator';
import ClubLightningOperationsPage from '../../src/pages/club/ClubLightningOperationsPage';
import { getClubNavigationCapabilities } from '../../src/config/clubArenaNavigation';
import {
  getClubOperationItems,
  getRequiredClubOperationAccess,
} from '../../src/config/clubOperationsNavigation';

type Door = (args: Record<string, unknown>) => { data: unknown; error: unknown };

function doors(map: Record<string, Door>) {
  state.rpc.mockImplementation(async (fn: string, args: Record<string, unknown>) => {
    const door = map[fn];
    if (!door) return { data: null, error: { ...MISSING_FUNCTION_ERROR } };
    return door(args);
  });
}

function Where() {
  const loc = useLocation();
  return <span data-testid="where">{`${loc.pathname}${loc.search}`}</span>;
}

function renderPage(search = '') {
  return render(
    <MemoryRouter initialEntries={[`/clubs/${CLUB_ID}/lightning${search}`]}>
      <Routes>
        <Route
          path="/clubs/:clubId/lightning"
          element={
            <>
              <ClubLightningOperationsPage />
              <Where />
            </>
          }
        />
      </Routes>
    </MemoryRouter>
  );
}

const ok = (data: unknown) => () => ({ data, error: null });

const SOURCES = [
  'src/lightning/operator/lightningOperatorApi.ts',
  'src/lightning/operator/useLightningOperator.ts',
  'src/pages/club/ClubLightningOperationsPage.tsx',
  'src/pages/club/lightning/LightningClusterDetail.tsx',
  'src/pages/club/lightning/LightningLatencyChart.tsx',
  'src/pages/club/lightning/lightningOperatorParts.tsx',
].map((path) => ({ path, text: readFileSync(path, 'utf8') }));

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('the operator doors are parsed from the shapes the database produces', () => {
  it('reads every overview field of every Cluster', () => {
    const parsed = parseOverview(overviewAnswer());
    expect(parsed?.clusters.map((c) => c.clusterId)).toEqual([CLUSTER_A, CLUSTER_B, CLUSTER_C]);
    const a = parsed!.clusters[0];
    expect(a.mode).toBe('lightning');
    expect(a.liveEligible).toBe(23);
    expect(a.onThreshold).toBe(18);
    expect(a.offThreshold).toBe(12);
    expect(a.pool).toEqual({
      joining: 1,
      eligibilityCheck: 0,
      active: 19,
      sitOut: 2,
      disconnected: 1,
      leaving: 0,
    });
    expect(a.reservations).toEqual({ pending: 3, committed: 12 });
    expect(a.instances).toEqual({ forming: 1, reserved: 0, dealing: 3, settling: 1 });
    expect(a.flags).toEqual({
      shadowMatcher: true,
      integrityTelemetry: true,
      autoRebuy: false,
      latencyTelemetry: true,
    });
    expect(a.shadow).toEqual({
      verdict: 'insufficient_evidence',
      comparisons: 12,
      deltaMean: 1.84,
      liveVersion: 'm1',
      candidateVersion: 'm2',
    });
    expect(a.stuckConversion).toBeNull();
    expect(parsed!.truncated).toBe(false);
    // The database answers a stuck conversion as the conversion itself.
    expect(parsed!.clusters[1].stuckConversion).toEqual({
      fromMode: 'lightning',
      toMode: 'must_move',
      openedAt: '2026-10-09T13:30:00.000Z',
      ageMs: 1_800_000,
      thresholdMs: 1_200_000,
    });
    expect(a.latency?.legs.fold_ack).toEqual({ n: 412, p50: 38, p95: 91, p99: 140 });
    // A leg the window did not measure is absent, never a zero.
    expect(a.latency?.legs.hand_to_first_render).toBeUndefined();
    const c = parsed!.clusters[2];
    expect(c.frozen).toEqual({
      at: '2026-10-09T12:02:00.000Z',
      reason: 'LIGHTNING_FORMATION_MOVED_MONEY',
      invariant: null,
    });
  });

  it('reads the Cluster detail, including the shadow report fn_lightning_shadow_report builds', () => {
    const d = parseClusterDetail(clusterAnswer())!;
    expect(d.cluster?.clusterId).toBe(CLUSTER_A);
    expect(d.transitions.map((t) => t.kind)).toEqual(['epoch', 'conversion', 'epoch']);
    expect(d.transitions[1]).toMatchObject({
      fromMode: 'must_move',
      mode: 'lightning',
      status: 'committed',
      epoch: 4,
    });
    expect(d.reservations[0]).toMatchObject({
      seatNumber: 3,
      state: 'pending',
      instanceState: 'forming',
      orphan: false,
    });
    expect(d.blindLedger[0]).toMatchObject({ missedBbDebt: 1, bbOwed: 2 });
    expect(d.reconcile.map((r) => r.ok)).toEqual([true, false]);
    expect(reconcileGap(d.reconcile[1])).toBe(120);
    expect(d.shadow[0]).toMatchObject({
      liveVersion: 'm1',
      candidateVersion: 'm2',
      comparisons: 12,
      deltaMean: 1.84,
      verdict: 'insufficient_evidence',
    });
    expect(d.shadow[0].components.map((m) => m.key)).toContain('component.bb_fairness');
    expect(d.signals[0]).toMatchObject({ id: '41', pattern: 'PAIRING_CONCENTRATION' });
    expect(d.alerts[0]).toMatchObject({ source: 'lightning_alerts', check: 'latency_regression' });
    expect(d.latencyWindows).toHaveLength(3);
    expect(d.quality?.score).toBe(71.2);
  });

  it('reads a session trail with its overlapping mode transitions', () => {
    const t = parseSessionTrail(sessionTrailAnswer())!;
    expect(t.poolSessionId).toBe(POOL_SESSION);
    expect(t.state).toBe('active');
    expect(t.steps.map((s) => s.label)).toEqual([
      'Pool Entered',
      'Slot Opened',
      'Reservation Committed',
      'Hand',
    ]);
    expect(t.steps[3].detail).toBe('Hand 1042, Seat 1');
    expect(t.transitions.map((x) => x.kind)).toEqual(['conversion', 'epoch']);
  });

  it('treats a replay check that found defects as a finding, not a refusal', () => {
    const clean = interpretHandReplay(handReplayAnswer(false));
    expect(clean.status === 'ok' && clean.data.consistent).toBe(true);
    const bad = interpretHandReplay(handReplayAnswer(true));
    expect(bad.status).toBe('ok');
    expect(bad.status === 'ok' && bad.data.consistent).toBe(false);
    expect(bad.status === 'ok' && bad.data.defects[0].code).toBe('conservation');
    expect(bad.status === 'ok' && bad.data.handNumber).toBe(1042);
    expect(bad.status === 'ok' && bad.data.players.map((p) => foldLabel(p.foldType))).toEqual([
      null,
      'Lightning Fold',
    ]);
    expect(bad.status === 'ok' && bad.data.players.map((p) => p.net)).toEqual([12, -13]);
    expect(interpretHandReplay(NOT_AUTHORIZED_ANSWER).status).toBe('denied');
    expect(interpretHandReplay(NOT_FOUND_ANSWER)).toEqual({ status: 'refused', code: 'NOT_FOUND' });
  });

  it('answers NOT_AUTHORIZED as denied and any other refusal by its code', () => {
    expect(interpretAnswer(NOT_AUTHORIZED_ANSWER, parseOverview).status).toBe('denied');
    expect(interpretAnswer({ ok: false, code: 'CLUSTER_NOT_FOUND' }, parseOverview)).toEqual({
      status: 'refused',
      code: 'CLUSTER_NOT_FOUND',
    });
  });

  it('answers a missing function as not available yet, and a 42501 as denied', async () => {
    state.rpc.mockResolvedValueOnce({ data: null, error: { ...MISSING_FUNCTION_ERROR } });
    expect((await fetchLightningOverview(CLUB_ID)).status).toBe('unavailable');
    state.rpc.mockResolvedValueOnce({ data: null, error: { code: '42501', message: 'denied' } });
    expect((await fetchLightningOverview(CLUB_ID)).status).toBe('denied');
    expect(state.reportError).not.toHaveBeenCalled();
    expect(state.rpc).toHaveBeenCalledWith('fn_lightning_operator_overview', {
      p_club_id: CLUB_ID,
    });
  });

  it('stops polling on a final answer and keeps polling on a reading or a fault', () => {
    expect(keepsPolling({ status: 'unavailable' })).toBe(false);
    expect(keepsPolling({ status: 'denied' })).toBe(false);
    expect(keepsPolling({ status: 'refused', code: 'X' })).toBe(false);
    expect(keepsPolling({ status: 'error', message: 'x' })).toBe(true);
    expect(keepsPolling({ status: 'ok', data: null })).toBe(true);
  });
});

describe('operator vocabulary', () => {
  it('names the four modes the way an operator reads them', () => {
    expect(modeBadge('must_move').label).toBe('Must Move');
    expect(modeBadge('lightning').label).toBe('Lightning');
    expect(modeBadge('pending_on')).toMatchObject({ label: 'Pending', tone: 'pending' });
    expect(modeBadge('pending_off').detail).toBe('Reverting To Must Move');
    expect(modeBadge('frozen').tone).toBe('frozen');
    expect(verdictLabel('shadow_leads')).toBe('Candidate Leads');
    expect(shadowMetricLabel('component.bb_fairness')).toBe('BB Fairness');
  });

  it('never prints a rival product name, a horse marker or a card field', () => {
    for (const { path, text } of SOURCES) {
      expect(text, path).not.toMatch(/\b(Zoom|Rush|Snap|Fast Forward)\b/);
      expect(text, path).not.toMatch(/is_horse|isHorse|horse_id/);
      expect(text, path).not.toMatch(/hole_cards|holeCards|board_cards|\bdeck\b/);
      expect(text, path).not.toContain('—');
    }
  });
});

describe('the overview page', () => {
  it('prints every Cluster with its mode, warnings and figures', async () => {
    doors({ fn_lightning_operator_overview: ok(overviewAnswer()) });
    renderPage();
    expect(await screen.findByText('NLH 1/2 Lightning')).toBeTruthy();
    expect(screen.getByTestId('pill').textContent).toBe('3 Clusters');
    expect(screen.getAllByText('Lightning').length).toBeGreaterThan(0);
    expect(screen.getByText('Pending')).toBeTruthy();
    expect(screen.getByText('Frozen')).toBeTruthy();
    expect(screen.getByText('Frozen: Lightning Formation Moved Money')).toBeTruthy();
    expect(screen.getByText('Conversion Stuck: Lightning To Must Move')).toBeTruthy();
    expect(screen.getByText('1 Orphan Hold')).toBeTruthy();
    expect(screen.getAllByText('Lightning Fold To Next Hand').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Fold & Watch To Next Hand').length).toBeGreaterThan(0);
    expect(document.body.textContent).not.toMatch(/horse/i);
  });

  it('opens a Cluster on a tap, and only changes this page', async () => {
    doors({
      fn_lightning_operator_overview: ok(overviewAnswer()),
      fn_lightning_operator_cluster: ok(clusterAnswer()),
    });
    renderPage();
    const open = await screen.findAllByText('Open Cluster');
    fireEvent.click(open[0]);
    await screen.findByText('Stack Reconcile');
    expect(screen.getByTestId('where').textContent).toBe(
      `/clubs/${CLUB_ID}/lightning?cluster=${CLUSTER_A}`
    );
    const call = state.rpc.mock.calls.find((c) => c[0] === 'fn_lightning_operator_cluster');
    expect(call?.[1]).toMatchObject({ p_cluster_id: CLUSTER_A });
    expect(Date.parse(call?.[1].p_to) - Date.parse(call?.[1].p_from)).toBe(24 * 3600 * 1000);
  });

  it('says Not Available Yet when the door is missing, and does not ask again on a timer', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    doors({});
    renderPage();
    expect(await screen.findByText(/Not Available Yet/)).toBeTruthy();
    const calls = state.rpc.mock.calls.length;
    await act(async () => {
      vi.advanceTimersByTime(120_000);
    });
    expect(state.rpc.mock.calls.length).toBe(calls);
  });

  it('says the page is restricted when the door answers NOT_AUTHORIZED', async () => {
    doors({ fn_lightning_operator_overview: ok(NOT_AUTHORIZED_ANSWER) });
    renderPage();
    expect(await screen.findByText(/Available To Club Owners And Administrators/)).toBeTruthy();
    expect(screen.queryByText('Open Cluster')).toBeNull();
  });

  it('refreshes every 15 seconds while visible, and never while hidden', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    doors({ fn_lightning_operator_overview: ok(overviewAnswer()) });
    renderPage();
    await screen.findByText('NLH 1/2 Lightning');
    const reads = () =>
      state.rpc.mock.calls.filter((c) => c[0] === 'fn_lightning_operator_overview').length;
    const first = reads();
    await act(async () => {
      vi.advanceTimersByTime(15_000);
    });
    await waitFor(() => expect(reads()).toBe(first + 1));
    const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    await act(async () => {
      vi.advanceTimersByTime(60_000);
    });
    expect(reads()).toBe(first + 1);
    visibility.mockRestore();
  });
});

describe('the Cluster detail', () => {
  function detailDoors(extra: Record<string, Door> = {}) {
    doors({
      fn_lightning_operator_cluster: ok(clusterAnswer()),
      fn_lightning_operator_signal_review: ok(signalReviewAnswer('cleared')),
      fn_lightning_operator_hand_replay: ok(handReplayAnswer(true)),
      fn_lightning_operator_session_trail: ok(sessionTrailAnswer()),
      ...extra,
    });
  }

  it('highlights a stack that does not reconcile', async () => {
    detailDoors();
    const { container } = renderPage(`?cluster=${CLUSTER_A}`);
    await screen.findByText('Stack Reconcile');
    const rows = container.querySelectorAll('[data-reconciled]');
    expect([...rows].map((r) => r.getAttribute('data-reconciled'))).toEqual(['true', 'false']);
    expect(rows[1].textContent).toContain('Off By 120');
    expect(screen.getByText('Candidate Matcher')).toBeTruthy();
    expect(screen.getByText('Insufficient Evidence')).toBeTruthy();
    expect(screen.getByText('Latency Regression')).toBeTruthy();
    expect(screen.getByText('Conversion, Must Move To Lightning, Committed')).toBeTruthy();
  });

  it('reviews an integrity signal through the one writing door', async () => {
    detailDoors();
    renderPage(`?cluster=${CLUSTER_A}`);
    fireEvent.click(await screen.findByText('Review'));
    fireEvent.click(screen.getByText('Cleared'));
    fireEvent.change(screen.getByPlaceholderText('What You Found'), {
      target: { value: '  Same household, verified  ' },
    });
    fireEvent.click(screen.getByText('Save Review'));
    await waitFor(() => expect(state.toast.success).toHaveBeenCalled());
    expect(state.rpc).toHaveBeenCalledWith('fn_lightning_operator_signal_review', {
      p_signal_id: '41',
      p_status: 'cleared',
      p_note: 'Same household, verified',
    });
  });

  it('checks one hand and shows its defects', async () => {
    detailDoors();
    renderPage(`?cluster=${CLUSTER_A}`);
    fireEvent.change(await screen.findByPlaceholderText('The Lightning Hand ID'), {
      target: { value: HAND_ID },
    });
    fireEvent.click(screen.getByText('Check Hand'));
    expect(await screen.findByText('Defects Found')).toBeTruthy();
    expect(state.rpc).toHaveBeenCalledWith('fn_lightning_operator_hand_replay', {
      p_cluster_id: CLUSTER_A,
      p_hand_id: HAND_ID,
    });
  });

  it('replays a player session from its reconcile row, with the mode transitions it overlapped', async () => {
    detailDoors();
    renderPage(`?cluster=${CLUSTER_A}`);
    await screen.findByText('Stack Reconcile');
    fireEvent.click(screen.getAllByText('Trail')[0]);
    fireEvent.click(screen.getByText('Show Trail'));
    expect(await screen.findByText(/Reservation Committed/)).toBeTruthy();
    expect(screen.getByText('Mode Transitions During This Session')).toBeTruthy();
    expect(state.rpc).toHaveBeenCalledWith('fn_lightning_operator_session_trail', {
      p_cluster_id: CLUSTER_A,
      p_pool_session_id: POOL_SESSION,
    });
  });

  it('asks for a new window when the operator picks one', async () => {
    detailDoors();
    renderPage(`?cluster=${CLUSTER_A}`);
    await screen.findByText('Stack Reconcile');
    fireEvent.click(screen.getByText('1 Hour'));
    await waitFor(() => {
      const calls = state.rpc.mock.calls.filter((c) => c[0] === 'fn_lightning_operator_cluster');
      const last = calls[calls.length - 1][1];
      expect(Date.parse(last.p_to) - Date.parse(last.p_from)).toBe(3600 * 1000);
    });
  });
});

describe('the door in the operations workspace', () => {
  it('is a control tool, advertised only to the roles the database admits', () => {
    const owner = getClubOperationItems('shark', getClubNavigationCapabilities('owner'));
    const agent = getClubOperationItems('shark', getClubNavigationCapabilities('super_agent'));
    expect(owner.find((i) => i.id === 'lightning')).toMatchObject({
      label: 'Lightning',
      access: 'control',
      path: '/clubs/shark/lightning',
    });
    expect(agent.find((i) => i.id === 'lightning')).toBeUndefined();
    expect(getRequiredClubOperationAccess('/clubs/shark/lightning')).toBe('control');
  });

  it('loads the page lazily, out of the entry chunk', () => {
    const app = readFileSync('src/App.tsx', 'utf8');
    expect(app).toMatch(
      /const ClubLightningOperationsPage = lazyWithRetry\(\s*\(\) => import\('\.\/pages\/club\/ClubLightningOperationsPage'\)\s*\);/
    );
    expect(app).not.toMatch(/^import .*ClubLightningOperationsPage/m);
    expect(app).toContain('path="clubs/:clubId/lightning"');
  });
});
