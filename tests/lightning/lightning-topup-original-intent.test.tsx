import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { sliceMethod } from '../helpers/sourceWindow';
const f = vi.hoisted(() => ({ rpc: vi.fn(), report: vi.fn() }));
vi.mock('../../src/lib/supabase', () => ({ supabase: f }));
vi.mock('../../src/utils/errorReporter', () => ({ reportError: f.report }));
import { useLightningTopUpReceipts } from '../../src/lightning/useLightningTopUpReceipts';
const source = readFileSync('src/pages/TablePage.tsx', 'utf8');
const api = readFileSync('src/services/GameServerAPI.ts', 'utf8');
function compile(text: string, names: string[], values: unknown[], result: string) {
  const js = ts.transpileModule(text, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
  }).outputText;
  return Function(...names, js + `; return ${result};`)(...values);
}
beforeEach(() => vi.clearAllMocks());
describe('manual and automatic Lightning original top-up requests', () => {
  it.each(['manual', 'auto'] as const)(
    '%s traverses the real API/handler without charging a queued intent',
    async (kind) => {
      const http = vi.fn(async () => ({
        ok: true,
        json: async () => ({
          success: true,
          queued: true,
          charged: false,
          requested: 30,
          applied: 0,
          request_id: 'request01',
          occupancy_id: 'occupancy',
          pool_session_id: 'pool',
        }),
      }));
      const realApi = compile(
        sliceMethod(api, 'export async function addChips(').replace('export ', ''),
        ['engineFetch', 'getAuthHeaders', 'GAME_SERVER_URL'],
        [http, async () => ({}), 'https://engine.invalid'],
        'addChips'
      );
      const balance = vi.fn(),
        version = vi.fn(),
        total = { current: 100 },
        rebuys = { current: 2 };
      const values = {
        lightningAddChipsOwnerRef: {
          current: { key: 'user/pool/pool/cluster', generation: 0, mounted: true },
        },
        tableStateRef: { current: { arenaAsset: 'chips' } },
        userId: 'user',
        tableId: 'pool',
        reportError: vi.fn(),
        toast: { info: vi.fn(), error: vi.fn() },
        lightningRoomRef: { current: { clusterId: 'cluster', poolSessionId: 'pool' } },
        fetchLightningAnchorSeat: vi.fn(async () => ({
          anchorTableId: 'anchor',
          occupancyId: 'occupancy',
          seatNumber: 1,
        })),
        GameServerAPI: { addChips: realApi },
        lastAddChipsResultRef: { current: null },
        setLightningBalanceVersion: version,
        applyBalanceDelta: balance,
        totalBuyInRef: total,
        totalRebuysRef: rebuys,
        sessionStatsService: { recordRebuy: vi.fn() },
        tableState: { players: [], heroSeat: 1 },
        peakStackRef: { current: 0 },
        masterBus: { emit: vi.fn() },
        compactChips: String,
        autoTopUpRefusedForHandRef: { current: null },
      };
      const handle = compile(
        sliceMethod(source, 'const handleAddChips = async ('),
        Object.keys(values),
        Object.values(values),
        'handleAddChips'
      );
      expect(await handle(30, 'request01', { source: kind })).toBe(true);
      expect(JSON.parse(http.mock.calls[0][1].body)).toEqual({
        tableId: 'anchor',
        amount: 30,
        opId: 'request01',
      });
      expect(balance).not.toHaveBeenCalled();
      expect(total.current).toBe(100);
      expect(rebuys.current).toBe(2);
      expect(values.sessionStatsService.recordRebuy).not.toHaveBeenCalled();
      expect(values.masterBus.emit).not.toHaveBeenCalled();
      expect(values.toast.info).toHaveBeenCalledWith(
        'Your Lightning Top Up Is Queued. Your Wallet Has Not Been Charged.'
      );
      expect(
        source.includes("handleAddChips(amount, opId, { source: 'manual', onTerminalRefusal })")
      ).toBe(true);
    }
  );
  it('own canonical funding refresh fences a replaced pool and out-of-order read', async () => {
    let first!: (x: unknown) => void;
    const a = new Promise((r) => (first = r));
    f.rpc.mockReturnValueOnce(a).mockResolvedValue({
      data: {
        pool_session_id: 'new',
        user_id: 'user',
        baseline: 80,
        balance: 20,
        applied_count: 1,
        receipts: [],
      },
      error: null,
    });
    const apply = vi.fn(),
      props = {
        ready: true,
        pool: 'old',
        user: 'user',
        event: null as Record<string, unknown> | null,
        version: 0,
        revision: () => 0,
        apply,
      };
    const h = renderHook((p) => useLightningTopUpReceipts(p), { initialProps: props });
    h.rerender({ ...props, pool: 'new' });
    await waitFor(() => expect(apply).toHaveBeenCalledOnce());
    await act(async () =>
      first({
        data: {
          pool_session_id: 'old',
          user_id: 'user',
          baseline: 50,
          balance: 50,
          applied_count: 1,
          receipts: [],
        },
        error: null,
      })
    );
    expect(apply).toHaveBeenCalledTimes(1);
    expect(apply.mock.calls[0][0].baseline).toBe(80);
  });
  it('terminal events refresh cumulative funding; a pending request invents no charge', async () => {
    f.rpc
      .mockResolvedValueOnce({
        data: {
          pool_session_id: 'pool',
          user_id: 'user',
          baseline: 20,
          balance: 100,
          applied_count: 0,
          receipts: [{ status: 'pending', applied: 0 }],
        },
        error: null,
      })
      .mockResolvedValue({
        data: {
          pool_session_id: 'pool',
          user_id: 'user',
          baseline: 50,
          balance: 70,
          applied_count: 1,
          receipts: [{ status: 'applied', applied: 30 }],
        },
        error: null,
      });
    const apply = vi.fn(),
      props = {
        ready: true,
        pool: 'pool',
        user: 'user',
        event: null as Record<string, unknown> | null,
        version: 0,
        revision: () => 4,
        apply,
      };
    const h = renderHook((p) => useLightningTopUpReceipts(p), { initialProps: props });
    await waitFor(() => expect(apply).toHaveBeenCalledOnce());
    expect(apply.mock.calls[0][0].baseline).toBe(20);
    h.rerender({ ...props, event: { type: 'lightning_top_up_completed' } });
    await waitFor(() => expect(apply).toHaveBeenCalledTimes(2));
    expect(apply.mock.calls[1][0].baseline).toBe(50);
    expect(apply.mock.calls[1][1]).toBe(4);
  });
});

