import { afterEach, describe, expect, it, vi } from 'vitest';
vi.mock('./http/auth.js', () => ({ authenticateRequest: vi.fn() }));
vi.mock('./http/body.js', () => ({ readBody: vi.fn() }));
vi.mock('./http/rateLimit.js', () => ({ checkRateLimit: vi.fn(() => true) }));
import { GameServer } from './GameServer.js';
import { ServerTableEngine } from './engine/ServerTableEngine.js';
import { HandController } from './engine/HandController.js';
import type { HandConfig, SeatPlayer } from './types.js';
import { handleAction } from './handlers/action.js';
import { authenticateRequest } from './http/auth.js';
import { readBody } from './http/body.js';
import { mockReq, mockRes, parseJson } from './handlers/_testHelpers.js';
import {
  isMaintenanceFrozen,
  setMaintenanceFrozen,
  setWeeklyPayoutFrozen,
} from './maintenance/freezeState.js';

const token = 'cae00000-0000-0000-0000-000000000032';
const boundary = {
  runId: 'cae00000-0000-0000-0000-000000000031',
  ownershipToken: token,
  scopeKind: 'global' as const,
  scopeId: 'cae00000-0000-0000-0000-000000000031',
  periodStart: '2026-10-26T07:00:00Z',
  periodEnd: '2026-11-02T08:00:00Z',
  announcedAt: Date.parse('2026-11-02T09:58:00Z'),
  moneyStartsAt: Date.parse('2026-11-02T10:00:00Z'),
  moneyDeadlineAt: Date.parse('2026-11-02T10:04:00Z'),
  expiresAt: Date.parse('2026-11-02T10:05:00Z'),
  phase: 'draining' as const,
};
afterEach(() => {
  setWeeklyPayoutFrozen(token, null);
  setMaintenanceFrozen(false);
  vi.restoreAllMocks();
  vi.clearAllTimers();
  vi.useRealTimers();
});
function wired() {
  vi.useFakeTimers();
  vi.setSystemTime(boundary.announcedAt);
  const server = new GameServer() as any;
  const engine = new ServerTableEngine('weekly-game-server-wiring') as any;
  const players = [1, 2].map((seat) => ({
    seat,
    user_id: `p${seat}`,
    username: `P${seat}`,
    stack: 100,
    bet: 0,
    totalInvested: 0,
    cards: [],
    is_folded: false,
    is_all_in: false,
    is_sitting_out: false,
  })) as SeatPlayer[];
  const hand = new HandController(
    {
      tableId: 'weekly-game-server-wiring',
      handNumber: 1,
      gameVariant: 'nlh',
      smallBlind: 1,
      bigBlind: 2,
      rakeConfig: { percent: 0, cap: 0, noFlopNoDrop: true },
    } as HandConfig,
    players,
    1
  );
  hand.start();
  engine.running = true;
  expect(engine.claimProcessOwnership()).toBe(true);
  engine.handController = hand;
  engine.weeklyPayoutStartedController = hand;
  engine.turnFSM.transition('timer_running');
  engine.broadcastCurrentState = vi.fn(async () => {});
  server.tableEngines.set('weekly-game-server-wiring', engine);
  vi.spyOn(server.weeklyPayoutStore.clock, 'now').mockImplementation(() => Date.now());
  const admit = vi
    .spyOn(server.weeklyPayoutStore, 'admit')
    .mockImplementation(async () => ({ ...boundary, phase: 'ready' }));
  server.adoptWeeklyPayout(engine);
  return { server, engine, hand, admit };
}
async function retire(server: any, engine: any) {
  server.weeklyPayoutPause.stop();
  setWeeklyPayoutFrozen(token, null);
  await engine.stop();
}
describe('the actual GameServer weekly drain is independent of daily maintenance', () => {
  it('accepts an HTTP action during announcement and ACKs at four with inactive maintenance', async () => {
    const { server, engine, hand, admit } = wired();
    try {
      expect(server.maintenanceBreak.isActive()).toBe(false);
      server.weeklyPayoutPause.accept(boundary);
      expect(isMaintenanceFrozen()).toBe(true); // sweeps stand down at announcement
      const actor = hand
        .getState()
        .players.find((p) => p.seat === hand.getState().currentPlayerSeat)!;
      vi.mocked(authenticateRequest).mockResolvedValue({ userId: actor.user_id });
      vi.mocked(readBody).mockResolvedValue(
        JSON.stringify({
          tableId: 'weekly-game-server-wiring',
          action: 'call',
          actionContext: engine.getActionContext(),
        })
      );
      const { res, captured } = mockRes();
      await handleAction(mockReq(), res, { gameServer: server });
      expect(parseJson(captured)).toMatchObject({ success: true });
      expect(admit).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(120000);
      expect(server.maintenanceBreak.isActive()).toBe(false);
      expect(admit).toHaveBeenCalledTimes(1);
      expect(engine.handlePlayerAction('p1', 'fold').code).toBe('WEEKLY_ACCOUNTING_PAUSED');
      expect(server.maintenanceBreak.readyForRestart()).toBe(false);
    } finally {
      await retire(server, engine);
    }
  });
  it('retains F06 and stopped-bank refusals without any daily maintenance owner', async () => {
    const { server, engine, admit } = wired();
    try {
      engine.f06CurrentPermit = { recoveryState: () => 'reserved' };
      server.weeklyPayoutPause.accept(boundary);
      await vi.advanceTimersByTimeAsync(120000);
      expect(admit).not.toHaveBeenCalled();
      engine.f06CurrentPermit = null;
      engine.running = false;
      const stopped = vi.spyOn(engine, 'hasUnretiredStoppedTimeBankCustody').mockReturnValue(true);
      await server.weeklyPayoutPause.handBoundary();
      expect(admit).not.toHaveBeenCalled();
      stopped.mockReturnValue(false);
      engine.running = true;
      await server.weeklyPayoutPause.handBoundary();
      expect(admit).toHaveBeenCalledTimes(1);
    } finally {
      engine.f06CurrentPermit = null;
      await retire(server, engine);
    }
  });
  it('still requires durable proof from an overlapping active maintenance owner', async () => {
    const { server, engine, admit } = wired();
    try {
      server.maintenanceBreak.phase = 'last_hand';
      server.maintenanceBreak.durableConfirmed = false;
      server.weeklyPayoutPause.accept(boundary);
      await vi.advanceTimersByTimeAsync(120000);
      expect(admit).not.toHaveBeenCalled();
      server.maintenanceBreak.durableConfirmed = true;
      await server.weeklyPayoutPause.handBoundary();
      expect(admit).toHaveBeenCalledTimes(1);
    } finally {
      await retire(server, engine);
    }
  });
});
