import React, {
  StrictMode,
  Suspense,
  startTransition,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import { render, act, cleanup, fireEvent } from '@testing-library/react';
import { beforeEach, afterEach, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import ts from 'typescript';
const h = vi.hoisted(() => ({
  user: { id: 'actor-A' } as any,
  reads: [] as any[],
  events: [] as any[],
  listeners: new Map<string, Set<any>>(),
  navigate: vi.fn(),
  warm: vi.fn(),
  report: vi.fn(),
  resync: vi.fn(),
  cap: vi.fn(),
  committed: [] as any[],
  setTabs: null as any,
  transport: null as any,
}));
vi.mock('react-router-dom', () => ({ useNavigate: () => h.navigate }));
vi.mock('../../src/hooks/useAuthUser', () => ({ useAuthUser: () => ({ user: h.user }) }));
vi.mock('../../src/services/tableWarmup', () => ({ warmTable: h.warm }));
vi.mock('../../src/utils/errorReporter', () => ({ reportError: h.report }));
vi.mock('../../src/lib/supabase', () => ({
  supabase: {
    from: (relation: string) => {
      const filters: any[] = [];
      const query: any = {
        select: (columns: string) => {
          filters.push(['select', columns]);
          return query;
        },
        eq: (...args: any[]) => {
          filters.push(['eq', ...args]);
          return query;
        },
        is: (...args: any[]) => {
          filters.push(['is', ...args]);
          return query;
        },
        limit: (limit: number) =>
          new Promise((resolve, reject) =>
            h.reads.push({ relation, filters, limit, resolve, reject })
          ),
      };
      return query;
    },
  },
}));
vi.mock('../../src/core/MasterBus', () => ({
  masterBus: {
    subscribe: (name: string, callback: any) => {
      if (h.transport) return h.transport.subscribe(name, callback);
      if (!h.listeners.has(name)) h.listeners.set(name, new Set());
      h.listeners.get(name)!.add(callback);
      return () => h.listeners.get(name)?.delete(callback);
    },
    emit: (name: string, payload: any) => {
      h.events.push({ name, payload });
      if (h.transport) return h.transport.emit(name, payload);
      for (const callback of [...(h.listeners.get(name) || [])]) callback({ payload });
    },
  },
}));
import AutoSeat from '../../src/components/tournament/TournamentAutoSeat';
import { masterBus } from '../../src/core/MasterBus';
import { useMasterBusSubscription } from '../../src/hooks/useMasterBusSubscription';
import { isLobbyLike as isLobbyTab } from '../../src/utils/tabSlots';

// Execute the actual parent's new hook and existing TABLE_SEATED callback without
// importing every page child. The only harness override selects a hash-verified
// exact candidate excerpt before integration; normal CI reads the real page.
const parentText = readFileSync(
  process.env.CA_AUTOSEAT_PARENT_INPUT || resolve('src/pages/MultiTablePage.tsx'),
  'utf8'
);
const ast = ts.createSourceFile(
  'MultiTablePage.tsx',
  parentText,
  ts.ScriptTarget.Latest,
  true,
  ts.ScriptKind.TSX
);
const hook = ast.statements.find(
  (node) => ts.isFunctionDeclaration(node) && node.name?.text === 'useTournamentOpenAcknowledgments'
);
let handler: ts.Expression | undefined;
function visit(node: ts.Node) {
  if (
    ts.isCallExpression(node) &&
    node.expression.getText(ast) === 'useMasterBusSubscription' &&
    node.arguments[0]?.getText(ast) === "'TABLE_SEATED'"
  )
    handler = node.arguments[1];
  ts.forEachChild(node, visit);
}
visit(ast);
if (!hook || !handler) throw new Error('Actual parent acknowledgment or seating handler missing');
const compile = (code: string) =>
  ts.transpileModule(code, {
    compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.None },
  }).outputText;
const bindParentAck = new Function(
  'bindings',
  compile(
    `const {useRef,useState,useLayoutEffect,useCallback,masterBus,isLobbyTab,MAX_TABLES}=bindings; ${hook.getText(ast)}; return useTournamentOpenAcknowledgments;`
  )
) as any;
const useParentAck = bindParentAck({ ...React, masterBus, isLobbyTab, MAX_TABLES: 4 });
const bindHandler = new Function(
  'bindings',
  compile(
    `const {seatReadScopeRef,user,voluntarilyLeftTablesRef,requestSeatResync,setTables,formatGameTitle,isLobbyTab,MAX_TABLES,notifyCapReached,trackTournamentOpenAttempt}=bindings; return ${handler.getText(ast)};`
  )
) as any;
function Parent({ userId = h.user?.id, initial = [] }: { userId?: string; initial?: any[] }) {
  const [tables, setTables] = useState(initial);
  const seatReadScopeRef = useRef({ userId });
  const voluntarilyLeftTablesRef = useRef(new Set());
  useLayoutEffect(() => {
    seatReadScopeRef.current = { userId };
  }, [userId]);
  const trackTournamentOpenAttempt = useParentAck(userId, tables);
  const callback = bindHandler({
    seatReadScopeRef,
    user: { id: userId },
    voluntarilyLeftTablesRef,
    requestSeatResync: h.resync,
    setTables,
    formatGameTitle: (name: string) => name,
    isLobbyTab,
    MAX_TABLES: 4,
    notifyCapReached: h.cap,
    trackTournamentOpenAttempt,
  });
  useMasterBusSubscription('TABLE_SEATED', callback);
  useLayoutEffect(() => {
    h.setTabs = setTables;
    h.committed.push(tables);
  }, [tables]);
  return <div data-testid="parent-tabs">{tables.map((t) => t.id).join(',')}</div>;
}
const row = (table = 'destination-A', away = false) => ({
  table_id: table,
  joined_at: new Date().toISOString(),
  stack: 100,
  is_away: away,
  is_sitting_out: false,
  tables: { id: table, name: 'Fixture Event - Table 1', tournament_id: 'event', status: 'running' },
});
const seated = () => h.events.filter((e) => e.name === 'TABLE_SEATED');
const replies = () => h.events.filter((e) => e.name === 'TOURNAMENT_TABLE_OPEN_RESULT');
const storedSeen = () =>
  Object.keys(sessionStorage)
    .filter((k) => k.startsWith('ca_tourney_autoseat_seen:'))
    .flatMap((k) => JSON.parse(sessionStorage.getItem(k)!));
async function respond(n: number, rows: any[]) {
  await act(async () => {
    h.reads[n].resolve({ data: rows, error: null });
    await Promise.resolve();
  });
}
async function poll() {
  await act(async () => {
    vi.advanceTimersByTime(12000);
  });
}
function emit(name: any, payload: any) {
  act(() => masterBus.emit(name, payload));
}
beforeEach(() => {
  vi.useFakeTimers();
  h.user = { id: 'actor-A' };
  h.reads = [];
  h.events = [];
  h.listeners.clear();
  h.committed = [];
  h.setTabs = null;
  h.transport = null;
  [h.navigate, h.warm, h.report, h.resync, h.cap].forEach((fn) => fn.mockClear());
  sessionStorage.clear();
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
  Object.defineProperty(document, 'hidden', { configurable: true, value: false });
});
afterEach(() => {
  cleanup();
  transportCleanup();
  expect([...h.listeners.values()].every((s) => s.size === 0)).toBe(true);
  expect(vi.getTimerCount()).toBe(0);
  vi.useRealTimers();
});

it('control: current own fresh seat is announced using the scoped query', async () => {
  render(<AutoSeat />);
  await respond(0, [row()]);
  expect(h.reads[0].filters).toContainEqual(['eq', 'user_id', 'actor-A']);
  expect(h.reads[0].filters).toContainEqual(['is', 'left_at', null]);
  expect(seated()).toHaveLength(1);
  expect(seated()[0].payload.userId).toBe('actor-A');
  expect(storedSeen()).toEqual([]);
});
it('CB011: old account response must not publish after committed account change', async () => {
  const v = render(<AutoSeat />);
  h.user = { id: 'actor-B' };
  v.rerender(<AutoSeat />);
  await respond(0, [row()]);
  expect(seated()).toHaveLength(0);
});
it('CB011: response after unmount must not warm or announce a table', async () => {
  const v = render(<AutoSeat />);
  v.unmount();
  await respond(0, [row()]);
  expect(h.warm).not.toHaveBeenCalled();
  expect(seated()).toHaveLength(0);
});
it('CB011: superseded polling response must not announce an older destination', async () => {
  render(<AutoSeat />);
  await poll();
  await respond(1, [row('destination-new')]);
  await respond(0, [row('destination-old')]);
  expect(seated().map((e) => e.payload.tableId)).toEqual(['destination-new']);
});
it('CB013: cap refusal must not mark an unconfirmed opening seen or suppress retry', async () => {
  render(
    <>
      <AutoSeat />
      <Parent initial={['a', 'b', 'c', 'd'].map((id) => ({ id, kind: 'table', seated: true }))} />
    </>
  );
  await respond(0, [row()]);
  expect(replies()[0].payload.status).toBe('cap_blocked');
  expect(storedSeen()).toEqual([]);
  expect(document.querySelector('[role=dialog]')).not.toBeNull();
  act(() => h.setTabs((tabs: any[]) => tabs.slice(1)));
  await poll();
  await respond(1, [row()]);
  expect(seated()).toHaveLength(2);
  expect(replies().at(-1)!.payload.status).toBe('opened');
  expect(storedSeen()).toEqual(['destination-A']);
  expect(document.querySelector('[role=dialog]')).toBeNull();
});
it('CB012: actor A seen state must not suppress actor B at the same table', async () => {
  const v = render(<AutoSeat />);
  await respond(0, [row()]);
  emit('TOURNAMENT_TABLE_OPEN_RESULT', { ...seated()[0].payload, status: 'opened' });
  h.user = { id: 'actor-B' };
  v.rerender(<AutoSeat />);
  await respond(1, [row()]);
  expect(seated()).toHaveLength(2);
  expect(storedSeen()).toEqual([]);
});
it('CB012: previous account popup must not navigate under the next account', async () => {
  const v = render(<AutoSeat />);
  await respond(0, [row('destination-A', true)]);
  h.user = { id: 'actor-B' };
  v.rerender(<AutoSeat />);
  const button = v.queryByText('Take My Seat');
  if (button) fireEvent.click(button);
  expect(h.navigate).not.toHaveBeenCalled();
});
it('CB012: late cap event for previous account must not display its popup', async () => {
  const v = render(<AutoSeat />);
  await respond(0, [row()]);
  const old = seated()[0].payload;
  h.user = { id: 'actor-B' };
  v.rerender(<AutoSeat />);
  emit('TABLE_CAP_BLOCKED', { tableId: 'destination-A' });
  emit('TOURNAMENT_TABLE_OPEN_RESULT', { ...old, status: 'cap_blocked' });
  expect(document.querySelector('[role=dialog]')).toBeNull();
});
it('actual parent confirms new, existing and lobby-converted tabs only after commit', async () => {
  const v = render(
    <>
      <AutoSeat />
      <Parent initial={[{ id: 'lobby:1', kind: 'lobby' }]} />
    </>
  );
  await respond(0, [row()]);
  expect(h.committed.at(-1).map((t: any) => t.id)).toEqual(['destination-A']);
  expect(replies()).toHaveLength(1);
  expect(replies()[0].payload).toEqual({
    tableId: 'destination-A',
    userId: 'actor-A',
    openAttemptId: seated()[0].payload.openAttemptId,
    status: 'opened',
  });
  await poll();
  await respond(1, [row()]);
  expect(seated()).toHaveLength(1);
  expect(h.resync).toHaveBeenCalledTimes(1);
  v.unmount();
  sessionStorage.clear();
  h.reads = [];
  h.events = [];
  h.committed = [];
  render(
    <>
      <AutoSeat />
      <Parent initial={[{ id: 'destination-A', kind: 'table', seated: true }]} />
    </>
  );
  await respond(0, [row()]);
  expect(replies()).toHaveLength(1);
  expect(h.committed.at(-1)).toHaveLength(1);
});
it('absent parent remains retryable and no unrelated or old acknowledgment marks seen', async () => {
  render(<AutoSeat />);
  await respond(0, [row()]);
  const old = seated()[0].payload;
  await poll();
  await respond(1, [row()]);
  const latest = seated()[1].payload;
  for (const change of [{}, { userId: 'actor-B' }, { tableId: 'wrong' }])
    emit('TOURNAMENT_TABLE_OPEN_RESULT', { ...old, ...change, status: 'opened' });
  expect(storedSeen()).toEqual([]);
  emit('TOURNAMENT_TABLE_OPEN_RESULT', { ...latest, status: 'opened' });
  expect(storedSeen()).toEqual(['destination-A']);
});
it('same-account auth replacement invalidates pending reads, storage and acknowledgments synchronously', async () => {
  render(<AutoSeat />);
  await respond(0, [row()]);
  const old = seated()[0].payload;
  emit('AUTH_STATE_CHANGED', { isAuthenticated: true, userId: 'actor-A' });
  emit('TOURNAMENT_TABLE_OPEN_RESULT', { ...old, status: 'opened' });
  expect(storedSeen()).toEqual([]);
  await respond(1, [row()]);
  expect(seated()).toHaveLength(2);
  expect(seated()[1].payload.openAttemptId).not.toBe(old.openAttemptId);
});
it('auth change fences a poll before a delayed user prop commit', async () => {
  render(<AutoSeat />);
  emit('AUTH_STATE_CHANGED', { isAuthenticated: true, userId: 'actor-B' });
  await respond(0, [row()]);
  expect(seated()).toHaveLength(0);
  expect(h.warm).not.toHaveBeenCalled();
});
it('Take My Seat navigates once only after the matching committed open', async () => {
  const v = render(<AutoSeat />);
  await respond(0, [row('destination-A', true)]);
  fireEvent.click(v.getByText('Take My Seat'));
  expect(h.navigate).not.toHaveBeenCalled();
  const request = seated().at(-1)!.payload;
  emit('TOURNAMENT_TABLE_OPEN_RESULT', { ...request, status: 'cap_blocked' });
  expect(h.navigate).not.toHaveBeenCalled();
  emit('TOURNAMENT_TABLE_OPEN_RESULT', { ...request, status: 'opened' });
  emit('TOURNAMENT_TABLE_OPEN_RESULT', { ...request, status: 'opened' });
  expect(h.navigate).toHaveBeenCalledExactlyOnceWith('/table/destination-A');
});
it('StrictMode discards first-setup reads and produces one confirmed opening', async () => {
  render(
    <StrictMode>
      <AutoSeat />
      <Parent />
    </StrictMode>
  );
  expect(h.reads.length).toBeGreaterThanOrEqual(2);
  await respond(0, [row('old')]);
  expect(seated()).toHaveLength(0);
  await respond(h.reads.length - 1, [row()]);
  expect(seated()).toHaveLength(1);
  expect(replies()).toHaveLength(1);
});
it('suspended identity render cannot steal the committed actor poll', async () => {
  const never = new Promise(() => {});
  const committed = vi.fn();
  function Tree({ suspend = false }: { suspend?: boolean }) {
    useLayoutEffect(() => {
      committed(suspend);
    });
    return (
      <>
        <AutoSeat />
        {suspend ? <Block /> : null}
      </>
    );
  }
  function Block(): never {
    throw never;
  }
  const v = render(
    <Suspense fallback={<div>waiting</div>}>
      <Tree />
    </Suspense>
  );
  h.user = { id: 'actor-B' };
  await act(async () => {
    startTransition(() =>
      v.rerender(
        <Suspense fallback={<div>waiting</div>}>
          <Tree suspend />
        </Suspense>
      )
    );
  });
  expect(committed.mock.calls).toEqual([[false]]);
  await respond(0, [row()]);
  expect(seated()).toHaveLength(1);
  expect(seated()[0].payload.userId).toBe('actor-A');
});
it('parent never acknowledges a table from an uncommitted suspended render', async () => {
  const never = new Promise(() => {});
  let queue: any;
  function Probe({ tabs, suspend = false }: { tabs: any[]; suspend?: boolean }) {
    const track = useParentAck('actor-A', tabs);
    useLayoutEffect(() => {
      queue = track;
    });
    if (suspend) throw never;
    return <div>parent committed</div>;
  }
  const v = render(
    <Suspense fallback={<div>waiting</div>}>
      <Probe tabs={[]} />
    </Suspense>
  );
  act(() => queue({ userId: 'actor-A', tableId: 'target', openAttemptId: 'one' }, () => true));
  await act(async () => {
    startTransition(() =>
      v.rerender(
        <Suspense fallback={<div>waiting</div>}>
          <Probe tabs={[{ id: 'target', seated: true }]} suspend />
        </Suspense>
      )
    );
  });
  expect(replies()).toHaveLength(0);
  v.rerender(
    <Suspense fallback={<div>waiting</div>}>
      <Probe tabs={[{ id: 'target', seated: true }]} />
    </Suspense>
  );
  expect(replies()).toHaveLength(1);
});
it('parent drops pending work on auth replacement and rejects a foreign actor before tab mutation', async () => {
  render(<Parent />);
  emit('TABLE_SEATED', { tableId: 'foreign', userId: 'actor-B', openAttemptId: 'bad' });
  expect(h.resync).not.toHaveBeenCalled();
  expect(replies()).toHaveLength(0);
  expect(h.committed.at(-1)).toEqual([]);
  emit('AUTH_STATE_CHANGED', { isAuthenticated: true, userId: 'actor-B' });
  emit('TABLE_SEATED', { tableId: 'old', userId: 'actor-A', openAttemptId: 'old' });
  expect(h.resync).not.toHaveBeenCalled();
});
it('ordinary uncorrelated seating retains parent cap and dedup behavior without synthetic acknowledgments', () => {
  render(<Parent initial={['a', 'b', 'c', 'd'].map((id) => ({ id, seated: true }))} />);
  emit('TABLE_SEATED', { tableId: 'e', userId: 'actor-A' });
  expect(h.cap).toHaveBeenCalledWith('seated', 'e');
  expect(h.committed.at(-1)).toHaveLength(4);
  expect(replies()).toHaveLength(0);
});
it('parent rejects replaced source scope and only acknowledges the newest attempt for a table', () => {
  let queue: any;
  let current = true;
  function Probe({ tabs }: { tabs: any[] }) {
    const track = useParentAck('actor-A', tabs);
    useLayoutEffect(() => {
      queue = track;
    });
    return null;
  }
  const v = render(<Probe tabs={[]} />);
  act(() =>
    queue({ userId: 'actor-A', tableId: 'target', openAttemptId: 'stale-source' }, () => current)
  );
  current = false;
  v.rerender(<Probe tabs={[{ id: 'target', seated: true }]} />);
  expect(replies()).toHaveLength(0);
  v.rerender(<Probe tabs={[]} />);
  act(() => {
    queue({ userId: 'actor-A', tableId: 'target', openAttemptId: 'older' }, () => true);
    queue({ userId: 'actor-A', tableId: 'target', openAttemptId: 'newest' }, () => true);
  });
  v.rerender(<Probe tabs={[{ id: 'target', seated: true }]} />);
  expect(replies().map((e) => e.payload.openAttemptId)).toEqual(['newest']);
});
it('new actor can proceed after auth identity and committed props agree', async () => {
  const v = render(
    <>
      <AutoSeat />
      <Parent userId="actor-A" />
    </>
  );
  emit('AUTH_STATE_CHANGED', { isAuthenticated: true, userId: 'actor-B' });
  h.user = { id: 'actor-B' };
  v.rerender(
    <>
      <AutoSeat />
      <Parent userId="actor-B" />
    </>
  );
  await respond(0, [row('old')]);
  await respond(h.reads.length - 1, [row('new')]);
  expect(seated()).toHaveLength(1);
  expect(replies()[0].payload).toMatchObject({
    userId: 'actor-B',
    tableId: 'new',
    status: 'opened',
  });
});
it('stale read rejection cannot report into a replacement account', async () => {
  const v = render(<AutoSeat />);
  h.user = { id: 'actor-B' };
  v.rerender(<AutoSeat />);
  await act(async () => {
    h.reads[0].reject(new Error('old request'));
  });
  expect(h.report).not.toHaveBeenCalled();
});
it('legacy unscoped storage never suppresses the current account and owned keys are cleaned', async () => {
  sessionStorage.setItem('ca_tourney_autoseat_seen', JSON.stringify(['destination-A']));
  const v = render(<AutoSeat />);
  await respond(0, [row()]);
  emit('TOURNAMENT_TABLE_OPEN_RESULT', { ...seated()[0].payload, status: 'opened' });
  expect(storedSeen()).toEqual(['destination-A']);
  v.unmount();
  expect(storedSeen()).toEqual([]);
  expect(sessionStorage.getItem('ca_tourney_autoseat_seen')).toBe(
    JSON.stringify(['destination-A'])
  );
});
it('null-user auth event invalidates a pending acknowledgment without reviving the old actor', async () => {
  render(<AutoSeat />);
  await respond(0, [row()]);
  const request = seated()[0].payload;
  emit('AUTH_STATE_CHANGED', { isAuthenticated: true, userId: null });
  emit('TOURNAMENT_TABLE_OPEN_RESULT', { ...request, status: 'opened' });
  expect(storedSeen()).toEqual([]);
  expect(h.navigate).not.toHaveBeenCalled();
});

// R01: keep joined_at fixed across the freshness boundary, unlike row() per poll.
it.each(['cap', 'missing-parent'])(
  'retained %s attempt retries a query-confirmed seat beyond ten minutes',
  async (mode) => {
    vi.setSystemTime(new Date('2026-09-13T12:09:59Z'));
    const fixed = { ...row(), joined_at: '2026-09-13T12:00:00Z' };
    const v = render(
      <>
        <AutoSeat />
        {mode === 'cap' && (
          <Parent
            initial={['a', 'b', 'c', 'd'].map((id) => ({ id, kind: 'table', seated: true }))}
          />
        )}
      </>
    );
    await respond(0, [fixed]);
    expect(seated()).toHaveLength(1);
    expect(storedSeen()).toEqual([]);
    if (mode === 'cap') act(() => h.setTabs((tabs: any[]) => tabs.slice(1)));
    else
      v.rerender(
        <>
          <AutoSeat />
          <Parent />
        </>
      );
    await poll();
    await respond(1, [fixed]);
    expect(seated()).toHaveLength(2);
    expect(replies().at(-1)?.payload.status).toBe('opened');
    expect(storedSeen()).toEqual(['destination-A']);
  }
);
it('never-attempted old seats retain the discovery freshness policy', async () => {
  vi.setSystemTime(new Date('2026-09-13T12:10:01Z'));
  render(
    <>
      <AutoSeat />
      <Parent />
    </>
  );
  await respond(0, [{ ...row(), joined_at: '2026-09-13T12:00:00Z' }]);
  expect(seated()).toHaveLength(0);
  expect(storedSeen()).toEqual([]);
});
it.each(['absent', 'terminal', 'cash', 'error'])(
  'pending attempt does not blindly retry after %s query evidence',
  async (mode) => {
    vi.setSystemTime(new Date('2026-09-13T12:09:59Z'));
    const fixed = { ...row(), joined_at: '2026-09-13T12:00:00Z' };
    render(<AutoSeat />);
    await respond(0, [fixed]);
    await poll();
    if (mode === 'error')
      await act(async () => {
        h.reads[1].resolve({ data: null, error: new Error('query unavailable') });
        await Promise.resolve();
      });
    else
      await respond(
        1,
        mode === 'absent'
          ? []
          : [
              {
                ...fixed,
                tables: {
                  ...fixed.tables,
                  ...(mode === 'terminal' ? { status: 'closed' } : { tournament_id: null }),
                },
              },
            ]
      );
    expect(seated()).toHaveLength(1);
    expect(storedSeen()).toEqual([]);
  }
);
it('urgent explicit cap refusal explains how to free a table while preserving the warning', async () => {
  const v = render(
    <>
      <AutoSeat />
      <Parent initial={['a', 'b', 'c', 'd'].map((id) => ({ id, kind: 'table', seated: true }))} />
    </>
  );
  await respond(0, [row('destination-A', true)]);
  expect(v.getByRole('dialog').getAttribute('aria-label')).toBe('You Are Being Blinded Off');
  fireEvent.click(v.getByText('Take My Seat'));
  expect(v.getByRole('dialog').textContent).toContain('Close A Table');
  expect(v.getByRole('dialog').textContent).toContain('Your Seat Is Posting Blinds');
  expect(h.navigate).not.toHaveBeenCalled();
  act(() => h.setTabs((tabs: any[]) => tabs.slice(1)));
  fireEvent.click(v.getByText('Take My Seat'));
  expect(h.navigate).toHaveBeenCalledExactlyOnceWith('/table/destination-A');
});
it('unrelated background cap retains urgent context without attributing its cap to that warning', async () => {
  const v = render(<AutoSeat />);
  await respond(0, [row('urgent', true), row('background')]);
  emit('TOURNAMENT_TABLE_OPEN_RESULT', {
    ...seated().find((e) => e.payload.tableId === 'background')!.payload,
    status: 'cap_blocked',
  });
  expect(v.getByRole('dialog').getAttribute('aria-label')).toBe('You Are Being Blinded Off');
  expect(v.getByRole('dialog').textContent).not.toContain('Close A Table');
});

// Whole actual MasterBusCore, including init, broadcast receive, emit/dedup and
// reset. Only external stores/transport are controlled; no replacement emit rule.
const busText = readFileSync(
  process.env.CA_AUTOSEAT_BUS_INPUT || resolve('src/core/MasterBus.ts'),
  'utf8'
);
const busAst = ts.createSourceFile('MasterBus.ts', busText, ts.ScriptTarget.Latest, true);
const busClass = busAst.statements.find(
  (n) => ts.isClassDeclaration(n) && n.name?.text === 'MasterBusCore'
);
const busGlobals = busAst.statements.filter(
  (n) =>
    ts.isVariableStatement(n) &&
    n.declarationList.declarations.some((d) =>
      ['_subscriberIdCounter', '_eventLogIdCounter', 'CRITICAL_EVENTS'].includes(
        d.name.getText(busAst)
      )
    )
);
if (!busClass || busGlobals.length !== 3) throw new Error('Actual MasterBus class/globals missing');
const instantiateBus = new Function(
  'bindings',
  compile(
    `const {useArenaStore,useClubStore,useTableStore,useUnionStore,useWalletStore,useSettingsStore,useUserStore,realtimeChannelService,supabase,reportError,STORAGE_KEYS,IS_NATIVE_BUILD,playerDisplayName}=bindings; ${busGlobals.map((n) => n.getText(busAst)).join('\n')} ${busClass.getText(busAst)}; return new MasterBusCore();`
  )
);
const transportBuses: any[] = [];
const endpoints: TestBroadcastChannel[] = [];
class TestBroadcastChannel {
  onmessage: ((e: any) => void) | null = null;
  closed = false;
  sent: any[] = [];
  constructor(public name: string) {
    endpoints.push(this);
  }
  postMessage(data: any) {
    this.sent.push(structuredClone(data));
    for (const peer of endpoints)
      if (peer !== this && !peer.closed && peer.name === this.name) {
        const copy = structuredClone(data);
        queueMicrotask(() => {
          if (!peer.closed) peer.onmessage?.({ data: copy });
        });
      }
  }
  close() {
    this.closed = true;
  }
}
function actualBus() {
  vi.stubGlobal('BroadcastChannel', TestBroadcastChannel);
  const state = {
    user: { id: 'actor-A' },
    loadMemberships: vi.fn(),
    refreshAll: vi.fn(),
    reset: vi.fn(),
  };
  const store = { getState: () => state, setState: vi.fn() };
  const bus = instantiateBus({
    useArenaStore: store,
    useClubStore: store,
    useTableStore: store,
    useUnionStore: store,
    useWalletStore: store,
    useSettingsStore: store,
    useUserStore: store,
    realtimeChannelService: { handleIdentityChange: vi.fn() },
    supabase: { removeChannel: vi.fn() },
    reportError: h.report,
    STORAGE_KEYS: { SETTINGS: 'test-settings' },
    IS_NATIVE_BUILD: false,
    playerDisplayName: () => '',
  });
  bus.init();
  transportBuses.push(bus);
  return bus;
}
function transportCleanup() {
  for (const bus of transportBuses) {
    bus.reset();
    expect(bus.getStatus()).toBeNull();
  }
  if (transportBuses.length) {
    expect(endpoints.every((p) => p.closed)).toBe(true);
    // Real MasterBus retains at most500ms dedup expiry timeouts after reset.
    vi.advanceTimersByTime(501);
    expect(h.report).not.toHaveBeenCalled();
  }
  transportBuses.length = 0;
  endpoints.length = 0;
  vi.unstubAllGlobals();
  h.transport = null;
}
function RemoteParent({ bus }: { bus: any }) {
  const useAck = React.useMemo(
    () => bindParentAck({ ...React, masterBus: bus, isLobbyTab, MAX_TABLES: 4 }),
    [bus]
  );
  const [tables, setTables] = useState<any[]>([]);
  const seatReadScopeRef = useRef({ userId: 'actor-A' });
  const voluntarilyLeftTablesRef = useRef(new Set());
  const trackTournamentOpenAttempt = useAck('actor-A', tables);
  const callback = bindHandler({
    seatReadScopeRef,
    user: { id: 'actor-A' },
    voluntarilyLeftTablesRef,
    requestSeatResync: () => {},
    setTables,
    formatGameTitle: (n: string) => n,
    isLobbyTab,
    MAX_TABLES: 4,
    notifyCapReached: () => {},
    trackTournamentOpenAttempt,
  });
  useLayoutEffect(
    () => bus.subscribe('TABLE_SEATED', (event: any) => callback(event.payload)),
    [bus, callback]
  );
  return <div data-testid="remote-tabs">{tables.map((t) => t.id).join(',')}</div>;
}
it('actual two-endpoint bus cannot let the roomier remote parent confirm a capped local attempt', async () => {
  const a = actualBus(),
    b = actualBus();
  h.transport = a;
  const localReplies: any[] = [];
  const remoteRequests: any[] = [];
  const offA = a.subscribe('TOURNAMENT_TABLE_OPEN_RESULT', (e: any) =>
    localReplies.push(e.payload)
  );
  const offB = b.subscribe('TABLE_SEATED', (e: any) => remoteRequests.push(e.payload));
  const v = render(
    <>
      <AutoSeat />
      <Parent initial={['a', 'b', 'c', 'd'].map((id) => ({ id, kind: 'table', seated: true }))} />
      <RemoteParent bus={b} />
    </>
  );
  await respond(0, [row('destination-A', true)]);
  await act(async () => {
    await Promise.resolve();
  });
  expect(remoteRequests).toEqual([]);
  expect(v.getByTestId('remote-tabs').textContent).toBe('');
  expect(localReplies.map((r) => r.status)).toEqual(['cap_blocked']);
  expect(storedSeen()).toEqual([]);
  fireEvent.click(v.getByText('Take My Seat'));
  const pending = seated().at(-1)!.payload;
  // The remote bus cannot broadcast even a matching acknowledgment. Also reject
  // a delayed message from an older sender at the receiving distribution fence.
  act(() => b.emit('TOURNAMENT_TABLE_OPEN_RESULT', { ...pending, status: 'opened' }));
  await act(async () => {
    await Promise.resolve();
    endpoints[0].onmessage?.({
      data: { type: 'TOURNAMENT_TABLE_OPEN_RESULT', payload: { ...pending, status: 'opened' } },
    });
  });
  expect(storedSeen()).toEqual([]);
  expect(h.navigate).not.toHaveBeenCalled();
  act(() =>
    h.setTabs((tabs: any[]) => [
      ...tabs.slice(1),
      { id: pending.tableId, kind: 'table', seated: true },
    ])
  );
  // Capacity alone is not acknowledgment. A new qualified poll gives the local
  // parent a current attempt to confirm its already committed destination.
  await poll();
  await respond(1, [row('destination-A', true)]);
  expect(storedSeen()).toEqual(['destination-A']);
  expect(h.navigate).toHaveBeenCalledExactlyOnceWith('/table/destination-A');
  const last = seated().at(-1)!.payload;
  act(() => a.emit('TOURNAMENT_TABLE_OPEN_RESULT', { ...last, status: 'opened' }));
  expect(h.navigate).toHaveBeenCalledTimes(1);
  expect(
    endpoints
      .flatMap((p) => p.sent)
      .filter(
        (e) =>
          e.type === 'TOURNAMENT_TABLE_OPEN_RESULT' ||
          (e.type === 'TABLE_SEATED' && e.payload.openAttemptId)
      )
  ).toEqual([]);
  offA();
  offB();
});
it('actual bus retains ordinary uncorrelated cross-tab seating and rejects incoming correlated requests', async () => {
  const a = actualBus(),
    b = actualBus();
  const left: any[] = [],
    right: any[] = [];
  const offA = a.subscribe('TABLE_SEATED', (e: any) => left.push(e.payload));
  const offB = b.subscribe('TABLE_SEATED', (e: any) => right.push(e.payload));
  const ordinary = { tableId: 'ordinary', userId: 'actor-A', seat: 2 };
  a.emit('TABLE_SEATED', ordinary);
  await act(async () => {
    await Promise.resolve();
  });
  expect(left).toEqual([ordinary]);
  expect(right).toEqual([ordinary]);
  endpoints[1].onmessage?.({
    data: { type: 'TABLE_SEATED', payload: { ...ordinary, openAttemptId: 'other-page' } },
  });
  expect(right).toEqual([ordinary]);
  expect(endpoints[0].sent).toEqual([{ type: 'TABLE_SEATED', payload: ordinary }]);
  expect(endpoints[1].sent).toEqual([]);
  offA();
  offB();
});
