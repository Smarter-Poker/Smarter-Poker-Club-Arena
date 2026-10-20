import { beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('../http/auth.js', () => ({ authenticateRequest: vi.fn() }));
vi.mock('../http/body.js', () => ({ readBody: vi.fn() }));
vi.mock('../services/errorReporter.js', () => ({ reportError: vi.fn() }));
import { authenticateRequest } from '../http/auth.js';
import { readBody } from '../http/body.js';
import { handleSitout } from './sitout.js';
import { mockReq, mockRes, parseJson } from './_testHelpers.js';

const room = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const table = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
const sitOut = vi.fn();
const getTableEngine = vi.fn();
const lightningAnchorFor = vi.fn();

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(authenticateRequest).mockResolvedValue({ userId: 'owner' } as never);
  sitOut.mockReturnValue({ success: true, willFoldNextHand: false });
  getTableEngine.mockImplementation((id: string) => (id === table ? { sitOut } : null));
});

async function request(tableId: string, wanted: boolean) {
  vi.mocked(readBody).mockResolvedValue(
    JSON.stringify({ tableId, sitOut: wanted, userId: 'forged' })
  );
  const { res, captured } = mockRes();
  await handleSitout(mockReq(), res, { gameServer: { getTableEngine, lightningAnchorFor } });
  return { status: captured.statusCode, body: parseJson(captured) };
}

describe('Lightning room sit out and return', () => {
  it.each([true, false])('routes sitOut=%s through the caller-owned anchor', async (wanted) => {
    lightningAnchorFor.mockResolvedValue({ anchorTableId: table });
    expect(await request(room, wanted)).toMatchObject({ status: 200, body: { success: true } });
    expect(lightningAnchorFor).toHaveBeenCalledWith(room, 'owner', { requireOpen: true });
    expect(sitOut.mock.calls).toEqual([['owner', wanted]]);
  });

  it.each(['foreign', 'closed'])('refuses a %s pool without touching an engine', async () => {
    lightningAnchorFor.mockResolvedValue(null);
    expect((await request(room, true)).status).toBe(404);
    expect(sitOut).not.toHaveBeenCalled();
  });

  it('preserves the physical cash-table route and its one-hand refusal', async () => {
    sitOut.mockReturnValue({
      success: false,
      error: 'You Must Play At Least One Hand Before You Can Sit Out',
      willFoldNextHand: false,
    });
    expect(await request(table, true)).toMatchObject({
      status: 400,
      body: { success: false, error: 'You Must Play At Least One Hand Before You Can Sit Out' },
    });
    expect(lightningAnchorFor).not.toHaveBeenCalled();
    expect(sitOut.mock.calls).toEqual([['owner', true]]);
  });

  it('refuses an anchor whose engine is unavailable', async () => {
    lightningAnchorFor.mockResolvedValue({ anchorTableId: 'missing' });
    expect((await request(room, false)).status).toBe(404);
    expect(sitOut).not.toHaveBeenCalled();
  });

  it('authenticates before resolving a private room', async () => {
    vi.mocked(authenticateRequest).mockResolvedValue(null);
    expect((await request(room, true)).status).toBe(401);
    expect(lightningAnchorFor).not.toHaveBeenCalled();
    expect(sitOut).not.toHaveBeenCalled();
  });
});
