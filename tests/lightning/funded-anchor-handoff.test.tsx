import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const rpc = vi.hoisted(() => vi.fn());
vi.mock('../../src/lib/supabase', () => ({
  supabase: {
    rpc: (...args: unknown[]) => rpc(...args),
    removeChannel: vi.fn(),
    channel: () => {
      const channel = { on: () => channel, subscribe: () => channel };
      return channel;
    },
  },
}));
vi.mock('../../src/utils/errorReporter', () => ({ reportError: vi.fn() }));
import { useLightningAnchorHandoff } from '../../src/lightning/useLightningAnchorHandoff';
import {
  resetLightningRegistryForTests,
  setLightningEntryIntent,
} from '../../src/lightning/lightningSession';

const ANCHOR = '33333333-3333-4333-8333-333333333333';
const CLUSTER = '22222222-2222-4222-8222-222222222222';
const USER = '77777777-7777-4777-8777-777777777777';
const POOL = '11111111-1111-4111-8111-111111111111';
const source = ts.createSourceFile(
  'TablePage.tsx',
  readFileSync('src/pages/TablePage.tsx', 'utf8'),
  ts.ScriptTarget.Latest,
  true,
  ts.ScriptKind.TSX
);
let fundingSource = '',
  inputSource = '';
function visit(node: ts.Node) {
  if (ts.isCallExpression(node)) {
    if (
      node.expression.getText(source) === 'setLightningAnchorFunding' &&
      node.arguments[0].getText(source).includes('existingSeats')
    )
      fundingSource = node.arguments[0].getText(source);
    if (node.expression.getText(source) === 'useLightningAnchorHandoff')
      inputSource = node.arguments[0].getText(source);
  }
  ts.forEachChild(node, visit);
}
visit(source);
function evaluate(expression: string, values: Record<string, unknown>) {
  const script =
    ts.transpile(`const result = ${expression};`, { target: ts.ScriptTarget.ES2022 }) +
    '\nreturn result;';
  return new Function(...Object.keys(values), script)(...Object.values(values));
}
function consumer(
  rows: unknown[],
  embedded = false,
  fundingOwner = USER,
  observer = false,
  legacyFunded = false,
  departed = false
) {
  const navigate = vi.fn(),
    onTableInfoUpdate = vi.fn();
  const funding = fundingSource
    ? evaluate(fundingSource, { table: { id: ANCHOR }, userId: fundingOwner, existingSeats: rows })
    : undefined;
  const input = evaluate(inputSource, {
    tableId: ANCHOR,
    userId: USER,
    tableState: { clusterId: CLUSTER, heroSeat: 3, players: Array(6).fill(null) },
    lightningRoom: null,
    lightningHero: null,
    lightningObserver: observer,
    lightningAnchorFunded: legacyFunded,
    lightningAnchorFunding: funding,
    leftSeatPendingRef: { current: departed },
    embeddedTableId: embedded ? ANCHOR : undefined,
    navigate,
    onTableInfoUpdate,
  });
  return { input, navigate, onTableInfoUpdate };
}
beforeEach(() => {
  sessionStorage.clear();
  resetLightningRegistryForTests();
  rpc.mockReset();
  rpc.mockResolvedValue({
    data: {
      pool_session_id: POOL,
      state: 'active',
      cluster_mode: 'lightning',
      anchor_table_id: ANCHOR,
      stack: 200,
    },
    error: null,
  });
});
afterEach(cleanup);

it.each([false, true])(
  'a funded anchor with no public hero offers its own room only after explicit View Game (embedded=%s)',
  async (embedded) => {
    const c = consumer([{ user_id: USER, stack: '200', leave_pending: false }], embedded);
    expect(c.input.heroBoughtIn).toBe(false); // The frozen public roster never seats this viewer.
    const { result } = renderHook(() => useLightningAnchorHandoff(c.input));
    await act(async () => {});
    expect(result.current.readyPoolSessionId).toBe(POOL);
    expect(c.navigate).not.toHaveBeenCalled();
    expect(c.onTableInfoUpdate).not.toHaveBeenCalled();
    act(() => result.current.viewReady());
    if (embedded) {
      expect(c.onTableInfoUpdate).toHaveBeenCalledWith({ movedToTableId: POOL });
      expect(c.navigate).not.toHaveBeenCalled();
    } else expect(c.navigate).toHaveBeenCalledWith(`/table/${POOL}`, { replace: true });
  }
);

