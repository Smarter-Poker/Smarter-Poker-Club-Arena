/**
 * DIAMOND PHASE 10 (2026-09-29): platform staff operate a Diamond table.
 *
 * The Diamond Arena has no club operators - its only club_members rows are
 * automatic players - so authorizeTableAdmin refused everyone at a Diamond
 * table and pause, resume and kick did nothing in the arena. At a Diamond
 * table the caller's platform role (fn_is_platform_admin: admin, superadmin,
 * god) is now the whole answer; at a chip table nothing changes.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({
  from: vi.fn(),
  table: null as Record<string, unknown> | null,
  profile: { data: { role: 'admin' } as { role: string } | null, error: null as unknown },
  member: { data: null as { role: string } | null, error: null as unknown },
}));
vi.mock('../http/auth.js', () => ({ authenticateRequest: vi.fn() }));
vi.mock('../http/body.js', () => ({ readBody: vi.fn() }));
vi.mock('../services/errorReporter.js', () => ({ reportError: vi.fn() }));
vi.mock('../services/supabase.js', () => ({ supabase: { from: mocks.from } }));
vi.mock('../services/supabase/seats.js', () => ({
  getSeatCashoutReceipt: vi.fn(),
  getAdminSeatCashoutReceipt: vi.fn(),
}));
import { authenticateRequest } from '../http/auth.js';
import { readBody } from '../http/body.js';
import { getAdminSeatCashoutReceipt, getSeatCashoutReceipt } from '../services/supabase/seats.js';
import { handleAdminKickOccupancy, handleAdminPause, handleAdminResume } from './admin.js';
import { mockReq, mockRes, parseJson } from './_testHelpers.js';

const tableId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const arenaId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const player = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const occupancyId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const diamondTable = {
  club_id: arenaId,
  union_id: null,
  tournament_id: null,
  arena: { id: arenaId, asset: 'diamonds', is_platform: true, union_id: null },
};
const chipTable = {
  club_id: 'chip-club',
  union_id: null,
  tournament_id: null,
  arena: { id: 'chip-club', asset: 'chips', is_platform: false, union_id: null },
};
const adminPause = vi.fn(() => ({ success: true, paused: true }));
const adminResume = vi.fn(() => ({ success: true, paused: false }));
const leaveTable = vi.fn();
const gameServer = { getTableEngine: vi.fn(() => ({ adminPause, adminResume, leaveTable })) };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.table = diamondTable;
  mocks.profile = { data: { role: 'admin' }, error: null };
  mocks.member = { data: null, error: null };
  vi.mocked(authenticateRequest).mockResolvedValue({ userId: 'staff-1' });
  vi.mocked(readBody).mockResolvedValue(JSON.stringify({ tableId, reason: 'house decision' }));
  vi.mocked(getSeatCashoutReceipt).mockResolvedValue(null);
  vi.mocked(getAdminSeatCashoutReceipt).mockResolvedValue(null);
  leaveTable.mockResolvedValue({ success: true, immediate: false });
  mocks.from.mockImplementation((name: string) => {
    const chain: any = {};
    for (const m of ['select', 'eq']) chain[m] = vi.fn(() => chain);
    chain.maybeSingle = async () =>
      name === 'tables'
        ? { data: mocks.table, error: null }
        : name === 'profiles'
          ? mocks.profile
          : name === 'club_members'
            ? mocks.member
            : { data: null, error: null };
    return chain;
  });
});

async function run(handler: typeof handleAdminPause) {
  const { res, captured } = mockRes();
  await handler(mockReq(), res, { gameServer } as any);
  return { status: captured.statusCode, body: parseJson(captured) };
}
const tablesAsked = () => mocks.from.mock.calls.filter(([n]) => n === 'tables').length;
const profilesAsked = () => mocks.from.mock.calls.filter(([n]) => n === 'profiles').length;
const membersAsked = () => mocks.from.mock.calls.filter(([n]) => n === 'club_members').length;

describe('a Diamond table is operated by platform staff', () => {
  it.each(['admin', 'superadmin', 'god'])('%s pauses and resumes it', async (role) => {
    mocks.profile = { data: { role }, error: null };
    expect((await run(handleAdminPause)).status).toBe(200);
    expect(adminPause).toHaveBeenCalledWith('house decision');
    expect((await run(handleAdminResume)).status).toBe(200);
    expect(adminResume).toHaveBeenCalled();
    // the platform role is the whole answer: no club role is consulted
    expect(membersAsked()).toBe(0);
  });

  it('refuses everyone else, a club role included, before the engine is touched', async () => {
    for (const role of ['user', 'player', 'owner', '']) {
      mocks.profile = { data: { role }, error: null };
      mocks.member = { data: { role: 'owner' }, error: null };
      const out = await run(handleAdminPause);
      expect(out.status).toBe(403);
      expect(out.body).toEqual({ success: false, error: 'Platform staff required' });
    }
    expect(membersAsked()).toBe(0);
    expect(gameServer.getTableEngine).not.toHaveBeenCalled();
  });

  it('fails closed when the role cannot be read', async () => {
    mocks.profile = { data: null, error: { message: 'unavailable' } };
    expect((await run(handleAdminResume)).status).toBe(403);
    mocks.profile = { data: null, error: null };
    expect((await run(handleAdminResume)).status).toBe(403);
    expect(adminResume).not.toHaveBeenCalled();
  });

  it('lets staff kick at a Diamond cash table, the authority naming the arena', async () => {
    vi.mocked(readBody).mockResolvedValue(
      JSON.stringify({
        tableId,
        userId: player,
        occupancyId,
        seatNumber: 3,
        reason: 'house decision',
      })
    );
    const out = await run(handleAdminKickOccupancy);
    expect(out.status).toBe(200);
    expect(leaveTable).toHaveBeenCalledWith(player, {
      forced: true,
      occupancyId,
      seatNumber: 3,
      admin: { actorId: 'staff-1', clubId: arenaId, reason: 'house decision' },
    });
  });

  it('still sends a Diamond tournament chair to registration management', async () => {
    mocks.table = { ...diamondTable, tournament_id: 'tournament-1' };
    vi.mocked(readBody).mockResolvedValue(
      JSON.stringify({
        tableId,
        userId: player,
        occupancyId,
        seatNumber: 3,
        reason: 'house decision',
      })
    );
    expect((await run(handleAdminKickOccupancy)).status).toBe(409);
    expect(leaveTable).not.toHaveBeenCalled();
  });
});

describe('a chip table is unchanged', () => {
  it('gives platform staff no power without a club role', async () => {
    mocks.table = chipTable;
    mocks.member = { data: null, error: null };
    const out = await run(handleAdminPause);
    expect(out.status).toBe(403);
    expect(out.body).toEqual({ success: false, error: 'Not a club member' });
    expect(profilesAsked()).toBe(0);
    expect(adminPause).not.toHaveBeenCalled();
  });

  it('still admits its club admin', async () => {
    mocks.table = chipTable;
    mocks.member = { data: { role: 'co_owner' }, error: null };
    expect((await run(handleAdminPause)).status).toBe(200);
    expect(profilesAsked()).toBe(0);
    expect(tablesAsked()).toBe(1);
  });
});