describe('the manual cashier retains only an unresolved original request', () => {
  it.each([true, false])(
    'a confirmed terminal refusal releases the original key: %s',
    async (terminal) => {
      const cashier = readFileSync('src/components/table/CashierModal.tsx', 'utf8');
      const ast = ts.createSourceFile(
        'CashierModal.tsx',
        cashier,
        ts.ScriptTarget.Latest,
        true,
        ts.ScriptKind.TSX
      );
      let arrow = '';
      const visit = (node: ts.Node) => {
        if (
          ts.isVariableDeclaration(node) &&
          node.name.getText(ast) === 'handleConfirm' &&
          node.initializer &&
          ts.isCallExpression(node.initializer)
        )
          arrow = node.initializer.arguments[0].getText(ast);
        ts.forEachChild(node, visit);
      };
      visit(ast);
      expect(Boolean(arrow)).toBe(true);
      const id = { current: 'original01' as string | null };
      const values = {
        amount: 30,
        isProcessing: false,
        currentStackPending: false,
        busyRef: { current: false },
        setBusy: vi.fn(),
        setSubmitError: vi.fn(),
        haptic: { medium: vi.fn() },
        opIdRef: id,
        uuid: () => 'new-original',
        onAddChips: async (_amount: number, _id: string, settled: () => void) => {
          if (terminal) settled();
          return false;
        },
        setAmount: vi.fn(),
        onClose: vi.fn(),
        reportError: vi.fn(),
        safeErrorMessage: String,
      };
      const confirm = compile(
        `const confirm = ${arrow}`,
        Object.keys(values),
        Object.values(values),
        'confirm'
      );
      await confirm();
      expect(id.current).toBe(terminal ? null : 'original01');
      expect(values.onClose).not.toHaveBeenCalled();
    }
  );
  it('the actual API recognizes only an original, uncharged terminal refusal', async () => {
    const http = vi.fn(async () => ({
      ok: false,
      status: 400,
      json: async () => ({
        error: 'Insufficient Funds',
        status: 'refused',
        request_id: 'original01',
        charged: false,
        queued: false,
        applied: 0,
      }),
    }));
    const add = compile(
      sliceMethod(api, 'export async function addChips(').replace('export ', ''),
      ['engineFetch', 'getAuthHeaders', 'GAME_SERVER_URL'],
      [http, async () => ({}), 'https://engine.invalid'],
      'addChips'
    );
    expect(await add('anchor', 30, 'original01')).toMatchObject({
      code: 'LIGHTNING_TOP_UP_TERMINAL_REFUSAL',
      request_id: 'original01',
    });
    expect((await add('anchor', 30, 'different')).code).toBeUndefined();
  });
});

