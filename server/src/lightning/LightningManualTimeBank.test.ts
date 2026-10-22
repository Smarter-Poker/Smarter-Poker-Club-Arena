import { afterEach, describe, expect, it, vi } from 'vitest';
vi.mock('../services/supabase/client.js', () => ({ supabase: {}, maintenanceSupabase: {} }));
vi.mock('../services/errorReporter.js', () => ({ reportError: vi.fn() }));
vi.mock('../http/auth.js', () => ({ authenticateRequest: vi.fn() }));
vi.mock('../http/body.js', () => ({ readBody: vi.fn() }));
import { buildHost, formedHand, flush, uid } from '../testing/lightningHostTestKit.js';
import { playerActionContext } from '../engine/PlayerActionContext.js';
import { LightningSeatProxy } from './LightningSeatProxy.js';
import { GameServer } from '../GameServer.js';
import { handleTimebank } from '../handlers/timebank.js';
import { authenticateRequest } from '../http/auth.js';
import { readBody } from '../http/body.js';
import { mockReq, mockRes, parseJson } from '../handlers/_testHelpers.js';

const hosts: any[] = [];
afterEach(async () => {
  for (const h of hosts.splice(0)) await h.abort('test_complete');
  vi.restoreAllMocks();
  vi.useRealTimers();
});

async function ready(rules = {}) {
  const f = formedHand(4, 97000);
  const t = buildHost(f, [100, 100, 100, 100], { rules });
  hosts.push(t.host);
  await t.host.start();
  await flush();
  const h = t.host as any;
  const user = h.turnUser as string;
  expect(user).toBeTruthy();
  const context = playerActionContext(h.hc)!;
  const proxy = new LightningSeatProxy(h.roomOf(user), { hostForRoom: () => h } as any) as any;
  return { ...t, h, user, context, hand: f.handId, proxy };
}

