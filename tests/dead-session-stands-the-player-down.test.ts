/**
 * A signed-out tab must STOP BEING AT A TABLE, not just show an error.
 *
 * Dan 2026-09-03. The database half is migration 20260903213000; this is the
 * client half. When a money door answers SESSION_REVOKED, or the engine
 * answers 401, the felt must come down - signing this device out unmounts
 * every TablePage (PersistentTableLayer renders nothing without a user) and
 * closes every engine socket.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const signOut = vi.fn(async () => ({ error: null }));
vi.mock('../src/lib/supabase', () => ({
  supabase: { auth: { signOut: (o: unknown) => signOut(o) } },
}));
vi.mock('../src/utils/errorReporter', () => ({ reportError: vi.fn() }));

let mod: typeof import('../src/lib/deadSession');
let assign: ReturnType<typeof vi.fn>;

beforeEach(async () => {
  vi.resetModules();
  signOut.mockClear();
  assign = vi.fn();
  vi.stubGlobal('window', { location: { assign } });
  mod = await import('../src/lib/deadSession');
});
afterEach(() => {
  mod.__resetStandDownForTests();
  vi.unstubAllGlobals();
});

describe('isDeadSessionError', () => {
  it('recognises the money door refusal', () => {
    expect(
      mod.isDeadSessionError({
        message: 'SESSION_REVOKED: this session is signed out - sign in again',
      })
    ).toBe(true);
  });

  it('recognises the shapes PostgREST and GoTrue use', () => {
    expect(mod.isDeadSessionError({ message: 'JWT expired' })).toBe(true);
    expect(mod.isDeadSessionError({ code: 'PGRST301' })).toBe(true);
    expect(mod.isDeadSessionError({ status: 401 })).toBe(true);
  });

  it('does NOT claim an ordinary game-rule refusal', () => {
    // These must keep their own message and must never sign anybody out.
    expect(mod.isDeadSessionError({ message: 'Buy-in below table minimum (min 200)' })).toBe(false);
    expect(
      mod.isDeadSessionError({ message: 'TABLE_SIZE: table is full (6 of 6 seats taken)' })
    ).toBe(false);
    expect(mod.isDeadSessionError({ message: 'NIT_GAME: this table needs a career VPIP' })).toBe(
      false
    );
    expect(mod.isDeadSessionError(null)).toBe(false);
  });
});

describe('standDownDeadSession', () => {
  it('signs THIS device out and leaves the table', async () => {
    expect(mod.standDownDeadSession('test')).toBe(true);
    await vi.waitFor(() => expect(signOut).toHaveBeenCalled());
    // local scope: the player's other devices are not revoked by this tab.
    expect(signOut).toHaveBeenCalledWith({ scope: 'local' });
    await vi.waitFor(() => expect(assign).toHaveBeenCalled());
    expect(String(assign.mock.calls[0][0])).toContain('/auth');
  });

  it('is idempotent: many doors failing at once produce ONE sign-out', async () => {
    expect(mod.standDownDeadSession('buyin')).toBe(true);
    expect(mod.standDownDeadSession('rebuy')).toBe(false);
    expect(mod.standDownDeadSession('action')).toBe(false);
    await vi.waitFor(() => expect(signOut).toHaveBeenCalledTimes(1));
    expect(assign).toHaveBeenCalledTimes(1);
  });

  it('still leaves the table even when sign-out itself fails', async () => {
    signOut.mockRejectedValueOnce(new Error('network'));
    mod.standDownDeadSession('test');
    await vi.waitFor(() => expect(assign).toHaveBeenCalled());
  });
});