describe('receipt RPC rollout compatibility', () => {
  it('does not query on the old engine, then reads when capability arrives and on reconnect', async () => {
    f.rpc.mockResolvedValue({
      data: {
        pool_session_id: 'pool',
        user_id: 'user',
        baseline: 50,
        balance: 70,
        applied_count: 1,
        receipts: [],
      },
      error: null,
    });
    const apply = vi.fn();
    const props = {
      pool: 'pool',
      user: 'user',
      event: null as Record<string, unknown> | null,
      version: 0,
      connection: 'connected',
      ready: undefined as boolean | undefined,
      revision: () => 0,
      apply,
    };
    const h = renderHook((p) => useLightningTopUpReceipts(p), { initialProps: props });
    await act(async () => {});
    expect(f.rpc).not.toHaveBeenCalled();
    h.rerender({ ...props, version: 1, event: { type: 'hand_history_saved' } });
    await act(async () => {});
    expect(f.rpc).not.toHaveBeenCalled();
    h.rerender({ ...props, ready: true });
    await waitFor(() => expect(apply).toHaveBeenCalledOnce());
    expect(f.rpc).toHaveBeenCalledWith('fn_lightning_top_up_receipts', {
      p_pool_session_id: 'pool',
    });
    h.rerender({ ...props, ready: false, connection: 'reconnecting' });
    h.rerender({ ...props, ready: false });
    await act(async () => {});
    expect(f.rpc).toHaveBeenCalledTimes(1);
    h.rerender({ ...props, ready: true });
    await waitFor(() => expect(apply).toHaveBeenCalledTimes(2));
    expect(source.includes('ready: lightningOriginalTopUpReady')).toBe(true);
  });
  it('ignores a receipt read that finishes after the capability is lost', async () => {
    let finish!: (v: unknown) => void;
    f.rpc.mockReturnValue(
      new Promise((resolve) => {
        finish = resolve;
      })
    );
    const apply = vi.fn(),
      props = {
        pool: 'pool',
        user: 'user',
        event: null,
        version: 0,
        ready: true,
        revision: () => 0,
        apply,
      };
    const h = renderHook((p) => useLightningTopUpReceipts(p), { initialProps: props });
    h.rerender({ ...props, ready: false });
    await act(async () =>
      finish({
        data: {
          pool_session_id: 'pool',
          user_id: 'user',
          baseline: 50,
          balance: 70,
          applied_count: 1,
          receipts: [],
        },
        error: null,
      })
    );
    expect(apply).not.toHaveBeenCalled();
  });
});