describe('manual Time Bank uses the actual Lightning hand owner', () => {
  it('the authenticated HTTP handler uses the real normal GameServer resolver and proxy', async () => {
    const t = await ready({ time_bank_enabled: false });
    const gs = Object.create(GameServer.prototype) as any;
    gs.tableEngines = new Map();
    gs.lightningRooms = {
      actionEngineFor: (id: string) => (id === t.proxy.roomId ? t.proxy : undefined),
    };
    vi.mocked(authenticateRequest).mockResolvedValue({ userId: t.user } as never);
    vi.mocked(readBody).mockResolvedValue(
      JSON.stringify({
        tableId: t.proxy.roomId,
        handId: t.hand,
        actionContext: t.context,
        userId: 'forged',
      })
    );
    const { res, captured } = mockRes();
    await handleTimebank(mockReq(), res, { gameServer: gs });
    expect(captured.statusCode).toBe(200);
    expect(parseJson(captured)).toMatchObject({ success: true, armed: true });
    expect(t.h.timeBank.isArmed(t.h.timerKey, t.user)).toBe(true);
  });
  it('arms through the real room proxy without spending or extending the clock early', async () => {
    const t = await ready({ time_bank_enabled: false });
    const bank = t.h.timeBank.getPlayerBank(t.h.timerKey, t.user);
    const before = {
      seconds: bank.remainingSeconds,
      uses: bank.usesRemaining,
      start: t.h.turnStartMs,
      duration: t.h.turnDurationSec,
    };
    expect(await t.proxy.activateTimeBank(t.user, t.context, t.hand)).toMatchObject({
      success: true,
      armed: true,
    });
    expect(bank.armed).toBe(true);
    expect({
      seconds: bank.remainingSeconds,
      uses: bank.usesRemaining,
      start: t.h.turnStartMs,
      duration: t.h.turnDurationSec,
    }).toEqual(before);
    expect(t.calls.consumed).toEqual([]);
  });
  it('an exhausted manual request grants one existing countdown and cancels the primary deadline', async () => {
    const t = await ready();
    t.h.turnStartMs = Date.now() - 15000;
    const bank = t.h.timeBank.getPlayerBank(t.h.timerKey, t.user);
    const uses = bank.usesRemaining;
    expect(await t.proxy.activateTimeBank(t.user, t.context, t.hand)).toMatchObject({
      success: true,
    });
    expect(bank.isActive).toBe(true);
    expect(bank.usesRemaining).toBe(uses - 1);
    expect(t.h.timeBankActive).toBe(true);
    expect(t.h.turnDurationSec).toBe(20);
    expect(t.h.timer.getRemainingMs(t.h.timerKey, t.user)).toBe(0);
    expect(t.h.timer.getRemainingMs(t.h.timerKey, `timebank:${t.user}`)).toBeGreaterThan(19000);
    expect(await t.proxy.activateTimeBank(t.user, t.context, t.hand)).toMatchObject({
      success: false,
    });
    expect(bank.usesRemaining).toBe(uses - 1);
  });
  it.each(['foreign', 'hand', 'context', 'missing'])(
    'refuses %s before arming or spending',
    async (why) => {
      const t = await ready();
      const bank = t.h.timeBank.getPlayerBank(t.h.timerKey, t.user);
      expect(
        (
          await t.proxy.activateTimeBank(
            why === 'foreign' ? uid(999) : t.user,
            why === 'context' ? 'old' : why === 'missing' ? undefined : t.context,
            why === 'hand' ? uid(998) : t.hand
          )
        ).success
      ).toBe(false);
      expect(bank.armed).toBe(false);
      expect(bank.isActive).toBe(false);
      expect(t.calls.consumed).toEqual([]);
    }
  );
  it('a delayed Lifetime lookup cannot grant time to a later turn', async () => {
    const t = await ready();
    t.h.timeBank.setUnlimitedActivations(t.h.timerKey, t.user, true);
    let resolve!: (value: Map<string, any>) => void;
    vi.mocked(t.backend.timeBankAllowance).mockImplementationOnce(
      () =>
        new Promise((r) => {
          resolve = r;
        })
    );
    const pending = t.proxy.activateTimeBank(t.user, t.context, t.hand);
    t.h.turnUser = uid(999);
    resolve(new Map([[t.user, { unlimitedActivations: true, extraSeconds: 0 }]]));
    expect(await pending).toMatchObject({ success: false });
    expect(t.h.timeBank.isArmed(t.h.timerKey, t.user)).toBe(false);
    expect(t.calls.consumed).toEqual([]);
  });
  it('the named activation event carries the actual partial allocation rather than a guessed twenty seconds', async () => {
    const t = await ready();
    const bank = t.h.timeBank.getPlayerBank(t.h.timerKey, t.user);
    bank.remainingSeconds = 7;
    t.h.turnStartMs = Date.now() - 15000;
    expect(await t.proxy.activateTimeBank(t.user, t.context, t.hand)).toMatchObject({
      success: true,
    });
    const frames = t.hub.frames.filter(
      (f) => f.kind === 'event' && f.payload.type === 'TIME_BANK_ACTIVATED'
    );
    expect(frames).toHaveLength(4);
    for (const frame of frames)
      expect(frame.payload).toMatchObject({
        playerId: t.user,
        secondsGranted: 7,
        unlimitedActivations: false,
      });
  });
  it('an automatic grant while manual entitlement lookup awaits is not spent twice', async () => {
    const t = await ready();
    t.h.timeBank.setUnlimitedActivations(t.h.timerKey, t.user, true);
    let resolve!: (value: Map<string, any>) => void;
    vi.mocked(t.backend.timeBankAllowance).mockImplementationOnce(
      () =>
        new Promise((r) => {
          resolve = r;
        })
    );
    const pending = t.proxy.activateTimeBank(t.user, t.context, t.hand);
    const bank = t.h.timeBank.getPlayerBank(t.h.timerKey, t.user);
    const uses = bank.usesRemaining;
    t.h.onClockExpired(t.user, t.context);
    resolve(new Map([[t.user, { unlimitedActivations: true, extraSeconds: 0 }]]));
    expect(await pending).toMatchObject({ success: false });
    expect(bank.isActive).toBe(true);
    expect(bank.usesRemaining).toBe(uses - 1);
  });
  it('unknown Lifetime eligibility cannot refill a depleted finite bank', async () => {
    const t = await ready();
    const bank = t.h.timeBank.getPlayerBank(t.h.timerKey, t.user);
    bank.unlimitedActivations = true;
    bank.remainingSeconds = 0;
    bank.usesRemaining = 0;
    vi.mocked(t.backend.timeBankAllowance).mockRejectedValueOnce(new Error('unavailable'));
    expect(await t.proxy.activateTimeBank(t.user, t.context, t.hand)).toMatchObject({
      success: false,
    });
    expect(bank.unlimitedActivations).toBe(false);
    expect(bank.remainingSeconds).toBe(0);
  });
  it('preserves ordinary physical routing without adding Lightning arguments', async () => {
    const activateTimeBank = vi.fn(async () => ({ success: true, armed: true }));
    const gs = Object.create(GameServer.prototype) as any;
    gs.tableEngines = new Map([['cash', { activateTimeBank }]]);
    gs.lightningRooms = { actionEngineFor: vi.fn() };
    vi.mocked(authenticateRequest).mockResolvedValue({ userId: 'cash-user' } as never);
    vi.mocked(readBody).mockResolvedValue(JSON.stringify({ tableId: 'cash' }));
    const { res, captured } = mockRes();
    await handleTimebank(mockReq(), res, { gameServer: gs });
    expect(captured.statusCode).toBe(200);
    expect(activateTimeBank).toHaveBeenCalledTimes(1);
    expect(activateTimeBank).toHaveBeenCalledWith('cash-user');
    expect(gs.lightningRooms.actionEngineFor).not.toHaveBeenCalled();
  });
});
