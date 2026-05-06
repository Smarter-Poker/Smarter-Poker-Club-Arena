/**
 * Consolidated tests for all state-mutating handlers (Phase U3.5).
 *
 * Covers the uniform auth → validate → engine-dispatch → response contract
 * shared by timebank, heartbeat, preaction, addchips, leave, sitout, straddle,
 * rit, insurance, showhand, discard, admin/pause, admin/resume, postbb, and
 * the two GET handlers (actions, state). `handleAction` has its own dedicated
 * test file (action.test.ts) covering its extra rate-limit + spoofing cases.
 *
 * Each handler is tested for three invariants:
 *   1. 401 when authenticateRequest returns null
 *   2. 404 when gameServer.getTableEngine returns undefined
 *   3. 200 on happy path (engine method called + result passthrough)
 *
 * Per-field validation (400 responses) is covered sparsely — the uniform
 * auth/engine contract is the highest-value thing to lock down.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../http/auth.js', () => ({ authenticateRequest: vi.fn() }));
vi.mock('../http/body.js', () => ({ readBody: vi.fn() }));
vi.mock('../services/errorReporter.js', () => ({ reportError: vi.fn() }));

import { handleTimebank } from './timebank.js';
import { handleHeartbeat } from './heartbeat.js';
import { handlePreaction } from './preaction.js';
import { handleAddchips } from './addchips.js';
import { handleLeave } from './leave.js';
import { handleSitout } from './sitout.js';
import { handleStraddle } from './straddle.js';
import { handleRit } from './rit.js';
import { handleInsurance, handleInsurancePreview } from './insurance.js';
import { handleShowhand } from './showhand.js';
import { handleDiscard } from './discard.js';
import { handleAdminPause, handleAdminResume } from './admin.js';
import { handlePostBB } from './postbb.js';
import { handleGetActions, handleGetState } from './state.js';

import { authenticateRequest } from '../http/auth.js';
import { readBody } from '../http/body.js';
import { mockReq, mockRes, parseJson, mockEngine, mockGameServer } from './_testHelpers.js';

// Every POST handler has the same signature: (req, res, deps).
// Regex GETs (/actions/:id, /state/:id) take tableId as a 3rd positional arg.
interface HandlerCase {
  name: string;
  body: Record<string, unknown>; // POST body that passes validation
  invoke: (
    req: ReturnType<typeof mockReq>,
    res: ReturnType<typeof mockRes>['res'],
    gameServer: ReturnType<typeof mockGameServer>
  ) => Promise<unknown> | unknown;
  // Name of the engine method the handler calls on the happy path.
  engineMethod: string;
}

const POST_CASES: HandlerCase[] = [
  {
    name: 'timebank',
    body: { tableId: 't1' },
    invoke: (req, res, gs) => handleTimebank(req, res, { gameServer: gs }),
    engineMethod: 'activateTimeBank',
  },
  {
    name: 'heartbeat',
    body: { tableId: 't1' },
    invoke: (req, res, gs) => handleHeartbeat(req, res, { gameServer: gs }),
    engineMethod: 'heartbeat',
  },
  {
    name: 'preaction',
    body: { tableId: 't1', action: 'check' },
    invoke: (req, res, gs) => handlePreaction(req, res, { gameServer: gs }),
    engineMethod: 'setPreAction',
  },
  {
    name: 'addchips',
    body: { tableId: 't1', amount: 100 },
    invoke: (req, res, gs) => handleAddchips(req, res, { gameServer: gs }),
    engineMethod: 'addChips',
  },
  {
    name: 'sitout',
    body: { tableId: 't1', sitOut: true },
    invoke: (req, res, gs) => handleSitout(req, res, { gameServer: gs }),
    engineMethod: 'sitOut',
  },
  {
    name: 'straddle',
    body: { tableId: 't1', enabled: true },
    invoke: (req, res, gs) => handleStraddle(req, res, { gameServer: gs }),
    engineMethod: 'toggleStraddle',
  },
  {
    name: 'rit',
    body: { tableId: 't1', response: 'accept' },
    invoke: (req, res, gs) => handleRit(req, res, { gameServer: gs }),
    engineMethod: 'respondToRIT',
  },
  {
    name: 'insurance',
    body: { tableId: 't1', response: 'accept', coveragePercent: 75 },
    invoke: (req, res, gs) => handleInsurance(req, res, { gameServer: gs }),
    engineMethod: 'respondToInsurance',
  },
  {
    name: 'showhand',
    body: { tableId: 't1' },
    invoke: (req, res, gs) => handleShowhand(req, res, { gameServer: gs }),
    engineMethod: 'showHand',
  },
  {
    name: 'discard',
    body: { tableId: 't1', cardIndex: 2 },
    invoke: (req, res, gs) => handleDiscard(req, res, { gameServer: gs }),
    engineMethod: 'submitDiscard',
  },
  {
    name: 'admin/pause',
    body: { tableId: 't1', reason: 'maintenance' },
    invoke: (req, res, gs) => handleAdminPause(req, res, { gameServer: gs }),
    engineMethod: 'adminPause',
  },
  {
    name: 'admin/resume',
    body: { tableId: 't1' },
    invoke: (req, res, gs) => handleAdminResume(req, res, { gameServer: gs }),
    engineMethod: 'adminResume',
  },
  {
    name: 'post-bb',
    body: { tableId: 't1' },
    invoke: (req, res, gs) => handlePostBB(req, res, { gameServer: gs }),
    engineMethod: 'postBBToEnter',
  },
];

describe.each(POST_CASES)(
  'POST /$name — uniform contract',
  ({ name: _name, body, invoke, engineMethod }) => {
    beforeEach(() => {
      vi.clearAllMocks();
    });

    it('401 when unauthenticated', async () => {
      vi.mocked(authenticateRequest).mockResolvedValue(null);
      const { res, captured } = mockRes();
      await invoke(mockReq(), res, mockGameServer(mockEngine()));
      expect(captured.statusCode).toBe(401);
    });

    it('404 when engine missing', async () => {
      vi.mocked(authenticateRequest).mockResolvedValue({ userId: 'u1' });
      vi.mocked(readBody).mockResolvedValue(JSON.stringify(body));
      const { res, captured } = mockRes();
      await invoke(mockReq(), res, mockGameServer(mockEngine(), 'other-table'));
      expect(captured.statusCode).toBe(404);
    });

    it('200 happy path calls engine method', async () => {
      vi.mocked(authenticateRequest).mockResolvedValue({ userId: 'u1' });
      vi.mocked(readBody).mockResolvedValue(JSON.stringify(body));
      const engine = mockEngine();
      const { res, captured } = mockRes();
      await invoke(mockReq(), res, mockGameServer(engine, 't1'));
      expect(captured.statusCode).toBe(200);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expect((engine as any)[engineMethod]).toHaveBeenCalled();
    });
  }
);

// ── GET /insurance-preview ──────────────────────────────────────────────────

describe('handleInsurancePreview', () => {
  beforeEach(() => vi.clearAllMocks());

  it('401 when unauthenticated', async () => {
    vi.mocked(authenticateRequest).mockResolvedValue(null);
    const { res, captured } = mockRes();
    await handleInsurancePreview(mockReq({ url: '/insurance-preview?tableId=t1' }), res, {
      gameServer: mockGameServer(mockEngine()),
    });
    expect(captured.statusCode).toBe(401);
  });

  it('400 when tableId query param missing', async () => {
    vi.mocked(authenticateRequest).mockResolvedValue({ userId: 'u1' });
    const { res, captured } = mockRes();
    await handleInsurancePreview(mockReq({ url: '/insurance-preview' }), res, {
      gameServer: mockGameServer(mockEngine()),
    });
    expect(captured.statusCode).toBe(400);
  });

  it('200 when engine returns a preview', async () => {
    vi.mocked(authenticateRequest).mockResolvedValue({ userId: 'u1' });
    const { res, captured } = mockRes();
    await handleInsurancePreview(
      mockReq({ url: '/insurance-preview?tableId=t1&coveragePercent=50' }),
      res,
      { gameServer: mockGameServer(mockEngine(), 't1') }
    );
    expect(captured.statusCode).toBe(200);
    expect(parseJson(captured)).toMatchObject({ success: true });
  });
});

// ── Regex-matched GETs (tableId as positional arg) ──────────────────────────

describe('handleGetActions', () => {
  beforeEach(() => vi.clearAllMocks());

  it('401 when unauthenticated', async () => {
    vi.mocked(authenticateRequest).mockResolvedValue(null);
    const { res, captured } = mockRes();
    await handleGetActions(mockReq(), res, 't1', { gameServer: mockGameServer(mockEngine()) });
    expect(captured.statusCode).toBe(401);
  });

  it('404 when engine missing', async () => {
    vi.mocked(authenticateRequest).mockResolvedValue({ userId: 'u1' });
    const { res, captured } = mockRes();
    await handleGetActions(mockReq(), res, 'ghost', {
      gameServer: mockGameServer(mockEngine(), 't1'),
    });
    expect(captured.statusCode).toBe(404);
  });

  it('200 returns engine.getPlayerActions — uses JWT userId not URL param', async () => {
    vi.mocked(authenticateRequest).mockResolvedValue({ userId: 'auth_user' });
    const engine = mockEngine();
    const { res, captured } = mockRes();
    await handleGetActions(mockReq(), res, 't1', { gameServer: mockGameServer(engine, 't1') });
    expect(captured.statusCode).toBe(200);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((engine as any).getPlayerActions).toHaveBeenCalledWith('auth_user');
  });
});

describe('handleGetState', () => {
  beforeEach(() => vi.clearAllMocks());

  it('401 when unauthenticated', async () => {
    vi.mocked(authenticateRequest).mockResolvedValue(null);
    const { res, captured } = mockRes();
    await handleGetState(mockReq(), res, 't1', { gameServer: mockGameServer(mockEngine()) });
    expect(captured.statusCode).toBe(401);
  });

  it('returns idle stage when getTableState returns null', async () => {
    vi.mocked(authenticateRequest).mockResolvedValue({ userId: 'u1' });
    const engine = mockEngine({ getTableState: vi.fn().mockReturnValue(null) });
    const { res, captured } = mockRes();
    await handleGetState(mockReq(), res, 't1', { gameServer: mockGameServer(engine, 't1') });
    expect(captured.statusCode).toBe(200);
    expect(parseJson(captured)).toMatchObject({ table_id: 't1', stage: 'idle' });
  });

  it('200 returns engine state', async () => {
    vi.mocked(authenticateRequest).mockResolvedValue({ userId: 'u1' });
    const engine = mockEngine();
    const { res, captured } = mockRes();
    await handleGetState(mockReq(), res, 't1', { gameServer: mockGameServer(engine, 't1') });
    expect(captured.statusCode).toBe(200);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((engine as any).getTableState).toHaveBeenCalledWith('u1');
  });
});

// ── /leave has a special 200 path when engine missing ──────────────────────

describe('handleLeave — engine-missing edge case', () => {
  beforeEach(() => vi.clearAllMocks());

  it('200 with immediate:true when engine not running (client does DB cleanup)', async () => {
    vi.mocked(authenticateRequest).mockResolvedValue({ userId: 'u1' });
    vi.mocked(readBody).mockResolvedValue(JSON.stringify({ tableId: 'orphan' }));
    const { res, captured } = mockRes();
    await handleLeave(mockReq(), res, { gameServer: mockGameServer(mockEngine(), 't1') });
    expect(captured.statusCode).toBe(200);
    expect(parseJson(captured)).toMatchObject({ success: true, immediate: true });
  });
});