describe('a Lightning unknown outcome survives the HTTP adapter', () => {
  it('keeps 400 TRANSPORT unknown through the actual API and caller, without releasing the original key', async () => {
    const http = vi.fn(async () => ({
      ok: false,
      status: 400,
      json: async () => ({
        success: false,
        error: 'Unable To Verify This Top Up. Check Your Stack Before Trying Again.',
        code: 'TRANSPORT',
      }),
    }));
    const realApi = compile(
      sliceMethod(api, 'export async function addChips(').replace('export ', ''),
      ['engineFetch', 'getAuthHeaders', 'GAME_SERVER_URL'],
      [http, async () => ({}), 'https://engine.invalid'],
      'addChips'
    );
    expect(await realApi('anchor', 30, 'original01')).toMatchObject({
      success: false,
      code: 'TRANSPORT',
    });
    const release = vi.fn(),
      balance = vi.fn();
    const values = {
      lightningAddChipsOwnerRef: {
        current: { key: 'user/pool/pool/cluster', generation: 0, mounted: true },
      },
      tableStateRef: { current: { arenaAsset: 'chips' } },
      userId: 'user',
      tableId: 'pool',
      reportError: vi.fn(),
      toast: { info: vi.fn(), error: vi.fn() },
      lightningRoomRef: { current: { clusterId: 'cluster', poolSessionId: 'pool' } },
      fetchLightningAnchorSeat: async () => ({ anchorTableId: 'anchor' }),
      GameServerAPI: { addChips: realApi },
      applyBalanceDelta: balance,
    };
    const handle = compile(
      sliceMethod(source, 'const handleAddChips = async ('),
      Object.keys(values),
      Object.values(values),
      'handleAddChips'
    );
    expect(await handle(30, 'original01', { source: 'manual', onTerminalRefusal: release })).toBe(
      false
    );
    expect(release).not.toHaveBeenCalled();
    expect(balance).not.toHaveBeenCalled();
    expect(values.toast.error).toHaveBeenCalledWith(
      'The Connection Dropped Before The Table Answered. Your Chips May Have Been Added. Check Your Stack Before Trying Again.'
    );
    expect(http.mock.calls.map((call) => JSON.parse(call[1].body).opId)).toEqual([
      'original01',
      'original01',
    ]);
  });
});

