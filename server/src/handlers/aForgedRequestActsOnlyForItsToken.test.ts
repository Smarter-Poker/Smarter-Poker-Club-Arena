/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  A FORGED REQUEST ACTS ONLY FOR ITS TOKEN (Diamond Arena, Phase 11 line 1)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * server/src/http/aForgedArenaRequestIsRefused.test.ts (2026-09-19) proves the
 * money doors - POST /action, /timebank, /addchips, /leave-occupancy and the
 * retired /leave - act for the JWT and nobody else, and that the engine reads a
 * table's arena off the table it loaded. This file carries the same proof to
 * every other state-changing door a browser can reach on the engine:
 *
 *   /straddle /rit /showhand /discard /sitout /reject_rebuy /post-bb
 *   /preaction /away /heartbeat /insurance /rabbit-hunt
 *
 * and to the three table-administration doors when there is no token at all.
 * (A player, a club role and a chip owner at a Diamond table are refused by
 * adminDiamondStaff.test.ts; a signed-out token dies at authenticateRequest,
 * which verifies every token with GoTrue - see http/auth.test.ts.)
 *
 * For each door, three things, all asserted:
 *   1. whatever a hostile body says - another player's id, a club, an asset,
 *      a role, an amount, a seat - the engine hears the token's user and the
 *      door's own fields, and nothing forged;
 *   2. without a token the door answers 401 before it reads a body or finds a
 *      table;
 *   3. a table id this engine does not hold reaches no table at all.
 * The WebSocket carries no action: EngineWebSocketServer accepts PONG,
 * SUBSCRIBE, UNSUBSCRIBE and RESYNC only (action ingress is REST-only), so
 * there is no socket message to forge.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ from: vi.fn() }));
vi.mock('../http/auth.js', () => ({ authenticateRequest: vi.fn() }));
vi.mock('../http/body.js', () => ({ readBody: vi.fn() }));
vi.mock('../services/errorReporter.js', () => ({
  reportError: vi.fn(),
  describeError: (e: unknown) => String(e),
}));
vi.mock('../services/supabase.js', () => ({ supabase: { from: mocks.from } }));
vi.mock('../services/supabase/seats.js', () => ({
  getSeatCashoutReceipt: vi.fn(),
  getAdminSeatCashoutReceipt: vi.fn(),
}));

import { authenticateRequest } from '../http/auth.js';
import { readBody } from '../http/body.js';
import { handleStraddle } from './straddle.js';
import { handleRit } from './rit.js';
import { handleShowhand } from './showhand.js';
import { handleDiscard } from './discard.js';
import { handleSitout } from './sitout.js';
import { handleRejectRebuy } from './reject_rebuy.js';
import { handlePostBB } from './postbb.js';
import { handlePreaction } from './preaction.js';
import { handleAway } from './away.js';
import { handleHeartbeat } from './heartbeat.js';
import { handleInsurance } from './insurance.js';
import { handleRabbitHunt } from './rabbithunt.js';
import { handleAdminKickOccupancy, handleAdminPause, handleAdminResume } from './admin.js';
import { mockReq, mockRes, parseJson } from './_testHelpers.js';

const ACTOR = '11111111-1111-4111-8111-111111111111';
const VICTIM = '22222222-2222-4222-8222-222222222222';
const DIAMOND_TABLE = '00000000-0000-4000-8000-00000000d1a0';
const UNHELD_TABLE = '00000000-0000-4000-8000-0000000000ff';

/** Everything a hostile client might post to act as someone else, elsewhere. */
const FORGED = {
  user_id: VICTIM,
  userId: VICTIM,
  playerId: VICTIM,
  targetUserId: VICTIM,
  club_id: 'shark-club',
  clubId: 'shark-club',
  asset: 'chips',
  currency: 'chips',
  role: 'owner',
  is_platform: false,
  arena: { id: 'shark-club', asset: 'chips', kind: 'chip_club' },
  amount: 987654,
  stack: 987654,
  seatNumber: 9,
  occupancyId: VICTIM,
  tournament_id: 'forged-event',
};
const FORGED_VALUES = [
  VICTIM,
  'shark-club',
  'chips',
  'owner',
  '987654',
  'forged-event',
  'chip_club',
];

type Door = (req: IncomingMessage, res: ServerResponse, deps: any) => Promise<void>;
interface Case {
  door: string;
  handle: Door;
  /** The door's own fields: what an honest client sends besides the table. */
  body: Record<string, unknown>;
  /** The engine method the door calls, whose first argument is the actor. */
  method: string;
  /** What the door answers when this engine holds no such table. */
  unheld: number;
}
const CASES: Case[] = [
  {
    door: 'POST /straddle',
    handle: handleStraddle,
    body: { enabled: true },
    method: 'toggleStraddle',
    unheld: 404,
  },
  {
    door: 'POST /rit',
    handle: handleRit,
    body: { response: 'accept' },
    method: 'respondToRIT',
    unheld: 404,
  },
  {
    door: 'POST /showhand',
    handle: handleShowhand,
    body: { cardIndexes: [0] },
    method: 'showHand',
    unheld: 404,
  },
  {
    door: 'POST /discard',
    handle: handleDiscard,
    body: { cardIndex: 0 },
    method: 'submitDiscard',
    unheld: 404,
  },
  {
    door: 'POST /sitout',
    handle: handleSitout,
    body: { sitOut: true },
    method: 'sitOut',
    unheld: 404,
  },
  {
    door: 'POST /reject_rebuy',
    handle: handleRejectRebuy,
    body: {},
    method: 'rejectRebuy',
    unheld: 503,
  },
  { door: 'POST /post-bb', handle: handlePostBB, body: {}, method: 'postBBToEnter', unheld: 404 },
  {
    door: 'POST /preaction',
    handle: handlePreaction,
    body: { action: 'fold' },
    method: 'setPreAction',
    unheld: 404,
  },
  { door: 'POST /away', handle: handleAway, body: {}, method: 'notifyPageLeft', unheld: 200 },
  { door: 'POST /heartbeat', handle: handleHeartbeat, body: {}, method: 'heartbeat', unheld: 404 },
  {
    door: 'POST /insurance',
    handle: handleInsurance,
    body: { response: 'accept', coveragePercent: 50 },
    method: 'respondToInsurance',
    unheld: 404,
  },
  {
    door: 'POST /rabbit-hunt',
    handle: handleRabbitHunt,
    body: { handNumber: 7 },
    method: 'revealRabbitHunt',
    unheld: 404,
  },
];

