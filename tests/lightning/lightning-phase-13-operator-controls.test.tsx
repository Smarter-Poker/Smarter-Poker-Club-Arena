/**
 * LIGHTNING PHASE 13: OPERATOR CONTROLS (Spec Phase 22: Operator Controls,
 * Emergency Drain, Cluster Freeze, Rollback).
 *
 * The page writes through one door, fn_lightning_operator_control, and reads
 * one more, fn_lightning_rollout_readiness. Every fixture is built from the
 * shapes the DB branch's migration produces (tests/lightning/fixtures), so a
 * field the database cannot produce never passes here.
 */
import { readFileSync } from 'node:fs';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MISSING_FUNCTION_ERROR, NOT_AUTHORIZED_ANSWER } from './fixtures/lightningOperatorDoors';
import {
  CLUB_ID,
  CLUSTER_A,
  alreadyAnswer,
  clusterAnswer13,
  controlAnswer,
  controlCluster,
  drainState,
  operatorTransitions,
  overviewAnswer13,
  readinessAnswer,
  stateOf,
  refusal,
} from './fixtures/lightningOperatorControlDoors';

const state = vi.hoisted(() => ({
  changed: null as null | (() => void),
  rpc: vi.fn(),
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() },
  reportError: vi.fn(),
}));

vi.mock('../../src/lightning/lightningOperatorEvents', () => ({
  watchLightningOperator: (_club: string, _cluster: string, onChange: () => void) => {
    state.changed = onChange;
    return () => {
      if (state.changed === onChange) state.changed = null;
    };
  },
}));
vi.mock('../../src/lib/supabase', () => ({ supabase: { rpc: state.rpc } }));
vi.mock('../../src/components/common/Toast', () => ({ useToast: () => state.toast }));
vi.mock('../../src/utils/errorReporter', () => ({ reportError: state.reportError }));
vi.mock('../../src/pages/club/lightning/LightningLatencyChart', () => ({
  default: () => <div data-testid="latency-chart" />,
}));
vi.mock('../../src/components/console/SpadeConsole', () => ({
  SpadeConsole: ({ children, plates, title, pill, onClose }: any) => (
    <section>
      <h2>{title}</h2>
      {pill ? <span data-testid="pill">{pill}</span> : null}
      {onClose ? (
        <button type="button" aria-label="Close" onClick={onClose}>
          x
        </button>
      ) : null}
      {children}
      {plates?.secondary ? (
        <button
          type="button"
          onClick={plates.secondary.onClick}
          disabled={plates.secondary.disabled}
        >
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
  parseClusterDetail,
  parseOverview,
  modeBadge,
} from '../../src/lightning/lightningOperatorApi';
import {
  confirmationMatches,
  confirmationPhrase,
  deadlineLabel,
  newRequestId,
  parseControlResult,
  parseReadiness,
  reasonIsValid,
  refusalWords,
  specFlags,
  stateChanges,
  shadowWindowMilliseconds,
  shadowWindowLabel,
} from '../../src/lightning/lightningOperatorControls';
import ClubLightningOperationsPage, {
  clusterNotices,
} from '../../src/pages/club/ClubLightningOperationsPage';

type Door = (args: Record<string, any>) => { data: unknown; error: unknown } | Promise<any>;

function doors(map: Record<string, Door>) {
  state.rpc.mockImplementation(async (fn: string, args: Record<string, unknown>) => {
    if (fn === 'fn_club_union_context')
      return { data: [{ own_union_id: null, member_union_id: null }], error: null };
    const door = map[fn];
    if (!door) return { data: null, error: { ...MISSING_FUNCTION_ERROR } };
    return door(args);
  });
}

const ok = (data: unknown) => () => ({ data, error: null });
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function renderDetail() {
  return render(
    <MemoryRouter initialEntries={[`/clubs/${CLUB_ID}/lightning?cluster=${CLUSTER_A}`]}>
      <Routes>
        <Route path="/clubs/:clubId/lightning" element={<ClubLightningOperationsPage />} />
      </Routes>
    </MemoryRouter>
  );
}

/** The detail's doors, with the control door answering a pause by default. */
function detailDoors(row: Record<string, unknown> = {}, extra: Record<string, Door> = {}) {
  doors({
    fn_lightning_operator_cluster: ok(clusterAnswer13(row)),
    fn_lightning_rollout_readiness: ok(readinessAnswer('no_go')),
    fn_lightning_operator_control: (args) => ({
      data: controlAnswer(
        args.p_action,
        args.p_args.request_id,
        controlCluster(),
        controlCluster({ paused: true, paused_from: 'lightning', cluster_mode: 'paused' })
      ),
      error: null,
    }),
    ...extra,
  });
}

const controlCalls = () =>
  state.rpc.mock.calls.filter((c) => c[0] === 'fn_lightning_operator_control');

function dialog() {
  return screen.getByRole('dialog');
}

async function openControl(label: string) {
  fireEvent.click(await screen.findByRole('button', { name: label }));
  return dialog();
}

function typeReason(value: string) {
  fireEvent.change(within(dialog()).getByPlaceholderText('Why, For The Audit Trail'), {
    target: { value },
  });
}

function confirmButton() {
  return within(dialog()).getByRole('button', { name: /^(Confirm|Sending|Send Again)$/ });
}

const SOURCES = [
  'src/lightning/lightningOperatorControls.ts',
  'src/pages/club/lightning/LightningOperatorControls.tsx',
].map((path) => ({ path, text: readFileSync(path, 'utf8') }));

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('the Phase 13 row keys are parsed from the shapes the database produces', () => {
  it('reads paused, joins, the drain, the matcher and every Spec flag', () => {
    const parsed = parseOverview(overviewAnswer13())!;
    const [a, b, c] = parsed.clusters;
    expect(a.joinsEnabled).toBe(false);
    expect(a.drain).toEqual({
      drainId: 'a1a1a1a1-a1a1-41a1-81a1-a1a1a1a1a1a1',
      phase: 'finishing',
      fromMode: 'lightning',
      overdue: false,
      requestedAt: '2026-10-09T13:59:10.000Z',
      requestedBy: '12121212-1212-4212-8212-121212121212',
      reason: 'Emergency drain for the 22:00 maintenance',
      deadlineAt: '2026-10-09T14:01:10.000Z',
      instancesRemaining: 3,
      handsRemaining: 2,
      sessionsRemaining: 14,
    });
    expect(a.matcher).toEqual({
      version: 'm1',
      previous: 'm1',
      disabled: [],
      shadowVersion: 'm2',
      shadowDisabled: false,
    });
    expect(b.paused).toBe(true);
    expect(b.pausedFrom).toBe('lightning');
    expect(c.paused).toBe(false);
    expect(specFlags(a.flagValues).map((f) => f.flag)).toEqual([
      'lightning_v1',
      'lightning_fast_fold',
      'lightning_fold_watch',
      'lightning_multi_table',
      'lightning_pool_health',
      'lightning_repeat_suppression',
      'lightning_session_stats',
      'lightning_shadow_matcher',
      'lightning_auto_rebuy',
      'lightning_adaptive_liquidity',
    ]);
    // Phase 12's four flags still read exactly as before.
    expect(a.flags.shadowMatcher).toBe(true);
  });

  it('reads a Phase 12 row (no Phase 13 keys) as not known, never as a guess', () => {
    const d = parseClusterDetail({
      ok: true,
      cluster: { cluster_id: CLUSTER_A },
      transitions: [],
    })!;
    expect(d.cluster).toMatchObject({
      paused: null,
      pausedFrom: null,
      joinsEnabled: null,
      drain: null,
      matcher: null,
    });
  });

  it('names the two operator modes', () => {
    expect(modeBadge('paused')).toMatchObject({ label: 'Paused', tone: 'pending' });
    expect(modeBadge('draining')).toMatchObject({ label: 'Draining', tone: 'pending' });
  });

  it('reads the control answer and its before and after', () => {
    const r = parseControlResult(
      controlAnswer(
        'drain',
        'f1f1f1f1-f1f1-41f1-81f1-f1f1f1f1f1f1',
        controlCluster(),
        controlCluster({ cluster_mode: 'draining', joins_enabled: false, drain: drainState() })
      )
    )!;
    expect(r).toMatchObject({ idempotent: false, action: 'drain', eventId: '90417' });
    const changed = stateChanges(r.before, r.after).filter((c) => c.changed);
    expect(changed.map((c) => [c.label, c.before, c.after])).toEqual([
      ['Mode', 'Lightning', 'Draining'],
      ['Joins', 'Open', 'Closed'],
      ['Drain', 'None', 'Finishing Hands'],
    ]);
  });

  it('reads the readiness verdict, every reason in plain words and the evidence', () => {
    const r = parseReadiness(readinessAnswer('no_go'))!;
    expect(r.verdict).toBe('no_go');
    expect(r.reasons.map((x) => [x.code, x.severity, x.text, x.detail])).toEqual([
      ['OPEN_ALERTS', 'blocking', 'Lightning Alerts Are Open', '1'],
      ['INTEGRITY_HIGH_SIGNALS_OPEN', 'blocking', 'High Severity Integrity Signals Are Open', '1'],
      // An engineer's sentence stays in the database; the code says it.
      ['WORKER_SHADOW_ONLY', 'evidence', 'The Worker Runs In Shadow Only And Forms No Hands', null],
      ['NO_AA_CALIBRATION', 'evidence', 'No A/A Calibration Of The Live Matcher Yet', null],
    ]);
    expect(r.checks.find((c) => c.label === 'Lightning Migrations Applied')).toEqual({
      label: 'Lightning Migrations Applied',
      ok: true,
      detail: '41 / 41',
    });
    expect(r.checks.find((c) => c.label === 'Open Alerts')).toMatchObject({
      ok: false,
      detail: '1',
    });
    expect(r.checks.find((c) => c.label === 'Worker')).toMatchObject({
      ok: false,
      detail: 'Shadow',
    });
    expect(r.checks.find((c) => c.label === 'Candidate m2')).toMatchObject({
      detail: 'Insufficient Evidence',
    });
    expect(parseReadiness(readinessAnswer('go'))!.reasons).toEqual([]);
    expect(parseReadiness({ ok: true, cluster_id: CLUSTER_A })).toBeNull();
  });
});

describe('the rules a control is sent under', () => {
  it('requires a reason of at least three characters', () => {
    expect(reasonIsValid('ok')).toBe(false);
    expect(reasonIsValid('   ab   ')).toBe(false);
    expect(reasonIsValid('why')).toBe(true);
  });

  it('confirms a destructive action by the Cluster name, case and spacing aside', () => {
    expect(confirmationPhrase('drain', 'NLH 1/2 Lightning')).toBe('NLH 1/2 Lightning');
    expect(confirmationPhrase('freeze', null)).toBe('FREEZE');
    expect(confirmationMatches('  nlh 1/2   lightning ', 'NLH 1/2 Lightning')).toBe(true);
    expect(confirmationMatches('NLH 1/2', 'NLH 1/2 Lightning')).toBe(false);
  });

  it('makes a fresh v4 request id, even without crypto.randomUUID', () => {
    const a = newRequestId();
    expect(a).toMatch(UUID_V4);
    expect(newRequestId()).not.toBe(a);
    const spy = vi.spyOn(globalThis.crypto, 'randomUUID').mockImplementation(undefined as any);
    (globalThis.crypto as any).randomUUID = undefined;
    try {
      expect(newRequestId()).toMatch(UUID_V4);
    } finally {
      spy.mockRestore();
    }
  });

  it('says every refusal in plain words', () => {
    for (const code of [
      'NOT_AUTHORIZED',
      'REASON_REQUIRED',
      'INVALID_ACTION',
      'INVALID_ARGS',
      'CLUSTER_NOT_FOUND',
      'CLUSTER_FROZEN',
      'CLUSTER_BUSY',
      'UNKNOWN_VERSION',
      'VERSION_DISABLED',
      'NOT_SQL_MATCHER',
      'FLAG_NOT_SUPPORTED',
      'ALREADY',
    ]) {
      expect(refusalWords(code), code).not.toMatch(/_/);
    }
    expect(refusalWords('SOMETHING_NEW')).toBe('Lightning Refused This Control: Something New.');
  });

  it('counts a drain deadline down, and never below zero', () => {
    const at = Date.parse('2026-10-09T14:01:10.000Z');
    expect(deadlineLabel('2026-10-09T14:01:10.000Z', at - 100_000)).toBe('1m 40s Left');
    expect(deadlineLabel('2026-10-09T14:01:10.000Z', at - 9_000)).toBe('9s Left');
    expect(deadlineLabel('2026-10-09T14:01:10.000Z', at + 5_000)).toBe('Passed');
  });
});

describe('a control, from the tap to the answer', () => {
  it('provides the supported shadow worker control through the audited door', async () => {
    detailDoors();
    renderDetail();
    await openControl('Shadow Worker');
    typeReason('Collect the staged calibration');
    fireEvent.click(confirmButton());
    await waitFor(() => expect(controlCalls()).toHaveLength(1));
    expect(controlCalls()[0][1]).toMatchObject({
      p_action: 'set_worker_mode',
      p_args: { mode: 'shadow' },
    });
  });
  it('keeps worker off unavailable until the cluster has returned to MUST MOVE', async () => {
    detailDoors();
    renderDetail();
    expect(await screen.findByRole('button', { name: 'Worker Off' })).toHaveProperty(
      'disabled',
      true
    );
  });

  it('asks for a reason, sends once with a fresh request id, and shows before and after', async () => {
    detailDoors();
    renderDetail();
    await openControl('Pause Cluster');
    expect(confirmButton()).toHaveProperty('disabled', true);
    typeReason('ab');
    expect(confirmButton()).toHaveProperty('disabled', true);
    typeReason('Investigating a stuck seat');
    expect(confirmButton()).toHaveProperty('disabled', false);
    const readsBefore = state.rpc.mock.calls.filter(
      (c) => c[0] === 'fn_lightning_operator_cluster'
    ).length;
    fireEvent.click(confirmButton());
    expect(await within(dialog()).findByText('→ Paused')).toBeTruthy();
    expect(controlCalls()).toHaveLength(1);
    const [, args] = controlCalls()[0];
    expect(args).toMatchObject({
      p_cluster_id: CLUSTER_A,
      p_action: 'pause',
      p_reason: 'Investigating a stuck seat',
    });
    expect(args.p_args.request_id).toMatch(UUID_V4);
    expect(state.toast.success).toHaveBeenCalledWith('Cluster Paused');
    expect(within(dialog()).getByText('#90417')).toBeTruthy();
    // The detail reads again so the page shows the new state.
    await waitFor(() =>
      expect(
        state.rpc.mock.calls.filter((c) => c[0] === 'fn_lightning_operator_cluster').length
      ).toBeGreaterThan(readsBefore)
    );
  });

  it('never double-submits: the button disables and a second tap sends nothing', async () => {
    let release: (v: unknown) => void = () => {};
    detailDoors(
      {},
      {
        fn_lightning_operator_control: (args) =>
          new Promise((resolve) => {
            release = () =>
              resolve({
                data: controlAnswer(
                  'disable_joins',
                  args.p_args.request_id,
                  controlCluster(),
                  controlCluster({ joins_enabled: false })
                ),
                error: null,
              });
          }),
      }
    );
    renderDetail();
    await openControl('Disable Joins');
    typeReason('Pool is too thin');
    fireEvent.click(confirmButton());
    fireEvent.click(confirmButton());
    fireEvent.click(confirmButton());
    expect(confirmButton().textContent).toBe('Sending');
    expect(confirmButton()).toHaveProperty('disabled', true);
    expect(controlCalls()).toHaveLength(1);
    await act(async () => release(null));
    expect(await within(dialog()).findByText('→ Closed')).toBeTruthy();
    expect(controlCalls()).toHaveLength(1);
  });

  it('asks for the Cluster name before a drain, and shows the drain on the page', async () => {
    detailDoors(
      {},
      {
        fn_lightning_operator_control: (args) => ({
          data: controlAnswer(
            'drain',
            args.p_args.request_id,
            controlCluster(),
            controlCluster({ cluster_mode: 'draining', joins_enabled: false, drain: drainState() })
          ),
          error: null,
        }),
      }
    );
    renderDetail();
    await openControl('Drain Lightning');
    typeReason('Emergency drain');
    expect(confirmButton()).toHaveProperty('disabled', true);
    expect(within(dialog()).getByText('Type NLH 1/2 Lightning To Confirm')).toBeTruthy();
    fireEvent.change(within(dialog()).getByPlaceholderText('NLH 1/2 Lightning'), {
      target: { value: 'nlh 1/2 lightning' },
    });
    expect(confirmButton()).toHaveProperty('disabled', false);
    fireEvent.click(confirmButton());
    expect(await within(dialog()).findByText('→ Draining')).toBeTruthy();
    expect(controlCalls()[0][1].p_action).toBe('drain');
    expect(state.toast.success).toHaveBeenCalledWith('Lightning Drain Started');
  });

  it('shows a refusal in plain words, and the next attempt carries a new request id', async () => {
    detailDoors({}, { fn_lightning_operator_control: ok(refusal('CLUSTER_BUSY')) });
    renderDetail();
    await openControl('Disable Joins');
    typeReason('Pool is too thin');
    fireEvent.click(confirmButton());
    expect(
      await within(dialog()).findByText(
        'A Conversion Or Drain Is In Progress. Try Again When It Finishes.'
      )
    ).toBeTruthy();
    expect(state.toast.error).toHaveBeenCalled();
    fireEvent.click(confirmButton());
    await waitFor(() => expect(controlCalls()).toHaveLength(2));
    expect(controlCalls()[1][1].p_args.request_id).not.toBe(controlCalls()[0][1].p_args.request_id);
  });

  it('retries a fault with the SAME request id, so the door cannot act twice', async () => {
    let n = 0;
    detailDoors(
      {},
      {
        fn_lightning_operator_control: (args) => {
          n += 1;
          if (n === 1) return { data: null, error: { code: '57014', message: 'timeout' } };
          return {
            data: controlAnswer(
              'pause',
              args.p_args.request_id,
              controlCluster(),
              controlCluster({ paused: true, cluster_mode: 'paused' }),
              true
            ),
            error: null,
          };
        },
      }
    );
    renderDetail();
    await openControl('Pause Cluster');
    typeReason('Investigating');
    fireEvent.click(confirmButton());
    expect(await within(dialog()).findByText(/Sending Again Is Safe/)).toBeTruthy();
    expect(confirmButton().textContent).toBe('Send Again');
    typeReason('A different decision');
    fireEvent.click(confirmButton());
    expect(
      await within(dialog()).findByText('This Request Was Already Answered. Nothing Changed Twice.')
    ).toBeTruthy();
    expect(controlCalls()[1][1].p_args.request_id).toBe(controlCalls()[0][1].p_args.request_id);
    expect(controlCalls()[1][1]).toEqual(controlCalls()[0][1]);
    expect(state.toast.info).toHaveBeenCalled();
  });

  it('says plainly when the Cluster was already in the asked-for state', async () => {
    detailDoors(
      {},
      {
        fn_lightning_operator_control: (args) => ({
          data: alreadyAnswer(
            args.p_action,
            args.p_args.request_id,
            controlCluster({ joins_enabled: false })
          ),
          error: null,
        }),
      }
    );
    renderDetail();
    await openControl('Disable Joins');
    typeReason('Pool is too thin');
    fireEvent.click(confirmButton());
    expect(
      await within(dialog()).findByText('The Cluster Is Already In That State. Nothing Changed.')
    ).toBeTruthy();
    expect(state.toast.info).toHaveBeenCalledWith('Already In That State. Nothing Changed');
    expect(state.toast.success).not.toHaveBeenCalled();
  });

  it('says Not Available Yet when the door is missing, and restricted on NOT_AUTHORIZED', async () => {
    detailDoors(
      {},
      {
        fn_lightning_operator_control: () => ({ data: null, error: { ...MISSING_FUNCTION_ERROR } }),
      }
    );
    const first = renderDetail();
    await openControl('Pause Cluster');
    typeReason('Investigating');
    fireEvent.click(confirmButton());
    expect(await within(dialog()).findByText(/Not Available Yet/)).toBeTruthy();
    first.unmount();

    detailDoors({}, { fn_lightning_operator_control: ok(NOT_AUTHORIZED_ANSWER) });
    renderDetail();
    await openControl('Pause Cluster');
    typeReason('Investigating');
    fireEvent.click(confirmButton());
    expect(
      await within(dialog()).findByText(/Operator Controls Are Available To Club Owners/)
    ).toBeTruthy();
  });

  it('points a matcher change at a version and a flag change at its flag', async () => {
    detailDoors();
    renderDetail();
    await openControl('Set Version');
    fireEvent.click(within(dialog()).getByRole('button', { name: 'm2' }));
    typeReason('Promote the candidate');
    fireEvent.click(confirmButton());
    await waitFor(() => expect(controlCalls()).toHaveLength(1));
    expect(controlCalls()[0][1]).toMatchObject({
      p_action: 'set_matcher_version',
      p_args: { version: 'm2', role: 'live' },
    });
    // The recorded request precedes its answer; close only the acknowledged dialog.
    fireEvent.click(await within(dialog()).findByText('Close', { exact: true }));

    const autoRebuy = document.querySelector('[data-flag="lightning_auto_rebuy"]') as HTMLElement;
    fireEvent.click(within(autoRebuy).getByRole('button', { name: 'Turn On' }));
    typeReason('Pilot auto rebuy');
    fireEvent.click(confirmButton());
    await waitFor(() => expect(controlCalls()).toHaveLength(2));
    expect(controlCalls()[1][1]).toMatchObject({
      p_action: 'set_flag',
      p_args: { flag: 'lightning_auto_rebuy', value: true },
    });
  });

  it('sets the candidate the engine compares with, from the versions that would change it', async () => {
    detailDoors();
    renderDetail();
    await openControl('Set Version');
    const picker = () => within(dialog()).getByRole('group', { name: 'Matcher Version' });
    expect(
      within(picker())
        .getAllByRole('button')
        .map((b) => b.textContent)
    ).toEqual(['m1-port', 'm2']);
    fireEvent.click(within(dialog()).getByRole('button', { name: 'Candidate' }));
    expect(
      within(picker())
        .getAllByRole('button')
        .map((b) => b.textContent)
    ).toEqual(['m1', 'm1-port']);
    fireEvent.click(within(picker()).getByRole('button', { name: 'm1-port' }));
    typeReason('Calibrate the port');
    fireEvent.click(confirmButton());
    await waitFor(() => expect(controlCalls()).toHaveLength(1));
    expect(controlCalls()[0][1].p_args).toMatchObject({ version: 'm1-port', role: 'shadow' });
  });

  it('closes on Escape, and not while a control is in flight', async () => {
    let release: (v: unknown) => void = () => {};
    detailDoors(
      {},
      {
        fn_lightning_operator_control: () =>
          new Promise((resolve) => {
            release = resolve;
          }),
      }
    );
    renderDetail();
    await openControl('Pause Cluster');
    typeReason('Investigating');
    fireEvent.click(confirmButton());
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).not.toBeNull();
    await act(async () => release({ data: refusal('ALREADY'), error: null }));
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});

describe('the Cluster detail', () => {
  it('waits on everything but Unfreeze while frozen, and says who may unfreeze', async () => {
    const frozen = {
      cluster_mode: 'frozen',
      frozen: {
        at: '2026-10-09T12:02:00.000Z',
        reason: 'LIGHTNING_FORMATION_MOVED_MONEY',
        invariant: null,
      },
    };
    doors({
      fn_lightning_operator_cluster: ok(clusterAnswer13(frozen)),
      fn_lightning_rollout_readiness: ok(readinessAnswer('no_go')),
      fn_lightning_operator_control: ok(NOT_AUTHORIZED_ANSWER),
    });
    renderDetail();
    expect(await screen.findByRole('button', { name: 'Unfreeze Cluster' })).toHaveProperty(
      'disabled',
      false
    );
    for (const name of ['Pause Cluster', 'Disable Joins', 'Drain Lightning', 'Disable Lightning']) {
      expect(screen.getByRole('button', { name })).toHaveProperty('disabled', true);
    }
    expect(screen.queryByRole('button', { name: 'Freeze Cluster' })).toBeNull();
    await openControl('Unfreeze Cluster');
    typeReason('Evidence reviewed');
    fireEvent.click(confirmButton());
    expect(
      await within(dialog()).findByText('Only A Platform Administrator Can Unfreeze A Cluster.')
    ).toBeTruthy();
    expect(controlCalls()[0][1].p_action).toBe('unfreeze');
  });

  it('replays the operator actions and drain steps among the mode transitions', async () => {
    doors({
      fn_lightning_operator_cluster: ok({
        ...clusterAnswer13(),
        transitions: operatorTransitions(),
      }),
      fn_lightning_rollout_readiness: ok(readinessAnswer('no_go')),
    });
    renderDetail();
    expect(await screen.findByText('Operator: Drain Lightning')).toBeTruthy();
    expect(screen.getByText('Drain Step 3: Let Active Hands Finish')).toBeTruthy();
  });

  it('offers a switch only for the flags a Cluster can switch', async () => {
    detailDoors();
    renderDetail();
    await screen.findByText('Feature Flags');
    const row = (flag: string) => document.querySelector(`[data-flag="${flag}"]`) as HTMLElement;
    for (const flag of [
      'lightning_fast_fold',
      'lightning_fold_watch',
      'lightning_multi_table',
      'lightning_shadow_matcher',
      'lightning_auto_rebuy',
    ]) {
      expect(within(row(flag)).getByRole('button'), flag).toBeTruthy();
    }
    for (const flag of [
      'lightning_pool_health',
      'lightning_repeat_suppression',
      'lightning_session_stats',
      'lightning_adaptive_liquidity',
    ]) {
      expect(within(row(flag)).queryByRole('button'), flag).toBeNull();
      expect(within(row(flag)).getByText('Always On')).toBeTruthy();
    }
  });

  it('shows the drain live, and reads on its named engine event', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    doors({
      fn_lightning_operator_cluster: ok(
        clusterAnswer13({ cluster_mode: 'draining', joins_enabled: false, drain: drainState() })
      ),
      fn_lightning_rollout_readiness: ok(readinessAnswer('no_go')),
    });
    renderDetail();
    expect(await screen.findByText('Drain Progress')).toBeTruthy();
    expect(screen.getByText('Finishing Hands')).toBeTruthy();
    expect(screen.getByText('Drained From')).toBeTruthy();
    expect(screen.getByText('Emergency Drain For The 22:00 Maintenance')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Drain In Progress' })).toHaveProperty(
      'disabled',
      true
    );
    const reads = () =>
      state.rpc.mock.calls.filter((c) => c[0] === 'fn_lightning_operator_cluster').length;
    // The faster loop starts once the drain has been read: within a few 5 s
    // ticks there are reads that the 30 s loop would never have made.
    const first = reads();
    for (let i = 0; i < 4 && reads() <= first + 1; i += 1) {
      await act(async () => {
        state.changed?.();
      });
      await act(async () => {
        await Promise.resolve();
      });
    }
    expect(reads()).toBeGreaterThan(first + 1);
  });

  it('prints the readiness verdict and every reason', async () => {
    detailDoors();
    renderDetail();
    expect(await screen.findByText('No Go')).toBeTruthy();
    const reasons = screen.getByRole('list', { name: 'Readiness Reasons' });
    expect(within(reasons).getAllByRole('listitem')).toHaveLength(4);
    expect(within(reasons).getByText('Lightning Alerts Are Open: 1')).toBeTruthy();
    expect(within(reasons).getAllByText('Blocking')).toHaveLength(2);
    expect(within(reasons).getAllByText('Evidence')).toHaveLength(2);
    expect(screen.getByText('Lightning Migrations Applied, 41 / 41')).toBeTruthy();
  });

  it('says the readiness door is not available yet when the database lacks it', async () => {
    doors({ fn_lightning_operator_cluster: ok(clusterAnswer13()) });
    renderDetail();
    await screen.findByText('Rollout Readiness');
    expect(await screen.findByText(/Not Available Yet/)).toBeTruthy();
  });
});

describe('the overview', () => {
  it('says what an operator has done to each Cluster', () => {
    const [a, b] = parseOverview(overviewAnswer13())!.clusters;
    expect(clusterNotices(a)).toEqual(['Draining: Finishing Hands', 'Lightning Joins Disabled']);
    expect(clusterNotices(b)).toEqual(['Paused By An Operator']);
  });
});

describe('laws', () => {
  it('names each door literally, so the phantom RPC gate sees it', () => {
    const api = SOURCES[0].text;
    expect(api).toContain("client.rpc('fn_lightning_operator_control'");
    expect(api).toContain("client.rpc('fn_lightning_rollout_readiness'");
  });

  it('never prints a rival product name, a horse marker, a card field or an em dash', () => {
    for (const { path, text } of SOURCES) {
      expect(text, path).not.toMatch(/\b(Zoom|Rush|Snap|Fast Forward)\b/);
      expect(text, path).not.toMatch(/is_horse|isHorse|horse_id/);
      expect(text, path).not.toMatch(/hole_cards|holeCards|board_cards|\bdeck\b/);
      expect(text, path).not.toContain('—');
    }
  });

  it('never navigates a player, and stays out of the entry chunk', () => {
    for (const { path, text } of SOURCES) {
      expect(text, path).not.toMatch(/useNavigate|window\.location|location\.assign/);
    }
    const app = readFileSync('src/App.tsx', 'utf8');
    expect(app).not.toMatch(/LightningOperatorControls|lightningOperatorControls/);
  });
});

describe('calibration and integrity setup controls', () => {
  const setup = {
    cluster_mode: 'must_move',
    worker_mode: 'off',
    drain: null,
    shadow_window_ms: 300000,
    flags: { integrity_telemetry: false },
  };

  it('accepts integer millisecond boundaries and refuses invalid windows', () => {
    expect(shadowWindowMilliseconds('60000')).toBe(60000);
    expect(shadowWindowMilliseconds('3600000')).toBe(3600000);
    for (const value of ['', '59999', '3600001', '60000.5', '-60000', '1e5', 'Infinity']) {
      expect(shadowWindowMilliseconds(value)).toBeNull();
    }
    expect(shadowWindowLabel(60000)).toBe('1 Minute');
    expect(shadowWindowLabel(61000)).toBe('61 Seconds');
    expect(shadowWindowMilliseconds('60001')).toBe(60001);
    expect(shadowWindowLabel(60001)).toBe('60 Seconds, 1 Millisecond');
  });

  it('sends the exact millisecond value and reads persisted before/after', async () => {
    detailDoors(setup, {
      fn_lightning_operator_control: (args) => ({
        data: {
          ...controlAnswer(
            args.p_action,
            args.p_args.request_id,
            controlCluster(),
            controlCluster()
          ),
          before: { ...stateOf(controlCluster()), shadow_window_ms: 300000 },
          after: { ...stateOf(controlCluster()), shadow_window_ms: 60000 },
        },
        error: null,
      }),
    });
    renderDetail();
    await openControl('Set Calibration Window');
    const input = within(dialog()).getByRole('textbox', { name: /Window In Milliseconds/ });
    typeReason('Prepare Calibration');
    fireEvent.change(input, { target: { value: '59999' } });
    expect(confirmButton()).toBeDisabled();
    fireEvent.change(input, { target: { value: '60000' } });
    fireEvent.click(confirmButton());
    await waitFor(() => expect(controlCalls()).toHaveLength(1));
    expect(controlCalls()[0][1].p_action).toBe('set_shadow_window');
    expect(controlCalls()[0][1].p_args.shadow_window_ms).toBe(60000);
    expect(await within(dialog()).findByText('→ 1 Minute')).toBeInTheDocument();
  });

  it('sends a boolean integrity decision with the reason and a fresh request', async () => {
    detailDoors(setup, {
      fn_lightning_operator_control: (args) => ({
        data: {
          ...controlAnswer(
            args.p_action,
            args.p_args.request_id,
            controlCluster(),
            controlCluster()
          ),
          before: { ...stateOf(controlCluster()), integrity_telemetry: false },
          after: { ...stateOf(controlCluster()), integrity_telemetry: true },
        },
        error: null,
      }),
    });
    renderDetail();
    await openControl('Enable Integrity Telemetry');
    typeReason('Record Integrity Signals');
    fireEvent.click(confirmButton());
    await waitFor(() => expect(controlCalls()).toHaveLength(1));
    expect(controlCalls()[0][1]).toMatchObject({
      p_action: 'set_integrity_telemetry',
      p_reason: 'Record Integrity Signals',
      p_args: { value: true },
    });
    expect(controlCalls()[0][1].p_args.request_id).toMatch(UUID_V4);
    expect(await within(dialog()).findByText('→ On')).toBeInTheDocument();
  });

  it('keeps unreported setup values unknown and unavailable', async () => {
    detailDoors({ ...setup, shadow_window_ms: undefined, flags: {} });
    renderDetail();
    expect(await screen.findByRole('button', { name: 'Set Calibration Window' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Enable Integrity Telemetry' })).toBeDisabled();
    expect(controlCalls()).toHaveLength(0);
    expect(screen.getByText(/An Unreported Setup Value Cannot Be Changed/)).toBeInTheDocument();
  });

  it('locks and reuses the complete calibration decision after an unknown answer', async () => {
    let attempt = 0;
    detailDoors(setup, {
      fn_lightning_operator_control: (args) => {
        attempt += 1;
        return attempt === 1
          ? { data: null, error: { message: 'Transport Lost' } }
          : {
              data: {
                ...controlAnswer(
                  args.p_action,
                  args.p_args.request_id,
                  controlCluster(),
                  controlCluster(),
                  true
                ),
                before: { ...stateOf(controlCluster()), shadow_window_ms: 300000 },
                after: { ...stateOf(controlCluster()), shadow_window_ms: 60000 },
              },
              error: null,
            };
      },
    });
    renderDetail();
    await openControl('Set Calibration Window');
    fireEvent.change(within(dialog()).getByRole('textbox', { name: /Window In Milliseconds/ }), {
      target: { value: '60000' },
    });
    typeReason('Prepare Calibration');
    fireEvent.click(confirmButton());
    await within(dialog()).findByRole('button', { name: 'Send Again' });
    expect(
      within(dialog()).getByRole('textbox', { name: /Window In Milliseconds/ })
    ).toBeDisabled();
    fireEvent.click(confirmButton());
    await waitFor(() => expect(controlCalls()).toHaveLength(2));
    expect(controlCalls()[1][1]).toEqual(controlCalls()[0][1]);
    expect(await within(dialog()).findByText('→ 1 Minute')).toBeInTheDocument();
  });

  it('keeps setup unavailable while the worker runs and reports why', async () => {
    detailDoors({ ...setup, worker_mode: 'shadow' });
    renderDetail();
    expect(await screen.findByRole('button', { name: 'Set Calibration Window' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Enable Integrity Telemetry' })).toBeDisabled();
    expect(screen.getByText(/Setup Changes Require Must Move/)).toBeInTheDocument();
  });
});

describe('operator receipt ownership', () => {
  it.each([
    'missing',
    'wrong_action',
    'wrong_cluster',
    'wrong_request',
    'missing_state',
    'missing_event',
    'in_progress',
  ])('keeps %s acknowledgment unknown and retries the original decision', async (fault) => {
    let attempt = 0;
    detailDoors(
      {},
      {
        fn_lightning_operator_control: (args) => {
          attempt += 1;
          const receipt = controlAnswer(
            args.p_action,
            args.p_args.request_id,
            controlCluster(),
            controlCluster({ paused: true })
          );
          if (attempt === 1) {
            if (fault === 'in_progress')
              return {
                data: { ok: false, code: 'REQUEST_IN_PROGRESS', reason: 'retry_same_request_id' },
                error: null,
              };
            if (fault === 'missing') return { data: { ok: true }, error: null };
            if (fault === 'wrong_action') receipt.action = 'resume';
            if (fault === 'wrong_cluster')
              receipt.cluster_id = '99999999-9999-4999-8999-999999999999';
            if (fault === 'wrong_request')
              receipt.request_id = '99999999-9999-4999-8999-999999999999';
            if (fault === 'missing_state') receipt.after = null as any;
            if (fault === 'missing_event') receipt.event_id = null as any;
          }
          return { data: receipt, error: null };
        },
      }
    );
    renderDetail();
    await openControl('Pause Cluster');
    typeReason('Review Receipt');
    fireEvent.click(confirmButton());
    await within(dialog()).findByRole('button', { name: 'Send Again' });
    expect(state.toast.success).not.toHaveBeenCalled();
    expect(within(dialog()).queryByLabelText('Before And After')).not.toBeInTheDocument();
    fireEvent.click(confirmButton());
    await waitFor(() => expect(controlCalls()).toHaveLength(2));
    expect(controlCalls()[1][1]).toEqual(controlCalls()[0][1]);
    await within(dialog()).findByLabelText('Before And After');
    expect(state.toast.success).toHaveBeenCalledTimes(1);
  });
});

describe('setup receipt values', () => {
  it('rejects missing or malformed persisted calibration and integrity values', () => {
    const receipt = controlAnswer(
      'set_shadow_window',
      'f1f1f1f1-f1f1-41f1-81f1-f1f1f1f1f1f1',
      controlCluster(),
      controlCluster()
    );
    const before = { ...receipt.before, shadow_window_ms: 60000 };
    for (const value of [undefined, null, [], [60000], '60000', 59999, 3600001, 60000.5]) {
      expect(
        parseControlResult({
          ...receipt,
          before,
          after: { ...receipt.after, shadow_window_ms: value },
        })
      ).toBeNull();
    }
    for (const value of [undefined, null, 'true', 1]) {
      expect(
        parseControlResult({
          ...receipt,
          action: 'set_integrity_telemetry',
          before: { ...receipt.before, integrity_telemetry: false },
          after: { ...receipt.after, integrity_telemetry: value },
        })
      ).toBeNull();
    }
  });
});

describe('setup acknowledgment matches the desired setting', () => {
  it.each(['window', 'integrity'])(
    'keeps a mismatched %s setting unknown and retries once',
    async (kind) => {
      let attempt = 0;
      const isWindow = kind === 'window';
      detailDoors(
        {
          cluster_mode: 'must_move',
          worker_mode: 'off',
          drain: null,
          shadow_window_ms: 300000,
          flags: { integrity_telemetry: false },
        },
        {
          fn_lightning_operator_control: (args) => {
            attempt += 1;
            const receipt = controlAnswer(
              args.p_action,
              args.p_args.request_id,
              controlCluster(),
              controlCluster()
            );
            return {
              data: {
                ...receipt,
                before: { ...receipt.before, shadow_window_ms: 300000, integrity_telemetry: false },
                after: {
                  ...receipt.after,
                  shadow_window_ms: attempt === 1 ? 120000 : 60000,
                  integrity_telemetry: attempt !== 1,
                },
              },
              error: null,
            };
          },
        }
      );
      renderDetail();
      await openControl(isWindow ? 'Set Calibration Window' : 'Enable Integrity Telemetry');
      if (isWindow)
        fireEvent.change(
          within(dialog()).getByRole('textbox', { name: /Window In Milliseconds/ }),
          { target: { value: '60000' } }
        );
      typeReason('Match The Desired Setting');
      fireEvent.click(confirmButton());
      await within(dialog()).findByRole('button', { name: 'Send Again' });
      expect(state.toast.success).not.toHaveBeenCalled();
      fireEvent.click(confirmButton());
      await waitFor(() => expect(controlCalls()).toHaveLength(2));
      expect(controlCalls()[1][1]).toEqual(controlCalls()[0][1]);
      await within(dialog()).findByLabelText('Before And After');
      expect(state.toast.success).toHaveBeenCalledTimes(1);
    }
  );

  it('accepts complete setup ALREADY receipts without an audit event', () => {
    const receipt = alreadyAnswer(
      'set_shadow_window',
      'f1f1f1f1-f1f1-41f1-81f1-f1f1f1f1f1f1',
      controlCluster()
    );
    const state = { ...receipt.before, shadow_window_ms: 60000, integrity_telemetry: true };
    for (const action of ['set_shadow_window', 'set_integrity_telemetry']) {
      expect(parseControlResult({ ...receipt, action, before: state, after: state })).toMatchObject(
        { already: true, eventId: null }
      );
    }
  });
});

describe('receipt outcome consistency', () => {
  it('rejects contradictory or mistyped ALREADY and replay outcomes', () => {
    const receipt = alreadyAnswer(
      'pause',
      'f1f1f1f1-f1f1-41f1-81f1-f1f1f1f1f1f1',
      controlCluster()
    );
    for (const change of [
      { idempotent: false },
      { event_id: 'bad' },
      { event_id: 90417 },
      { event_id: undefined },
      { already: 'true' },
      { already: 1 },
      { replayed: 'true' },
      { replayed: 1 },
      { replayed: null },
    ]) {
      expect(parseControlResult({ ...receipt, ...change })).toBeNull();
    }
    expect(parseControlResult(receipt)).toMatchObject({
      already: true,
      idempotent: true,
      eventId: null,
    });
    expect(
      parseControlResult(
        controlAnswer('pause', receipt.request_id, controlCluster(), controlCluster(), true)
      )
    ).toMatchObject({ replayed: true, idempotent: true, eventId: '90417' });
  });
});

describe('ALREADY state consistency', () => {
  it('refuses changed state in an ALREADY receipt but accepts reordered identical state', () => {
    const receipt = alreadyAnswer(
      'pause',
      'f1f1f1f1-f1f1-41f1-81f1-f1f1f1f1f1f1',
      controlCluster()
    );
    expect(
      parseControlResult({ ...receipt, after: { ...receipt.after, paused: !receipt.after.paused } })
    ).toBeNull();
    const reordered = Object.fromEntries(Object.entries(receipt.after).reverse());
    expect(parseControlResult({ ...receipt, after: reordered })).toMatchObject({
      already: true,
      eventId: null,
    });
  });
});
