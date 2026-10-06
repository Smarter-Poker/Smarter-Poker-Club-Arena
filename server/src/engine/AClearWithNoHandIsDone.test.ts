/**
 * A CLEAR IS FINISHED WHEN NOTHING IS ARMED (2026-10-04).
 *
 * Dan, after a human-versus-human match: "MY HUMAN OPPONENT [WAS] CONSTANTLY
 * BEING TIMED OUT OR DISCONNECTED." Beside that match his own seat, at a
 * heads-up sit-and-go (table a84e44e8), folded thirteen hands in two and a
 * quarter minutes as `fold[pre_action]`, ten of them within half a second of
 * the deal. He had armed one pre-action.
 *
 * The browser clears a pre-action at every hand boundary. When the hand was
 * already over, `setPreAction` answered that clear `No active hand` (HTTP
 * 400), because the clear sat below the two refusals meant for an ARM. The
 * browser read a refused cancel as "the engine still holds it", put the
 * control back, and putting it back sent the arm again, into the next hand,
 * where an arm that arrives on the player's own turn runs at once.
 *
 * The page no longer does that. This pins the engine's half: the answer to a
 * clear is the truth, so a bundle that predates the page fix has nothing to
 * loop on either.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';

vi.mock('../http/auth.js', () => ({ authenticateRequest: vi.fn() }));
vi.mock('../http/body.js', () => ({ readBody: vi.fn() }));

const { ServerTableEngine } = await import('./ServerTableEngine.js');
const { handlePreaction } = await import('../handlers/preaction.js');
const { readBody } = await import('../http/body.js');
const { authenticateRequest } = await import('../http/auth.js');
const { mockReq, mockRes, parseJson } = await import('../handlers/_testHelpers.js');

const TABLE = 'eeeeeeee-5555-4444-3333-222222222222';

afterEach(() => vi.restoreAllMocks());

function engine() {
  const e = new ServerTableEngine(TABLE) as any;
  e.hub = { emitEvent: vi.fn(), sendToUser: vi.fn().mockReturnValue(1) };
  return e;
}

/** A hand in progress with two seats; it is the villain's turn. */
function dealHand(e: any) {
  e.handController = {
    getState: () => ({
      currentPlayerSeat: 6,
      currentBet: 10,
      players: [
        { user_id: 'hero', seat: 2, bet: 0, stack: 500 },
        { user_id: 'villain', seat: 6, bet: 10, stack: 500 },
      ],
    }),
  };
}

describe('a clear when there is no hand', () => {
  it('is answered done, not refused', () => {
    const e = engine();
    expect(e.handController).toBeNull();
    // The exact reply a pre-fix bundle read as "the engine still holds it".
    expect(e.setPreAction('hero', 'clear')).toEqual({ success: true });
  });

  it('removes an entry that outlived its hand', () => {
    const e = engine();
    e.preActionEngine.setPreAction(TABLE, 'hero', 'auto_fold');
    expect(e.setPreAction('hero', 'clear')).toEqual({ success: true });
    expect(e.preActionEngine.getPreAction(TABLE, 'hero')).toBeNull();
    // And the player's sockets are told, with the reason.
    expect(e.hub.sendToUser.mock.calls.at(-1)?.[2]).toEqual(
      expect.objectContaining({ kind: 'pre_action', action: null, reason: 'cleared' })
    );
  });

  it('creates no state for somebody who holds nothing here', () => {
    const e = engine();
    const before = e.preActionEngine.playerFSMs.size;
    expect(e.setPreAction('a-stranger', 'clear')).toEqual({ success: true });
    expect(e.preActionEngine.playerFSMs.size).toBe(before);
    expect(e.hub.sendToUser).not.toHaveBeenCalled();
  });

  it('reaches the browser as HTTP 200, through the real door', async () => {
    const e = engine();
    vi.mocked(authenticateRequest).mockResolvedValue({ userId: 'hero' } as never);
    vi.mocked(readBody).mockResolvedValue(JSON.stringify({ tableId: TABLE, action: 'clear' }));
    const { res, captured } = mockRes();
    await handlePreaction(mockReq(), res, { gameServer: { getTableEngine: () => e } });
    expect(captured.statusCode).toBe(200);
    expect(parseJson(captured)).toEqual({ success: true });
  });

  it('while an ARM with no hand is still an HTTP 400 that says why', async () => {
    const e = engine();
    vi.mocked(authenticateRequest).mockResolvedValue({ userId: 'hero' } as never);
    vi.mocked(readBody).mockResolvedValue(JSON.stringify({ tableId: TABLE, action: 'auto_fold' }));
    const { res, captured } = mockRes();
    await handlePreaction(mockReq(), res, { gameServer: { getTableEngine: () => e } });
    expect(captured.statusCode).toBe(400);
    expect(parseJson(captured)).toEqual({
      success: false,
      error: 'No active hand',
      code: 'NO_ACTIVE_HAND',
    });
  });
});

describe('a clear from a player the running hand does not hold', () => {
  it('is answered done', () => {
    const e = engine();
    dealHand(e);
    expect(e.setPreAction('just-sat-down', 'clear')).toEqual({ success: true });
  });
});

describe('a clear in a running hand is what it always was', () => {
  it('removes the armed pre-action and tells the player', () => {
    const e = engine();
    dealHand(e);
    expect(e.setPreAction('hero', 'auto_fold')).toEqual({ success: true, armedToCall: 10 });
    expect(e.preActionEngine.getPreAction(TABLE, 'hero')?.action).toBe('auto_fold');
    e.hub.sendToUser.mockClear();

    expect(e.setPreAction('hero', 'clear')).toEqual({ success: true });
    expect(e.preActionEngine.getPreAction(TABLE, 'hero')).toBeNull();
    expect(e.hub.sendToUser.mock.calls.at(-1)?.[2]).toEqual(
      expect.objectContaining({ kind: 'pre_action', action: null, reason: 'cleared' })
    );
  });

  it('is done when nothing was armed', () => {
    const e = engine();
    dealHand(e);
    expect(e.setPreAction('hero', 'clear')).toEqual({ success: true });
  });
});

describe('an arm is still refused where there is nothing to arm it in', () => {
  it('with no hand, by sentence and by code', () => {
    const e = engine();
    expect(e.setPreAction('hero', 'auto_fold')).toEqual({
      success: false,
      error: 'No active hand',
      code: 'NO_ACTIVE_HAND',
    });
    expect(e.preActionEngine.getPreAction(TABLE, 'hero')).toBeNull();
  });

  it('for a player not dealt into the hand, by sentence and by code', () => {
    const e = engine();
    dealHand(e);
    expect(e.setPreAction('just-sat-down', 'auto_check')).toEqual({
      success: false,
      error: 'Player not found at this table',
      code: 'NOT_IN_HAND',
    });
  });

  it('and an unknown pre-action is refused as before', () => {
    const e = engine();
    dealHand(e);
    expect(e.setPreAction('hero', 'auto_dance')).toEqual({
      success: false,
      error: 'Invalid pre-action: auto_dance',
    });
  });
});