describe('a completed queue refreshes the waiting hero exactly once', () => {
  it('uses the actual TablePage canonical callback for pending, completion, replay and reconnect', () => {
    const ast = ts.createSourceFile(
      'TablePage.tsx',
      source,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TSX
    );
    let arrow = '';
    const visit = (node: ts.Node) => {
      if (
        ts.isCallExpression(node) &&
        node.expression.getText(ast) === 'useLightningTopUpReceipts'
      ) {
        const arg = node.arguments[0];
        if (ts.isObjectLiteralExpression(arg)) {
          const prop = arg.properties.find(
            (p) => ts.isPropertyAssignment(p) && p.name.getText(ast) === 'apply'
          );
          if (prop && ts.isPropertyAssignment(prop)) arrow = prop.initializer.getText(ast);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(ast);
    expect(Boolean(arrow)).toBe(true);
    const count = { current: { pool: null as string | null, count: 0 } },
      version = { current: 0 },
      revision = { current: 4 };
    const values = {
      balanceRevisionRef: revision,
      readBalanceRevision: () => revision.current,
      setBalanceIfCurrent: vi.fn(),
      totalBuyInRef: { current: 20 },
      lightningTopUpCountRef: count,
      totalRebuysRef: { current: 0 },
      tableId: 'pool',
      sessionStatsService: { restoreFunding: vi.fn() },
      setLightningBalanceVersion: vi.fn((next: (v: number) => number) => {
        version.current = next(version.current);
      }),
    };
    const apply = compile(
      `const apply = ${arrow}`,
      Object.keys(values),
      Object.values(values),
      'apply'
    );
    const funding = { pool_session_id: 'pool', balance: 100, baseline: 20, applied_count: 0 };
    apply(funding, 4); // accepted queue: the waiting stack has not changed
    expect(version.current).toBe(0);
    apply({ ...funding, balance: 70, baseline: 50, applied_count: 1 }, 4);
    expect(version.current).toBe(1); // waiting-session reader is invalidated after actual funding
    apply({ ...funding, balance: 70, baseline: 50, applied_count: 1 }, 5);
    expect(version.current).toBe(1); // replay and follow-up read cannot loop
    expect(values.totalRebuysRef.current).toBe(1);
    count.current = { pool: null, count: 0 }; // new mount / reconnect with canonical completed count
    apply({ ...funding, balance: 70, baseline: 50, applied_count: 1 }, 5);
    expect(version.current).toBe(2);
    apply({ ...funding, applied_count: 2 }, 3); // a newer balance mutation won
    expect(version.current).toBe(2);
  });
});

describe('canonical Lightning receipts cannot replace a newer wallet event', () => {
  it('executes the real wallet-event and canonical-funding callbacks across a delayed receipt', async () => {
    const ast = ts.createSourceFile(
      'TablePage.tsx',
      source,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TSX
    );
    let walletArrow = '',
      fundingArrow = '';
    const visit = (node: ts.Node) => {
      if (ts.isCallExpression(node)) {
        if (
          node.expression.getText(ast) === 'useMasterBusSubscription' &&
          ts.isStringLiteral(node.arguments[0]) &&
          node.arguments[0].text === 'BALANCE_UPDATED'
        )
          walletArrow = node.arguments[1].getText(ast);
        if (
          node.expression.getText(ast) === 'useLightningTopUpReceipts' &&
          ts.isObjectLiteralExpression(node.arguments[0])
        ) {
          const prop = node.arguments[0].properties.find(
            (p) => ts.isPropertyAssignment(p) && p.name.getText(ast) === 'apply'
          );
          if (prop && ts.isPropertyAssignment(prop)) fundingArrow = prop.initializer.getText(ast);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(ast);
    expect(Boolean(walletArrow && fundingArrow)).toBe(true);
    const revision = { current: 4 },
      wallet = { current: 100 };
    const values = {
      tableState: { arenaAsset: 'chips' },
      userId: 'user',
      balanceRevisionRef: revision,
      lightningRoomRef: { current: { poolSessionId: 'pool' } },
      setAccountBalance: (value: number) => {
        wallet.current = value;
      },
      readBalanceRevision: () => revision.current,
      setBalanceIfCurrent: vi.fn(),
      totalBuyInRef: { current: 20 },
      lightningTopUpCountRef: { current: { pool: 'pool', count: 0 } },
      totalRebuysRef: { current: 0 },
      tableId: 'pool',
      sessionStatsService: { restoreFunding: vi.fn() },
      setLightningBalanceVersion: vi.fn(),
    };
    const funding = compile(
      `const apply = ${fundingArrow}`,
      Object.keys(values),
      Object.values(values),
      'apply'
    );
    const event = compile(
      `const receive = ${walletArrow}`,
      Object.keys(values),
      Object.values(values),
      'receive'
    );
    let finish!: (v: unknown) => void;
    f.rpc.mockReturnValue(
      new Promise((resolve) => {
        finish = resolve;
      })
    );
    const props = {
      pool: 'pool',
      user: 'user',
      ready: true,
      event: null,
      version: 0,
      revision: values.readBalanceRevision,
      apply: funding,
    };
    const hook = renderHook((p) => useLightningTopUpReceipts(p), { initialProps: props });
    event({ userId: 'user', balance: 70 });
    expect(revision.current).toBe(5);
    await act(async () =>
      finish({
        data: {
          pool_session_id: 'pool',
          user_id: 'user',
          baseline: 50,
          balance: 100,
          applied_count: 1,
          receipts: [],
        },
        error: null,
      })
    );
    expect(wallet.current).toBe(70);
    expect(values.setBalanceIfCurrent).not.toHaveBeenCalled();
    expect(values.totalBuyInRef.current).toBe(20);
    expect(values.setLightningBalanceVersion).toHaveBeenCalledOnce();
    f.rpc.mockResolvedValue({
      data: {
        pool_session_id: 'pool',
        user_id: 'user',
        baseline: 50,
        balance: 70,
        applied_count: 1,
        receipts: [],
      },
      error: null,
    });
    hook.rerender({ ...props, version: 1 });
    await waitFor(() => expect(values.totalBuyInRef.current).toBe(50));
    expect(values.lightningTopUpCountRef.current.count).toBe(1);
    expect(values.setBalanceIfCurrent).toHaveBeenCalledWith(5, 70);
    expect(values.setLightningBalanceVersion).toHaveBeenCalledTimes(2); // wallet event, then one actual stack completion
    expect(wallet.current).toBe(70);
    expect(revision.current).toBe(6); // stale ordinary pre-purchase reads are invalid now too
  });
  it('keeps a 503 unknown response unknown for the current API and old client contract', async () => {
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const http = vi.fn(async () => ({
        ok: false,
        status: 503,
        json: async () => ({
          success: false,
          error: 'Top Up Outcome Unknown',
          code: 'TRANSPORT',
        }),
      }));
      const add = compile(
        sliceMethod(api, 'export async function addChips(').replace('export ', ''),
        ['engineFetch', 'getAuthHeaders', 'GAME_SERVER_URL'],
        [http, async () => ({}), 'https://engine.invalid'],
        'addChips'
      );
      expect(await add('anchor', 30, 'original01')).toMatchObject({
        success: false,
        code: 'TRANSPORT',
      });
      expect(JSON.parse(http.mock.calls[0][1].body).opId).toBe('original01');
    } finally {
      errorLog.mockRestore();
    }
  });
});

describe('a delayed manual Lightning response belongs to its original custody', () => {
  it.each(
    ['queued', 'applied'].flatMap((status) =>
      ['auth', 'pool', 'occupancy', 'unmount'].map((change) => ({ status, change }))
    )
  )(
    'ignores $status after $change without ordinary accounting or closing a new cashier',
    async ({ status, change }) => {
      let finish!: (v: unknown) => void;
      const owner = { current: { key: 'user/pool/pool/cluster', generation: 0, mounted: true } };
      const room = {
        current: { clusterId: 'cluster', poolSessionId: 'pool' } as {
          clusterId: string;
          poolSessionId: string;
        } | null,
      };
      const anchor = { anchorTableId: 'anchor', seatNumber: 1, occupancyId: 'old' };
      const add = vi.fn(
        () =>
          new Promise((resolve) => {
            finish = resolve;
          })
      );
      const read = vi
        .fn()
        .mockResolvedValueOnce(anchor)
        .mockResolvedValue({ ...anchor, occupancyId: change === 'occupancy' ? 'new' : 'old' });
      const values = {
        lightningAddChipsOwnerRef: owner,
        lightningRoomRef: room,
        tableStateRef: { current: { arenaAsset: 'chips' } },
        userId: 'user',
        tableId: 'pool',
        reportError: vi.fn(),
        toast: { info: vi.fn(), error: vi.fn() },
        fetchLightningAnchorSeat: read,
        GameServerAPI: { addChips: add },
        applyBalanceDelta: vi.fn(),
        setLightningBalanceVersion: vi.fn(),
        totalBuyInRef: { current: 20 },
        totalRebuysRef: { current: 0 },
        lastAddChipsResultRef: { current: null },
      };
      const handle = compile(
        sliceMethod(source, 'const handleAddChips = async ('),
        Object.keys(values),
        Object.values(values),
        'handleAddChips'
      );
      const release = vi.fn();
      const pending = handle(30, 'original01', { source: 'manual', onTerminalRefusal: release });
      await waitFor(() => expect(add).toHaveBeenCalledOnce());
      if (change === 'auth' || change === 'pool') {
        owner.current.key = 'changed-scope';
        owner.current.generation++;
        room.current = null;
      } else if (change === 'unmount') {
        const ast = ts.createSourceFile(
          'TablePage.tsx',
          source,
          ts.ScriptTarget.Latest,
          true,
          ts.ScriptKind.TSX
        );
        let effect = '';
        const visit = (node: ts.Node) => {
          if (
            ts.isCallExpression(node) &&
            node.expression.getText(ast) === 'useEffect' &&
            node.arguments[0]
              ?.getText(ast)
              .includes('lightningAddChipsOwnerRef.current.mounted = false')
          )
            effect = node.arguments[0].getText(ast);
          ts.forEachChild(node, visit);
        };
        visit(ast);
        const mount = compile(
          `const mount = ${effect}`,
          ['lightningAddChipsOwnerRef'],
          [owner],
          'mount'
        );
        mount()(); // actual effect mount and cleanup
      }
      finish({
        success: true,
        queued: status === 'queued',
        charged: status === 'applied',
        applied: status === 'applied' ? 30 : 0,
        requested: 30,
        request_id: 'original01',
      });
      expect(await pending).toBe(false); // caller keeps the new cashier open
      expect(release).not.toHaveBeenCalled();
      expect(values.applyBalanceDelta).not.toHaveBeenCalled();
      expect(values.setLightningBalanceVersion).not.toHaveBeenCalled();
      expect(values.toast.info).not.toHaveBeenCalled();
      expect(values.toast.error).not.toHaveBeenCalled();
      expect(values.totalBuyInRef.current).toBe(20);
      expect(values.totalRebuysRef.current).toBe(0);
      expect(add.mock.calls[0]).toEqual(['anchor', 30, 'original01']);
    }
  );
});

describe('the original receipt carries its own pool and occupancy through the API', () => {
  it.each(['same', 'pool', 'occupancy'])(
    'replaying an applied original purchase with %s custody cannot fabricate a new purchase',
    async (change) => {
      const http = vi.fn(async () => ({
        ok: true,
        json: async () => ({
          success: true,
          queued: false,
          charged: true,
          applied: 30,
          requested: 30,
          request_id: 'original01',
          pool_session_id: change === 'pool' ? 'old-pool' : 'pool',
          occupancy_id: change === 'occupancy' ? 'old-occupancy' : 'current-occupancy',
        }),
      }));
      const add = compile(
        sliceMethod(api, 'export async function addChips(').replace('export ', ''),
        ['engineFetch', 'getAuthHeaders', 'GAME_SERVER_URL'],
        [http, async () => ({}), 'https://engine.invalid'],
        'addChips'
      );
      const release = vi.fn(),
        values = {
          lightningAddChipsOwnerRef: {
            current: { key: 'user/pool/pool/cluster', generation: 0, mounted: true },
          },
          lightningRoomRef: { current: { clusterId: 'cluster', poolSessionId: 'pool' } },
          tableStateRef: { current: { arenaAsset: 'chips' } },
          userId: 'user',
          tableId: 'pool',
          reportError: vi.fn(),
          toast: { info: vi.fn(), error: vi.fn() },
          fetchLightningAnchorSeat: async () => ({
            anchorTableId: 'anchor',
            seatNumber: 1,
            occupancyId: 'current-occupancy',
          }),
          GameServerAPI: { addChips: add },
          applyBalanceDelta: vi.fn(),
          setLightningBalanceVersion: vi.fn(),
          totalBuyInRef: { current: 20 },
          totalRebuysRef: { current: 0 },
          lastAddChipsResultRef: { current: null },
        };
      const handle = compile(
        sliceMethod(source, 'const handleAddChips = async ('),
        Object.keys(values),
        Object.values(values),
        'handleAddChips'
      );
      const opts = { source: 'manual', onTerminalRefusal: release };
      expect(await handle(30, 'original01', opts)).toBe(change === 'same');
      if (change === 'same') {
        expect(await handle(30, 'original01', opts)).toBe(true);
        expect(http.mock.calls.map((call) => JSON.parse(call[1].body).opId)).toEqual([
          'original01',
          'original01',
        ]);
        expect(release).not.toHaveBeenCalled();
      } else {
        expect(release).toHaveBeenCalledOnce(); // old key is definitively complete, never uncertain
        expect(values.setLightningBalanceVersion).not.toHaveBeenCalled();
      }
      expect(values.applyBalanceDelta).not.toHaveBeenCalled();
      expect(values.totalBuyInRef.current).toBe(20);
      expect(values.totalRebuysRef.current).toBe(0);
    }
  );
});
