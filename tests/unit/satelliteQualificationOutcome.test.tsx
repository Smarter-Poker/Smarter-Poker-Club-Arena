import React from 'react';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import ts from 'typescript';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import TournamentRankingHost from '../../src/components/tournament/TournamentRankingHost';
import { tournamentService } from '../../src/services/TournamentService';
import {
  parseSatelliteQualificationEvent,
  qualificationCashPrize,
} from '../../src/services/satelliteQualification';
import {
  clearSessionSummary,
  peekSessionSummary,
  publishSessionSummary,
} from '../../src/services/pendingSessionSummary';
import { awaitTournamentResultEnrichment } from '../../src/utils/tournamentResultEnrichment';

const transport = vi.hoisted(() => ({ rpc: vi.fn(), from: vi.fn() }));
vi.mock('../../src/lib/supabase', () => ({ supabase: transport, getAuthUser: vi.fn() }));
vi.mock('../../src/lib/authUtils', () => ({ readLocalSession: () => ({ userId: 'hero' }) }));

const receipt = (delivery = 'seat') => ({
  tournament_id: 'satellite',
  user_id: 'hero',
  completion_kind: 'equal_qualifiers',
  target_id: 'target',
  amount: 125.5,
  delivery_kind: delivery,
  qualified_at: '2026-09-10T05:00:00Z',
  registration_id: 'target-entry',
  ticket_id: null,
});
const event = (patch = {}) => ({
  type: 'tournament_qualified',
  payload: {
    tournamentId: 'satellite',
    userId: 'hero',
    targetId: 'target',
    prize: 125.5,
    deliveryKind: 'seat',
    completionKind: 'equal_qualifiers',
    ...patch,
  },
});

// Execute the actual TablePage declarations and its registered broadcast callback.
// Only their external dependencies are supplied: this is not a rewritten exit.
const text = readFileSync(resolve(__dirname, '../../src/pages/TablePage.tsx'), 'utf8');
const source = ts.createSourceFile(
  'TablePage.tsx',
  text,
  ts.ScriptTarget.Latest,
  true,
  ts.ScriptKind.TSX
);
const nodes: ts.Node[] = [];
function visit(node: ts.Node) {
  nodes.push(node);
  ts.forEachChild(node, visit);
}
visit(source);
function functionSource(name: string) {
  const node = nodes.find((n) => ts.isFunctionDeclaration(n) && n.name?.text === name);
  if (!node) throw new Error(`Missing TablePage function: ${name}`);
  return node.getText(source);
}
const exitNode = nodes.find(
  (n) => ts.isVariableDeclaration(n) && n.name.getText(source) === 'goToLobbyWithResult'
);
const callback =
  nodes.find(
    (n) =>
      ts.isArrowFunction(n) &&
      ts.isCallExpression(n.parent) &&
      n.parent.expression.getText(source) === 'breakChan.on' &&
      n.getText(source).includes('parseSatelliteQualificationEvent')
  ) ??
  nodes.find(
    (n) =>
      ts.isArrowFunction(n) &&
      ts.isCallExpression(n.parent) &&
      n.parent.arguments[0]?.getText(source) === "'broadcast'" &&
      n.getText(source).includes('parseSatelliteQualificationEvent')
  );
if (!exitNode || !callback) throw new Error('Missing actual terminal exit or broadcast callback');
const authCallback = nodes.find(
  (n) =>
    ts.isArrowFunction(n) &&
    ts.isCallExpression(n.parent) &&
    n.parent.expression.getText(source) === 'useMasterBusSubscription' &&
    n.parent.arguments[0]?.getText(source) === "'AUTH_STATE_CHANGED'"
);
if (!authCallback) throw new Error('Missing actual terminal auth subscription');