const engine: Record<string, ReturnType<typeof vi.fn>> = {};
for (const c of CASES) engine[c.method] = vi.fn();
const gameServer = {
  getTableEngine: vi.fn((tableId: string) => (tableId === DIAMOND_TABLE ? engine : undefined)),
};

async function call(handle: Door) {
  const { res, captured } = mockRes();
  await handle(mockReq(), res, { gameServer });
  return { status: captured.statusCode, body: parseJson(captured) };
}

/** Every engine call this test observed, as one string to search for forgeries. */
function engineCalls(): string {
  return JSON.stringify(Object.values(engine).flatMap((fn) => fn.mock.calls));
}

beforeEach(() => {
  vi.clearAllMocks();
  for (const c of CASES) {
    const answer = { success: true };
    engine[c.method].mockImplementation(() =>
      c.method === 'revealRabbitHunt' || c.method === 'rejectRebuy'
        ? Promise.resolve(answer)
        : answer
    );
  }
  vi.mocked(authenticateRequest).mockResolvedValue({ userId: ACTOR });
});

describe('every engine door acts for the token and nobody else', () => {
  it.each(CASES)('$door: a forged body moves only the token holder', async (c) => {
    vi.mocked(readBody).mockResolvedValue(
      JSON.stringify({ ...FORGED, ...c.body, tableId: DIAMOND_TABLE })
    );
    const out = await call(c.handle);
    expect(out.status).toBe(200);
    expect(gameServer.getTableEngine).toHaveBeenCalledTimes(1);
    expect(gameServer.getTableEngine).toHaveBeenCalledWith(DIAMOND_TABLE);
    expect(engine[c.method]).toHaveBeenCalledTimes(1);
    expect(engine[c.method].mock.calls[0][0]).toBe(ACTOR);
    const heard = engineCalls();
    for (const forged of FORGED_VALUES)
      expect(heard, `${forged} reached the engine`).not.toContain(forged);
    // no other engine method was touched by this door
    const others = Object.entries(engine).filter(
      ([m, fn]) => m !== c.method && fn.mock.calls.length > 0
    );
    expect(others).toEqual([]);
  });

  it.each(CASES)('$door: no token, no body read and no table found', async (c) => {
    vi.mocked(authenticateRequest).mockResolvedValue(null);
    vi.mocked(readBody).mockResolvedValue(
      JSON.stringify({ ...FORGED, ...c.body, tableId: DIAMOND_TABLE })
    );
    const out = await call(c.handle);
    expect(out.status).toBe(401);
    expect(readBody).not.toHaveBeenCalled();
    expect(gameServer.getTableEngine).not.toHaveBeenCalled();
    expect(engineCalls()).toBe('[]');
  });

  it.each(CASES)('$door: a table this engine does not hold reaches no table', async (c) => {
    vi.mocked(readBody).mockResolvedValue(
      JSON.stringify({ ...FORGED, ...c.body, tableId: UNHELD_TABLE })
    );
    const out = await call(c.handle);
    expect(out.status).toBe(c.unheld);
    expect(gameServer.getTableEngine).toHaveBeenCalledWith(UNHELD_TABLE);
    expect(engineCalls()).toBe('[]');
  });
});

describe('the table-administration doors, with no token at all', () => {
  const adminEngine = { adminPause: vi.fn(), adminResume: vi.fn(), leaveTable: vi.fn() };
  const adminServer = { getTableEngine: vi.fn(() => adminEngine) };

  it.each([
    ['POST /admin/pause', handleAdminPause, { tableId: DIAMOND_TABLE, reason: 'forged' }],
    ['POST /admin/resume', handleAdminResume, { tableId: DIAMOND_TABLE }],
    [
      'POST /admin/kick-occupancy',
      handleAdminKickOccupancy,
      {
        tableId: DIAMOND_TABLE,
        userId: VICTIM,
        occupancyId: VICTIM,
        seatNumber: 1,
        reason: 'forged',
      },
    ],
  ] as const)('%s answers 401 and reads no table, role or engine', async (_door, handle, body) => {
    vi.mocked(authenticateRequest).mockResolvedValue(null);
    vi.mocked(readBody).mockResolvedValue(JSON.stringify({ ...FORGED, ...body }));
    const { res, captured } = mockRes();
    await handle(mockReq(), res, { gameServer: adminServer } as any);
    expect(captured.statusCode).toBe(401);
    expect(mocks.from).not.toHaveBeenCalled();
    expect(adminServer.getTableEngine).not.toHaveBeenCalled();
    expect(adminEngine.adminPause).not.toHaveBeenCalled();
    expect(adminEngine.adminResume).not.toHaveBeenCalled();
    expect(adminEngine.leaveTable).not.toHaveBeenCalled();
  });
});