it.each(
  [
    [],
    [{ user_id: USER, stack: 200, leave_pending: true }],
    [{ user_id: USER, stack: 0, leave_pending: false }],
    [{ user_id: 'somebody-else', stack: 200, leave_pending: false }],
  ].map((rows) => ({ rows }))
)(
  'an empty, leaving, unfunded or other-player anchor does not offer a room (%j)',
  async ({ rows }) => {
    const c = consumer(rows);
    const { result } = renderHook(() => useLightningAnchorHandoff(c.input));
    await act(async () => {});
    expect(result.current.readyPoolSessionId).toBeNull();
    expect(rpc).not.toHaveBeenCalled();
    expect(c.navigate).not.toHaveBeenCalled();
  }
);

it('does not reuse a funded record from another account', async () => {
  const c = consumer([{ user_id: 'previous-account', stack: 200 }], false, 'previous-account');
  const { result } = renderHook(() => useLightningAnchorHandoff(c.input));
  await act(async () => {});
  expect(result.current.readyPoolSessionId).toBeNull();
  expect(rpc).not.toHaveBeenCalled();
});

it('known empty anchor truth refuses conversion even if a stale public roster still calls the viewer a hero', async () => {
  const c = consumer([]);
  c.input.heroBoughtIn = true;
  const { result } = renderHook(() => useLightningAnchorHandoff(c.input));
  await act(async () => {});
  expect(result.current.readyPoolSessionId).toBeNull();
  expect(rpc).not.toHaveBeenCalled();
});

it('a locally confirmed departure overrides an earlier funded anchor lookup', async () => {
  const c = consumer([{ user_id: USER, stack: 200, leave_pending: false }]);
  const input = evaluate(inputSource, {
    tableId: ANCHOR,
    userId: USER,
    tableState: { clusterId: CLUSTER, heroSeat: 0 },
    lightningRoom: null,
    lightningHero: null,
    lightningObserver: false,
    lightningAnchorFunded: false,
    lightningAnchorFunding: { tableId: ANCHOR, userId: USER, funded: true },
    leftSeatPendingRef: { current: true },
    embeddedTableId: undefined,
    navigate: c.navigate,
    onTableInfoUpdate: c.onTableInfoUpdate,
  });
  const { result } = renderHook(() => useLightningAnchorHandoff(input));
  await act(async () => {});
  expect(result.current.readyPoolSessionId).toBeNull();
  expect(rpc).not.toHaveBeenCalled();
});

it('a new observer-anchor purchase completes its original Join intent from scoped funding even before legacy roster restoration', async () => {
  setLightningEntryIntent(ANCHOR, CLUSTER);
  const c = consumer(
    [{ user_id: USER, stack: 200, leave_pending: false }],
    false,
    USER,
    true,
    false
  );
  renderHook(() => useLightningAnchorHandoff(c.input));
  await act(async () => {});
  expect(c.navigate).toHaveBeenCalledWith(`/table/${POOL}`, { replace: true });
});
it.each([
  { rows: [], departed: false },
  { rows: [{ user_id: USER, stack: 200, leave_pending: true }], departed: false },
  { rows: [{ user_id: USER, stack: 200, leave_pending: false }], departed: true },
])(
  'known negative/departed anchor truth cannot fulfill a Join intent from stale legacy funding (%j)',
  async ({ rows, departed }) => {
    setLightningEntryIntent(ANCHOR, CLUSTER);
    const c = consumer(rows, false, USER, true, true, departed);
    renderHook(() => useLightningAnchorHandoff(c.input));
    await act(async () => {});
    expect(c.navigate).not.toHaveBeenCalled();
    expect(rpc).not.toHaveBeenCalled();
  }
);

it('an observer never reuses a previous account record even while the legacy flag remains true', async () => {
  setLightningEntryIntent(ANCHOR, CLUSTER);
  const c = consumer(
    [{ user_id: 'previous-account', stack: 200 }],
    false,
    'previous-account',
    true,
    true
  );
  renderHook(() => useLightningAnchorHandoff(c.input));
  await act(async () => {});
  expect(c.navigate).not.toHaveBeenCalled();
  expect(rpc).not.toHaveBeenCalled();
});
