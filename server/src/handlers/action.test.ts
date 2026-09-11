/**
 * Tests for `handleAction` — the biggest and highest-stakes handler (Phase U3.5).
 * Verifies the five response branches: 401 (no auth), 429 (rate limited), 400
 * (missing field), 404 (missing engine), 200 (happy path with passthrough).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the shared http helpers BEFORE importing the handler.
vi.mock('../http/auth.js', () => ({
  authenticateRequest: vi.fn(),
}));
vi.mock('../http/body.js', () => ({
  readBody: vi.fn(),
}));
vi.mock('../http/rateLimit.js', () => ({
  checkRateLimit: vi.fn(),
}));
vi.mock('../services/errorReporter.js', () => ({
  reportError: vi.fn(),
}));

import { handleAction } from './action.js';
import { authenticateRequest } from '../http/auth.js';
import { readBody } from '../http/body.js';
import { checkRateLimit } from '../http/rateLimit.js';
import { mockReq, mockRes, parseJson, mockEngine, mockGameServer } from './_testHelpers.js';

describe('handleAction', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(checkRateLimit).mockReturnValue(true);
  });

  it('401 when authenticateRequest returns null', async () => {
    vi.mocked(authenticateRequest).mockResolvedValue(null);
    const { res, captured } = mockRes();
    await handleAction(mockReq(), res, { gameServer: mockGameServer(mockEngine()) });
    expect(captured.statusCode).toBe(401);
    expect((parseJson(captured) as { success: boolean }).success).toBe(false);
  });

  it('429 when rate limited', async () => {
    vi.mocked(authenticateRequest).mockResolvedValue({ userId: 'u1' });
    vi.mocked(readBody).mockResolvedValue(JSON.stringify({ tableId: 't1', action: 'fold' }));
    vi.mocked(checkRateLimit).mockReturnValue(false);
    const { res, captured } = mockRes();
    await handleAction(mockReq(), res, { gameServer: mockGameServer(mockEngine()) });
    expect(captured.statusCode).toBe(429);
  });

  it('400 when tableId or action missing', async () => {
    vi.mocked(authenticateRequest).mockResolvedValue({ userId: 'u1' });
    vi.mocked(readBody).mockResolvedValue(JSON.stringify({ tableId: 't1' })); // no action
    const { res, captured } = mockRes();
    await handleAction(mockReq(), res, { gameServer: mockGameServer(mockEngine()) });
    expect(captured.statusCode).toBe(400);
  });

  it('404 when engine missing', async () => {
    vi.mocked(authenticateRequest).mockResolvedValue({ userId: 'u1' });
    vi.mocked(readBody).mockResolvedValue(JSON.stringify({ tableId: 'ghost', action: 'fold' }));
    const { res, captured } = mockRes();
    await handleAction(mockReq(), res, { gameServer: mockGameServer(mockEngine(), 't1') });
    expect(captured.statusCode).toBe(404);
  });

  it('200 on success delegates once without duplicate handler telemetry', async () => {
    vi.mocked(authenticateRequest).mockResolvedValue({ userId: 'u1' });
    vi.mocked(readBody).mockResolvedValue(
      JSON.stringify({ tableId: 't1', action: 'raise', amount: 50 })
    );
    const engine = mockEngine();
    const { res, captured } = mockRes();
    await handleAction(mockReq(), res, { gameServer: mockGameServer(engine, 't1') });
    expect(captured.statusCode).toBe(200);

    expect((engine as any).handlePlayerAction).toHaveBeenCalledWith('u1', 'raise', 50, null);

    expect((engine as any).recordActionPerformance).not.toHaveBeenCalled();
  });

  it('userId always comes from JWT, never from request body (spoofing defense)', async () => {
    vi.mocked(authenticateRequest).mockResolvedValue({ userId: 'authenticated_user' });
    vi.mocked(readBody).mockResolvedValue(
      JSON.stringify({
        tableId: 't1',
        action: 'fold',
        userId: 'spoofed_attacker', // should be ignored
      })
    );
    const engine = mockEngine();
    const { res } = mockRes();
    await handleAction(mockReq(), res, { gameServer: mockGameServer(engine, 't1') });

    expect((engine as any).handlePlayerAction).toHaveBeenCalledWith(
      'authenticated_user',
      'fold',
      undefined,
      null
    );
  });

  it('500 on thrown error', async () => {
    vi.mocked(authenticateRequest).mockResolvedValue({ userId: 'u1' });
    vi.mocked(readBody).mockRejectedValue(new Error('body too large'));
    const { res, captured } = mockRes();
    await handleAction(mockReq(), res, { gameServer: mockGameServer(mockEngine()) });
    expect(captured.statusCode).toBe(500);
  });
});