function buildHarness({ embedded = false } = {}) {
  const ref = (current: unknown) => ({ current });
  const emit = vi.fn();
  const navigate = vi.fn();
  const winner = vi.fn();
  const report = vi.fn();
  const state = { tableName: 'Satellite', heroSeat: 1, players: [{}], arenaAsset: 'chips' };
  const exitTimer = ref(null);
  const deps: Record<string, unknown> = {
    tournamentService,
    parseSatelliteQualificationEvent,
    qualificationCashPrize,
    awaitTournamentResultEnrichment,
    publishSessionSummary,
    supabase: transport,
    userId: 'hero',
    terminalAuthScopeRef: ref(null),
    tableId: 'table',
    durableTournamentId: 'satellite',
    durableTournamentName: 'Satellite',
    table: { tournament_id: 'satellite' },
    tableState: state,
    tableStateRef: ref(state),
    tournamentExitTimerRef: exitTimer,
    sessionStartRef: ref(Date.now()),
    handsPlayedRef: ref(3),
    handsWonRef: ref(1),
    totalRebuysRef: ref(0),
    biggestPotRef: ref(0),
    peakStackRef: ref(0),
    vpipCountRef: ref(0),
    totalBuyInRef: ref(10),
    heroSeatRef: ref(1),
    setTableState: vi.fn(),
    masterBus: { emit },
    playerStatusService: { clearPlayingAt: vi.fn() },
    embeddedTableId: embedded ? 'table' : undefined,
    lobbyClubIdRef: ref('club'),
    navigate,
    setTournamentWinner: winner,
    reportError: report,
    formatGameTitle: (v: string) => v,
    relayTournamentEvent: vi.fn(),
    isSpinTournament: () => false,
  };
  const body = `let isMounted = true;
    let exitStarted = false;
    let durableCompletionLookupInFlight = false;
    let durableCompletionHandled = false;
    let durableCompletionRetryTimer = null;
    let durableCompletionRetryCycle = 0;
    let durableCompletionFailureReported = false;
    ${functionSource('fetchTournamentResult')}
    const ${exitNode.getText(source)};
    ${functionSource('scheduleDurableCompletionRetry')}
    ${functionSource('isCurrentTerminalResult')}
    ${functionSource('exitFromSatelliteQualification')}
    ${functionSource('exitFromDurableCompletion')}
    ${functionSource('verifyDurableCompletion')}
    const receive = ${callback.getText(source)};
    const receiveAuth = ${authCallback.getText(source)};
    return { receive, reload: exitFromDurableCompletion, verify: verifyDurableCompletion, enrich: fetchTournamentResult,
      leave: goToLobbyWithResult,
      authChanged(userId) { receiveAuth({ userId, isAuthenticated: userId !== null }); },
      dispose() { isMounted = false; clearTimeout(tournamentExitTimerRef.current); clearTimeout(durableCompletionRetryTimer); }
    };`;
  const js = ts.transpile(body, { target: ts.ScriptTarget.ES2022 });
  const harness = new Function(...Object.keys(deps), js)(...Object.values(deps));
  return { ...harness, emit, navigate, winner, report };
}
function Location() {
  return <output aria-label="Route">{useLocation().pathname}</output>;
}
function renderHost() {
  return render(
    <MemoryRouter initialEntries={['/clubs/club']}>
      <TournamentRankingHost />
      <Location />
    </MemoryRouter>
  );
}
let row: Record<string, unknown>;
const harnesses: ReturnType<typeof buildHarness>[] = [];
function table(options = {}) {
  const h = buildHarness(options);
  harnesses.push(h);
  return h;
}

beforeEach(() => {
  vi.useFakeTimers();
  clearSessionSummary();
  row = { status: 'winner', position: null, prize: 125.5 };
  transport.rpc.mockReset().mockResolvedValue({ data: receipt(), error: null });
  transport.from.mockReset().mockImplementation((name) => {
    const query: any = {
      select: () => query,
      eq: () => query,
      maybeSingle: async () => ({
        data:
          name === 'tournament_players'
            ? row
            : name === 'tournaments'
              ? { status: 'COMPLETED', name: 'Satellite' }
              : null,
        error: null,
      }),
      then: (resolve: (v: unknown) => unknown) =>
        Promise.resolve({ data: [], count: 8, error: null }).then(resolve),
    };
    return query;
  });
});
afterEach(async () => {
  for (const h of harnesses.splice(0)) h.dispose();
  cleanup();
  clearSessionSummary();
  vi.clearAllTimers();
  vi.useRealTimers();
});
async function settle() {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1);
  });
}

