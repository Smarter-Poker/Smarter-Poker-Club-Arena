import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { submitTableDecision } from '../../src/lib/tableActionDecision';

const page = readFileSync(resolve(__dirname, '../../src/pages/TablePage.tsx'), 'utf8');

describe('Mongo missing decision recovery', () => {
  it('the page submits the decision visible at the tap, rather than a render closure', () => {
    expect(page).toContain('actionContext: tableStateRef.current.actionContext');
    expect(page).toContain('await submitTableDecision({');
    expect(page).not.toContain('submitAction(tid, uid, action, amount, tableState.actionContext)');
  });
  it('does not send a context-free Classic fold and requests state exactly once', async () => {
    const send = vi.fn();
    const refresh = vi.fn(async () => {});
    const result = await submitTableDecision({
      actionContext: undefined,
      allowContextless: false,
      send,
      refresh,
    });
    expect(send).not.toHaveBeenCalled();
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(result.success).toBe(false);
    expect(result.error).not.toMatch(/reload/i);
  });
  it.each([
    'ACTION_CONTEXT_REQUIRED',
    'STALE_ACTION',
    'ACTION_NOT_DELIVERED',
    'ACTION_STATE_PENDING',
  ])('refreshes a %s refusal without replaying the choice', async (code) => {
    const send = vi.fn(async () => ({ success: false, code, error: 'refused' }));
    const refresh = vi.fn(async () => {});
    expect(
      (
        await submitTableDecision({
          actionContext: 'turn:1',
          allowContextless: false,
          send,
          refresh,
        })
      ).success
    ).toBe(false);
    expect(send).toHaveBeenCalledExactlyOnceWith('turn:1');
    expect(refresh).toHaveBeenCalledTimes(1);
  });
  it('preserves the contextless Lightning path and successful actions', async () => {
    const send = vi.fn(async () => ({ success: true }));
    const refresh = vi.fn(async () => {});
    expect(
      await submitTableDecision({ actionContext: undefined, allowContextless: true, send, refresh })
    ).toEqual({ success: true });
    expect(send).toHaveBeenCalledExactlyOnceWith(undefined);
    expect(refresh).not.toHaveBeenCalled();
  });
  it('keeps ordinary rejection details without requesting another state', async () => {
    const result = {
      success: false,
      code: 'MIN_RAISE',
      error: 'Raise is below the minimum',
      hint: { minRaise: 20 },
    };
    const refresh = vi.fn(async () => {});
    expect(
      await submitTableDecision({
        actionContext: 'turn:1',
        allowContextless: false,
        send: async () => result,
        refresh,
      })
    ).toBe(result);
    expect(refresh).not.toHaveBeenCalled();
  });
});
