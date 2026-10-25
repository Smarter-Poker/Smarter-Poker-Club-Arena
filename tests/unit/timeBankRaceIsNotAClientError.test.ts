/**
 * A time bank that crosses the turn is a race, not a client error (2026-10-24).
 *
 * The engine refuses /timebank with "Not Your Turn" (and its siblings) when the
 * turn moved on before the request landed. The refusal must still come back to
 * the caller exactly as before, but it must not be filed in client_error_events
 * or shown to the player as an error toast. Every other engine refusal - and
 * the same words from any other endpoint - is still reported.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const sink = vi.hoisted(() => ({ capture: vi.fn(), report: vi.fn() }));
vi.mock('../../src/utils/errorReporter', () => ({
  captureClientError: sink.capture,
  reportError: sink.report,
  isClientErrorSinkEnabled: () => true,
}));
vi.mock('../../src/lib/authToken', () => ({
  getFreshAccessToken: async () =>
    JSON.parse(localStorage.getItem('smarter-poker-auth')!).access_token,
}));

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

import * as GameServerAPI from '../../src/services/GameServerAPI';
import { isTimeBankRaceRefusal, isTimeBankTurnGone } from '../../src/services/GameServerAPI';

/** A Response-shaped refusal whose body can be read twice (caller + clone). */
function refusal(status: number, body: unknown) {
  const make = (): any => ({
    ok: false,
    status,
    json: async () => body,
    clone: () => make(),
  });
  return make();
}

/** noteEngineRefusal reads the cloned body in the background. */
const settle = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.setItem(
    'smarter-poker-auth',
    JSON.stringify({
      access_token: `e30.${btoa(JSON.stringify({ sub: 'user-1', session_id: 'login-1', exp: 4102444800 }))}.sig`,
    })
  );
});

describe('time bank race refusals', () => {
  it.each([
    'Not Your Turn',
    'No Active Hand At This Table',
    'No active hand',
    'That decision is no longer active',
    'Your Time Bank Is Already Running',
  ])('"%s" from /timebank returns the refusal unchanged and files nothing', async (error) => {
    mockFetch.mockResolvedValue(refusal(400, { success: false, error }));
    expect(await GameServerAPI.activateTimeBank('table-1')).toEqual({ success: false, error });
    await settle();
    expect(sink.capture).not.toHaveBeenCalled();
    expect(sink.report).not.toHaveBeenCalled();
  });

  it('still files a time bank refusal that is not a race', async () => {
    mockFetch.mockResolvedValue(
      refusal(400, { success: false, error: 'No Time Bank Uses Remaining' })
    );
    expect(await GameServerAPI.activateTimeBank('table-1')).toEqual({
      success: false,
      error: 'No Time Bank Uses Remaining',
    });
    await settle();
    expect(sink.capture).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ message: 'No Time Bank Uses Remaining' }),
      'GameServerAPI.engine_refusal',
      { code: 'HTTP_400', status: 400, path: '/timebank' }
    );
  });

  it('still files a /timebank race sentence that arrives with a non-400 status', async () => {
    mockFetch.mockResolvedValue(refusal(404, { success: false, error: 'Not Your Turn' }));
    await GameServerAPI.activateTimeBank('table-1');
    await settle();
    expect(sink.capture).toHaveBeenCalledOnce();
  });

  it('still files the same sentence from any endpoint other than /timebank', async () => {
    mockFetch.mockResolvedValue(refusal(400, { success: false, error: 'Not Your Turn' }));
    await GameServerAPI.setSitOut('table-1', true);
    await settle();
    expect(sink.capture).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ message: 'Not Your Turn' }),
      'GameServerAPI.engine_refusal',
      { code: 'HTTP_400', status: 400, path: '/sitout' }
    );
  });

  it('classifies only the exact engine sentences', () => {
    expect(isTimeBankRaceRefusal('Not Your Turn')).toBe(true);
    expect(isTimeBankRaceRefusal(' not your turn ')).toBe(true);
    expect(isTimeBankRaceRefusal('No Time Bank Uses Remaining')).toBe(false);
    expect(isTimeBankRaceRefusal('Server error (400)')).toBe(false);
    expect(isTimeBankRaceRefusal('Not Your Turn To Act On Seat 3')).toBe(false);
    expect(isTimeBankRaceRefusal(undefined)).toBe(false);
    expect(isTimeBankTurnGone('Not Your Turn')).toBe(true);
    expect(isTimeBankTurnGone('That decision is no longer active')).toBe(true);
    // Still hero's turn: TablePage's own handling of it is unchanged.
    expect(isTimeBankTurnGone('Your Time Bank Is Already Running')).toBe(false);
    expect(isTimeBankTurnGone('No Time Bank Uses Remaining')).toBe(false);
  });

  it('every race sentence is one the engine actually sends', () => {
    const root = resolve(__dirname, '../..');
    const engine = [
      'server/src/engine/ServerTableEngineBase.ts',
      'server/src/engine/ServerTableEngineTurns.ts',
      'server/src/lightning/LightningHandHost.ts',
    ]
      .map((file) => readFileSync(resolve(root, file), 'utf8'))
      .join('\n');
    for (const sentence of [
      'Not Your Turn',
      'No Active Hand At This Table',
      'No active hand',
      'That decision is no longer active',
      'Your Time Bank Is Already Running',
    ]) {
      expect(engine).toContain(`error: '${sentence}'`);
      expect(isTimeBankRaceRefusal(sentence)).toBe(true);
    }
  });
});

describe('the time bank button does not toast a press that crossed the turn', () => {
  const page = readFileSync(resolve(__dirname, '../../src/pages/TablePage.tsx'), 'utf8');
  const start = page.indexOf('const handleActivateTimeBank = useCallback(');
  const toastAt = page.indexOf(
    "toast?.error?.(result?.error || 'Could Not Start Your Time Bank')",
    start
  );
  const guardAt = page.indexOf('if (isTimeBankTurnGone(result?.error)) return;', start);

  it('returns before the error toast for a turn-gone refusal', () => {
    expect(start).toBeGreaterThan(-1);
    expect(guardAt).toBeGreaterThan(start);
    expect(toastAt).toBeGreaterThan(guardAt);
  });
});