describe('Equal satellite qualification live and reload delivery', () => {
  it.each(['seat', 'ticket', 'cash'])(
    'renders the real live %s delivery through the app-root host without a place',
    async (deliveryKind) => {
      const h = table();
      renderHost();
      await act(async () => h.receive({ payload: event({ deliveryKind }) }));
      await settle();
      expect(screen.getByRole('dialog', { name: 'Qualified' })).toBeTruthy();
      expect(screen.getByText('Target Entry Value')).toBeTruthy();
      expect(screen.queryByText('1st')).toBeNull();
      expect(screen.queryByText('Total Payout:')).toBeNull();
      expect(screen.queryByText('Player Wallet Credit') !== null).toBe(deliveryKind === 'cash');
      expect(peekSessionSummary()?.tournament?.prize).toBe(deliveryKind === 'cash' ? 125.5 : 0);
      expect(peekSessionSummary()?.tournament?.finishPlace).toBeNull();
      expect(h.winner).not.toHaveBeenCalled();
      expect(h.emit.mock.calls.map((c: unknown[]) => c[0])).toEqual([
        'SESSION_ENDED',
        'TABLE_LEFT',
        'TABLE_MENU_ACTION',
      ]);
      expect(h.navigate).toHaveBeenCalledWith('/clubs/club');
      expect(transport.from).not.toHaveBeenCalled(); // rank backfill cannot invent one
      expect(transport.rpc).not.toHaveBeenCalled(); // committed event needs no optional read
    }
  );

  it('recovers from the committed actor-scoped RPC when the broadcast was lost', async () => {
    const h = table();
    renderHost();
    await act(async () => h.reload());
    await settle();
    expect(transport.rpc).toHaveBeenCalledWith('fn_get_my_satellite_qualification', {
      p_tournament_id: 'satellite',
    });
    expect(screen.getByRole('dialog', { name: 'Qualified' })).toBeTruthy();
    expect(screen.getByText('Seat Registered')).toBeTruthy();
    expect(h.navigate).toHaveBeenCalledTimes(1);
  });

  it('replayed broadcasts and a late durable read produce one close and one card', async () => {
    const h = table();
    renderHost();
    let resolveRead!: (value: unknown) => void;
    transport.rpc.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveRead = resolve;
        })
    );
    let lookup: Promise<void>;
    await act(async () => {
      lookup = h.reload();
      await Promise.resolve();
    });
    await act(async () => {
      h.receive({ payload: event() });
      h.receive({ payload: event() });
      resolveRead({ data: receipt(), error: null });
      await lookup;
    });
    await settle();
    expect(h.navigate).toHaveBeenCalledTimes(1);
    expect(screen.getAllByRole('dialog')).toHaveLength(1);
    await act(async () =>
      fireEvent.click(screen.getByRole('button', { name: 'Close Qualification Result' }))
    );
    expect(peekSessionSummary()).toBeNull();
  });

  it.each([
    { userId: 'other' },
    { tournamentId: 'previous' },
    { completionKind: 'single_winner' },
    { deliveryKind: 'unknown' },
    { deliveryKind: { toString: 'cash' } },
    { prize: -1 },
    { prize: 0 },
    { prize: 1.234 },
    { prize: '125.50' },
    { targetId: '' },
  ])('ignores invalid or foreign live payload %j', async (patch) => {
    const h = table();
    h.receive({ payload: event(patch) });
    await settle();
    expect(peekSessionSummary()).toBeNull();
    expect(h.emit).not.toHaveBeenCalled();
  });

  it('does not close another table from a stale callback or delayed receipt after teardown', async () => {
    const h = table();
    let resolveRead!: (value: unknown) => void;
    transport.rpc.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveRead = resolve;
        })
    );
    const lookup = h.reload();
    await vi.advanceTimersByTimeAsync(0);
    expect(transport.rpc).toHaveBeenCalledTimes(1);
    h.dispose();
    h.receive({ payload: event() });
    resolveRead({ data: receipt(), error: null });
    await lookup;
    await settle();
    expect(peekSessionSummary()).toBeNull();
    expect(h.emit).not.toHaveBeenCalled();
  });

  it('discards a qualification read across same-account auth replacement and recovers freshly', async () => {
    const h = table();
    let resolveRead!: (value: unknown) => void;
    transport.rpc.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveRead = resolve;
        })
    );
    const lookup = h.reload();
    await vi.advanceTimersByTimeAsync(0);
    h.authChanged('hero');
    resolveRead({ data: receipt('seat'), error: null });
    await lookup;
    await settle();
    expect(h.emit).not.toHaveBeenCalled();
    expect(peekSessionSummary()).toBeNull();
    transport.rpc.mockResolvedValue({ data: receipt('cash'), error: null });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1001);
    });
    expect(peekSessionSummary()?.tournament?.qualification?.deliveryKind).toBe('cash');
    expect(h.navigate).toHaveBeenCalledTimes(1);
  });

  it('does not publish or close for an account that changed while the receipt was pending', async () => {
    const h = table();
    let resolveRead!: (value: unknown) => void;
    transport.rpc.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveRead = resolve;
        })
    );
    const lookup = h.reload();
    await vi.advanceTimersByTimeAsync(0);
    h.authChanged('other');
    resolveRead({ data: receipt(), error: null });
    await lookup;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30001);
    });
    expect(h.emit).not.toHaveBeenCalled();
    expect(h.navigate).not.toHaveBeenCalled();
    expect(peekSessionSummary()).toBeNull();
  });

  it.each(['hero', 'other', null])(
    'invalidates a queued qualification exit on auth event %s',
    async (nextUser) => {
      const h = table({ embedded: true });
      h.receive({ payload: event() });
      h.authChanged(nextUser);
      await settle();
      expect(h.emit).not.toHaveBeenCalled();
      expect(h.navigate).not.toHaveBeenCalled();
      expect(peekSessionSummary()).toBeNull();
      if (nextUser === 'hero') {
        await act(async () => {
          await vi.advanceTimersByTimeAsync(1001);
        });
        expect(h.emit).toHaveBeenCalledWith('TABLE_LEFT', { tableId: 'table', seat: 1 });
        expect(h.navigate).not.toHaveBeenCalled();
      }
    }
  );

  it('cancels an exit already awaiting optional enrichment when the table is torn down', async () => {
    const h = table();
    transport.from.mockImplementation(() => {
      const query: any = {
        select: () => query,
        eq: () => query,
        maybeSingle: () => new Promise(() => {}),
        then: () => new Promise(() => {}),
      };
      return query;
    });
    h.leave(1, 250, 0);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    h.dispose();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1500);
    });
    expect(peekSessionSummary()).toBeNull();
    expect(h.emit).not.toHaveBeenCalled();
    expect(h.navigate).not.toHaveBeenCalled();
  });

  it('closes only its own tab in multi-table mode', async () => {
    const h = table({ embedded: true });
    h.receive({ payload: event() });
    await settle();
    expect(h.emit).toHaveBeenCalledWith('TABLE_LEFT', { tableId: 'table', seat: 1 });
    expect(h.navigate).not.toHaveBeenCalled();
  });

  it('retries an unreadable qualification without reporting a fabricated cash prize', async () => {
    const h = table();
    renderHost();
    transport.rpc.mockResolvedValue({ data: null, error: { message: 'network unavailable' } });
    const lookup = h.reload();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(600);
      await lookup;
    });
    expect(peekSessionSummary()).toBeNull();
    expect(h.navigate).not.toHaveBeenCalled();
    expect(h.report).toHaveBeenCalled();
    transport.rpc.mockResolvedValue({ data: receipt('cash'), error: null });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1001);
    });
    expect(screen.getByText('Cash Credited')).toBeTruthy();
    expect(h.navigate).toHaveBeenCalledTimes(1);
  });

  it('bounds a stalled authoritative RPC and recovers on the existing durable retry', async () => {
    const h = table();
    transport.rpc.mockImplementation(() => new Promise(() => {}));
    const lookup = h.reload();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5100);
      await lookup;
    });
    expect(h.navigate).not.toHaveBeenCalled();
    transport.rpc.mockResolvedValue({ data: receipt(), error: null });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1001);
    });
    expect(h.navigate).toHaveBeenCalledTimes(1);
  });

  it.each(['tournaments', 'tournament_players'])(
    'recovers when the prerequisite %s read stalls',
    async (blockedTable) => {
      const h = table();
      const normalRead = transport.from.getMockImplementation()!;
      transport.from.mockImplementation((name) => {
        const query = normalRead(name);
        if (name === blockedTable) query.maybeSingle = () => new Promise(() => {});
        return query;
      });
      const lookup = blockedTable === 'tournaments' ? h.verify() : h.reload();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(blockedTable === 'tournaments' ? 1500 : 5100);
        await lookup;
      });
      expect(h.navigate).not.toHaveBeenCalled();
      expect(peekSessionSummary()).toBeNull();
      transport.from.mockImplementation(normalRead);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1001);
      });
      expect(peekSessionSummary()?.tournament?.qualification?.deliveryKind).toBe('seat');
      expect(h.navigate).toHaveBeenCalledTimes(1);
    }
  );

  it('manual result enrichment also treats a qualified seat value as non-cash', async () => {
    const h = table();
    const result = await h.enrich('satellite', 'hero');
    expect(result.qualification?.deliveryKind).toBe('seat');
    expect(result.prize).toBe(0);
    expect(result.finishPlace).toBeNull();
  });

  it('preserves the ordinary single-winner broadcast, seven-second celebration and ranking card', async () => {
    row = { status: 'winner', position: 1, prize: 250 };
    const h = table();
    renderHost();
    h.receive({ payload: { type: 'tournament_winner', payload: { userId: 'hero', prize: 250 } } });
    expect(h.winner).toHaveBeenCalledWith({ prize: 250, name: 'Satellite' });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(6999);
    });
    expect(h.navigate).not.toHaveBeenCalled();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(screen.getAllByText('1st').length).toBeGreaterThan(0);
    expect(screen.queryByRole('dialog', { name: 'Qualified' })).toBeNull();
    expect(transport.rpc).not.toHaveBeenCalled();
  });

  it('preserves durable single-winner completion without depending on the new RPC', async () => {
    row = { status: 'winner', position: 1, prize: 250 };
    const h = table();
    await h.reload();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(7000);
    });
    expect(peekSessionSummary()?.tournament?.finishPlace).toBe(1);
    expect(peekSessionSummary()?.tournament?.prize).toBe(250);
    expect(transport.rpc).not.toHaveBeenCalled();
  });

  it('keeps the result until dismissal and opens the actual target route on request', async () => {
    const h = table();
    renderHost();
    h.receive({ payload: event() });
    await settle();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60000);
    });
    expect(screen.getByRole('dialog', { name: 'Qualified' })).toBeTruthy();
    await act(async () =>
      fireEvent.click(screen.getByRole('button', { name: 'View Target Tournament' }))
    );
    expect(screen.getByLabelText('Route').textContent).toBe('/tournaments/target');
    expect(peekSessionSummary()).toBeNull();
  });
});

