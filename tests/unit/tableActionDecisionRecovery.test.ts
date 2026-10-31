import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { submitTableDecision, tableDecisionIsReady } from '../../src/lib/tableActionDecision';

const page = readFileSync(resolve(__dirname, '../../src/pages/TablePage.tsx'), 'utf8');

describe('Mongo missing decision recovery', () => {
  it('a stale hero refreshes once without posting or replaying the bet', async () => {
    const send = vi.fn();
    const refresh = vi.fn(async () => true);
    const result = await submitTableDecision({
      actionContext: 'turn:1',
      allowContextless: false,
      clientStateStale: true,
      send,
      refresh,
    });
    expect(send).not.toHaveBeenCalled();
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ success: false, code: 'CLIENT_DECISION_REFRESHED' });
    expect(result.error).toContain('Not Sent');
  });

  it('the page submits the decision visible at the tap, rather than a render closure', () => {
    expect(page).toContain('actionContext: tableStateRef.current.actionContext');
    expect(page).toContain('await submitTableDecision({');
    expect(page).not.toContain('submitAction(tid, uid, action, amount, tableState.actionContext)');
  });
  it('checks missing-token input before optimistic paint can hide its refreshed turn', () => {
    const panel = page.slice(page.indexOf('const handleActionPanelAction = useCallback('));
    const guard = panel.search(/if\s*\(\s*!tableDecisionIsReady\(\{/);
    expect(guard).toBeGreaterThan(0);
    expect(panel.indexOf('finally {', guard)).toBeLessThan(panel.indexOf('setTimeout('));
    expect(panel.indexOf('actionLockRef.current = false;', guard)).toBeLessThan(
      panel.indexOf('setTimeout(')
    );
    expect(panel.indexOf("'panel-missing-decision'")).toBeGreaterThan(guard);
    expect(panel.indexOf("'panel-missing-decision'")).toBeLessThan(
      panel.indexOf("applyOptimisticHeroAction('fold')")
    );
  });
  it('does not send a context-free Classic fold and requests state exactly once', async () => {
    const send = vi.fn();
    const refresh = vi.fn(async () => true);
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
    'ACTION_NOT_ACCEPTED',
  ])('refreshes a %s refusal without replaying the choice', async (code) => {
    const send = vi.fn(async () => ({ success: false, code, error: 'refused' }));
    const refresh = vi.fn(async () => true);
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
    const refresh = vi.fn(async () => true);
    expect(
      await submitTableDecision({ actionContext: undefined, allowContextless: true, send, refresh })
    ).toEqual({ success: true });
    expect(send).toHaveBeenCalledExactlyOnceWith(undefined);
    expect(refresh).not.toHaveBeenCalled();
  });
  it('a lost accepted bet with no snapshot stays explicitly unconfirmed, never a refusal', async () => {
    const send = vi.fn(async () => ({ success: false, code: 'ACTION_NOT_DELIVERED' }));
    const result = await submitTableDecision({
      actionContext: 'turn:1',
      allowContextless: false,
      send,
      refresh: async () => false,
    });
    expect(send).toHaveBeenCalledExactlyOnceWith('turn:1');
    expect(result).toMatchObject({ success: false, outcomeUnconfirmed: true });
    const panel = page.slice(
      page.indexOf('const handleActionPanelAction = useCallback('),
      page.indexOf('// handleConfirmRaise was removed')
    );
    expect(panel.match(/if \(ok === false\) revert\(\);/g)).toHaveLength(5);
    expect(page).toContain('return res.outcomeUnconfirmed ? null : false;');
    expect(page).toMatch(/error: res.outcomeUnconfirmed\s*\? ACTION_NOT_DELIVERED_MESSAGE/);
  });

  it('keeps ordinary rejection details without requesting another state', async () => {
    const result = {
      success: false,
      code: 'MIN_RAISE',
      error: 'Raise is below the minimum',
      hint: { minRaise: 20 },
    };
    const refresh = vi.fn(async () => true);
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

describe('authoritative decision readiness', () => {
  it('withholds Classic controls and submission together, then accepts only a fresh explicit tap', async () => {
    const send = vi.fn(async () => ({ success: true }));
    const refresh = vi.fn(async () => true);
    const withheld = { actionContext: undefined, allowContextless: false };
    expect(tableDecisionIsReady(withheld)).toBe(false);
    expect(await submitTableDecision({ ...withheld, send, refresh })).toMatchObject({
      code: 'CLIENT_DECISION_REFRESHED',
    });
    expect(send).not.toHaveBeenCalled();
    const ready = { ...withheld, actionContext: 'incarnation:preflop:0:4:20' };
    expect(tableDecisionIsReady(ready)).toBe(true);
    // Receiving readiness never submits the previously refused choice.
    expect(send).not.toHaveBeenCalled();
    await submitTableDecision({ ...ready, send, refresh });
    expect(send).toHaveBeenCalledExactlyOnceWith(ready.actionContext);
  });

  it('shares readiness across the actual panel, keyboard and submit paths without stopping the clock', () => {
    expect(page).toContain('const heroDecisionReady = tableDecisionIsReady({');
    expect(page).toContain('isHeroTurn: isHeroTurnContext && heroDecisionReady');
    expect(page).toMatch(/tableState\.isHandInProgress &&\s+heroDecisionReady &&/);
    const timer = page.slice(
      page.indexOf('const { clock: actionClock'),
      page.indexOf('const { clock: actionClock') + 1600
    );
    expect(timer).toContain('isHeroTurn: isHeroTurnContext,');
    expect(timer).not.toContain('heroDecisionReady');
    expect(page).toContain(
      'const heroPromptedToAct = isHeroTurnContext && !suppressPanelForPreAction;'
    );
  });

  it('never turns a stale hero into ready input, and preserves the existing Lightning contract', () => {
    expect(
      tableDecisionIsReady({
        actionContext: 'old-hand-token',
        allowContextless: false,
        clientStateStale: true,
      })
    ).toBe(false);
    expect(tableDecisionIsReady({ actionContext: undefined, allowContextless: true })).toBe(true);
    expect(
      tableDecisionIsReady({
        actionContext: undefined,
        allowContextless: true,
        clientStateStale: true,
      })
    ).toBe(false);
    // The actual actor/hand gate remains independent; a valid token alone never grants a turn.
    const gate = page.match(/const isHeroTurnContext =([\s\S]*?);/)?.[1];
    expect(gate).toBeTruthy();
    const isTurn = new Function('tableState', 'return (' + gate + ')');
    expect(isTurn({ heroSeat: 4, currentPlayerSeat: 2, isHandInProgress: true })).toBe(false);
    expect(isTurn({ heroSeat: 4, currentPlayerSeat: 4, isHandInProgress: false })).toBe(false);
  });
});
