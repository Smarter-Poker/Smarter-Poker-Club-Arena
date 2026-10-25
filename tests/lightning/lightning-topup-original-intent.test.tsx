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
        tableStateRef: { current: { arenaAsset: 'chips' } },
        userId: 'user',
        tableId: 'pool',
        reportError: vi.fn(),
        toast: { info: vi.fn(), error: vi.fn() },
        lightningRoomRef: { current: { clusterId: 'cluster', poolSessionId: 'pool' } },
        fetchLightningAnchorSeat: vi.fn(async () => ({ anchorTableId: 'anchor' })),
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
