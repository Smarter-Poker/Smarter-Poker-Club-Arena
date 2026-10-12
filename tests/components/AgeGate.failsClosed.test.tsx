/**
 * The app's age gate shows when it should - including when it cannot find out.
 *
 * WHY THIS EXISTS. Found on the first on-device walkthrough, 2026-09-29: the
 * gate had never shown to anybody. It read `birthday, age_verified` off the
 * player's own profile; `age_verified` is revoked from players by the
 * profile-privacy lockdown, PostgREST refuses a whole select when any one
 * column is denied, and the unreadable-status branch rendered NOTHING. So a
 * total failure looked exactly like "this player is verified". 1,290 of 1,293
 * players had no date of birth on file and none was ever asked.
 *
 * These tests render the real component and pin the two properties that
 * failed: the status comes from the server function (never a table read that
 * a column grant can break), and a status that cannot be had SHOWS the gate.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, cleanup } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

const rpc = vi.fn();
// If anything reads the profile table, it gets exactly what production gave
// the old gate: PostgREST refusing the select because one column is revoked.
const denied = {
  data: null,
  error: { code: '42501', message: 'permission denied for table profiles' },
};
const from = vi.fn(() => {
  const chain: Record<string, unknown> = {};
  for (const m of ['select', 'eq']) chain[m] = () => chain;
  chain.maybeSingle = () => Promise.resolve(denied);
  return chain;
});
vi.mock('../../src/lib/supabase', () => ({
  supabase: {
    rpc: (...a: unknown[]) => rpc(...a),
    from: (...a: unknown[]) => from(...a),
    auth: { signOut: vi.fn(async () => ({ error: null })) },
  },
}));
vi.mock('../../src/hooks/useAuthUser', () => ({
  useAuthUser: () => ({ user: { id: 'player-1' }, isHydrating: false }),
}));
vi.mock('../../src/utils/errorReporter', () => ({ reportError: vi.fn() }));
// The gate is compiled in for the app build only; switch it on here.
vi.mock('../../src/lib/appBase', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/lib/appBase')>()),
  IS_NATIVE_BUILD: true,
}));

import AgeGate from '../../src/components/legal/AgeGate';

const renderAt = (path = '/') =>
  render(
    <MemoryRouter initialEntries={[path]}>
      <AgeGate />
    </MemoryRouter>
  );
const gate = () => screen.queryByRole('dialog', { name: /confirm your age/i });

describe('the app age gate', () => {
  beforeEach(() => {
    cleanup();
    rpc.mockReset();
    from.mockClear();
  });

  it('asks the server about the caller, and never reads the profile table itself', async () => {
    rpc.mockResolvedValue({ data: { ok: true, verified: true }, error: null });
    renderAt();
    await waitFor(() => expect(rpc).toHaveBeenCalledWith('fn_my_age_gate_status'));
    expect(from).not.toHaveBeenCalled();
  });

  it('shows for a player with no date of birth on file', async () => {
    rpc.mockResolvedValue({ data: { ok: true, verified: false }, error: null });
    renderAt();
    await waitFor(() => expect(gate()).not.toBeNull());
  });

  it('stays out of the way of a verified player', async () => {
    rpc.mockResolvedValue({ data: { ok: true, verified: true }, error: null });
    renderAt();
    await waitFor(() => expect(rpc).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 50));
    expect(gate()).toBeNull();
  });

  it('FAILS CLOSED: a status it cannot get shows the gate, after one retry', async () => {
    // Exactly the production failure: every read refused.
    rpc.mockResolvedValue({
      data: null,
      error: { code: '42501', message: 'permission denied for table profiles' },
    });
    renderAt();
    await waitFor(() => expect(gate()).not.toBeNull(), { timeout: 4000 });
    expect(rpc).toHaveBeenCalledTimes(2);
  });

  it('a single blip is retried, not mistaken for an outage', async () => {
    rpc
      .mockResolvedValueOnce({ data: null, error: { message: 'network' } })
      .mockResolvedValue({ data: { ok: true, verified: true }, error: null });
    renderAt();
    await waitFor(() => expect(rpc).toHaveBeenCalledTimes(2), { timeout: 4000 });
    await new Promise((r) => setTimeout(r, 50));
    expect(gate()).toBeNull();
  });

  it('a malformed answer is not a yes', async () => {
    rpc.mockResolvedValue({ data: { ok: false, reason: 'profile_not_found' }, error: null });
    renderAt();
    await waitFor(() => expect(gate()).not.toBeNull(), { timeout: 4000 });
  });

  it('never blocks the legal pages or sign-in, whatever the status', async () => {
    rpc.mockResolvedValue({ data: { ok: true, verified: false }, error: null });
    for (const path of ['/legal/privacy', '/auth', '/help']) {
      cleanup();
      renderAt(path);
      await new Promise((r) => setTimeout(r, 50));
      expect(gate(), path).toBeNull();
    }
  });
});
