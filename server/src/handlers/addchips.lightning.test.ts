/**
 * Lightning Phase 6 remediation: POST /addchips against a pool_session_id
 * (the player's Lightning room) adds the chips to the anchor seat, at the
 * anchor table's engine, rather than answering "Table engine not found".
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('../http/auth.js', () => ({ authenticateRequest: vi.fn() }));
vi.mock('../http/body.js', () => ({ readBody: vi.fn() }));
vi.mock('../services/errorReporter.js', () => ({ reportError: vi.fn() }));
import { authenticateRequest } from '../http/auth.js';
import { readBody } from '../http/body.js';
import { handleAddchips } from './addchips.js';
import { mockReq, mockRes, parseJson } from './_testHelpers.js';

const room = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const anchorTable = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
const addChips = vi.fn();
const getTableEngine = vi.fn();
const lightningAnchorFor = vi.fn();

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(authenticateRequest).mockResolvedValue({ userId: 'owner' } as never);
  vi.mocked(readBody).mockResolvedValue(JSON.stringify({ tableId: room, amount: 25 }));
  addChips.mockResolvedValue({ success: true });
  getTableEngine.mockImplementation((id: string) => (id === anchorTable ? { addChips } : null));
});

async function request() {
  const { res, captured } = mockRes();
  await handleAddchips(mockReq(), res, { gameServer: { getTableEngine, lightningAnchorFor } });
  return { status: captured.statusCode, body: parseJson(captured) };
}

describe('add chips from a Lightning room', () => {
  it('reaches the anchor table’s engine for the caller', async () => {
    lightningAnchorFor.mockResolvedValue({ anchorTableId: anchorTable });
    expect(await request()).toMatchObject({ status: 200, body: { success: true } });
    expect(lightningAnchorFor).toHaveBeenCalledWith(room, 'owner');
    expect(addChips).toHaveBeenCalledWith('owner', 25, undefined);
  });

  it('a room that is not the caller’s is still not found', async () => {
    lightningAnchorFor.mockResolvedValue(null);
    expect((await request()).status).toBe(404);
    expect(addChips).not.toHaveBeenCalled();
  });
});