describe('Own qualification RPC validation', () => {
  it('returns null for a genuinely absent own qualification', async () => {
    transport.rpc.mockResolvedValue({ data: null, error: null });
    await expect(
      tournamentService.getMySatelliteQualification('satellite', 'hero')
    ).resolves.toBeNull();
  });
  it.each([
    { user_id: 'other' },
    { tournament_id: 'other' },
    { amount: null },
    { amount: 1.234 },
    { delivery_kind: 'unknown' },
  ])('rejects malformed or mismatched authority data %j', async (patch) => {
    transport.rpc.mockResolvedValue({ data: { ...receipt(), ...patch }, error: null });
    await expect(
      tournamentService.getMySatelliteQualification('satellite', 'hero')
    ).rejects.toThrow('receipt is invalid');
  });
});

describe('Qualification result ownership across late publishers', () => {
  it('retains qualification facts when a late same-event publisher has only rank and prize', async () => {
    const h = table();
    h.receive({ payload: event({ deliveryKind: 'ticket' }) });
    await settle();
    const first = peekSessionSummary()!;
    publishSessionSummary({
      ...first,
      tournament: { ...first.tournament!, qualification: undefined, finishPlace: 1, prize: 125.5 },
    });
    expect(peekSessionSummary()?.tournament?.qualification?.deliveryKind).toBe('ticket');
    expect(peekSessionSummary()?.tournament?.finishPlace).toBeNull();
    expect(peekSessionSummary()?.tournament?.prize).toBe(0);
  });

  it('upgrades a preliminary result to qualification without carrying a fabricated rank or cash', async () => {
    const h = table();
    h.receive({ payload: event() });
    await settle();
    const qualified = peekSessionSummary()!;
    clearSessionSummary();
    publishSessionSummary({
      ...qualified,
      tournament: {
        ...qualified.tournament!,
        qualification: undefined,
        finishPlace: 1,
        prize: 125.5,
      },
    });
    publishSessionSummary(qualified);
    expect(peekSessionSummary()?.tournament?.qualification?.deliveryKind).toBe('seat');
    expect(peekSessionSummary()?.tournament?.finishPlace).toBeNull();
    expect(peekSessionSummary()?.tournament?.prize).toBe(0);
  });

  it('retains a queued qualification when that same event publishes an incomplete retry', async () => {
    const h = table();
    h.receive({ payload: event() });
    await settle();
    const first = peekSessionSummary()!;
    const second = {
      ...first,
      tournament: {
        ...first.tournament!,
        tournamentId: 'second',
        qualification: { ...first.tournament!.qualification!, tournamentId: 'second' },
      },
    };
    publishSessionSummary(second);
    publishSessionSummary({
      ...second,
      tournament: { ...second.tournament, qualification: undefined, finishPlace: 1, prize: 125.5 },
    });
    clearSessionSummary();
    expect(peekSessionSummary()?.tournament?.qualification?.tournamentId).toBe('second');
    expect(peekSessionSummary()?.tournament?.finishPlace).toBeNull();
    expect(peekSessionSummary()?.tournament?.prize).toBe(0);
    clearSessionSummary();
    expect(peekSessionSummary()).toBeNull();
  });

  it('queues different same-name tournaments without swallowing either result', async () => {
    const h = table();
    h.receive({ payload: event() });
    await settle();
    const first = peekSessionSummary()!;
    for (const id of ['second-satellite', 'third-satellite']) {
      publishSessionSummary({
        ...first,
        tournament: {
          ...first.tournament!,
          tournamentId: id,
          qualification: { ...first.tournament!.qualification!, tournamentId: id },
        },
      });
    }
    expect(peekSessionSummary()?.tournament?.tournamentId).toBe('satellite');
    clearSessionSummary();
    expect(peekSessionSummary()?.tournament?.tournamentId).toBe('second-satellite');
    clearSessionSummary();
    expect(peekSessionSummary()?.tournament?.tournamentId).toBe('third-satellite');
    clearSessionSummary();
    expect(peekSessionSummary()).toBeNull();
  });
});
