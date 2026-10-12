/**
 * An under-18 answer is refused, signs the account out, and SAYS SO.
 *
 * WHY THIS EXISTS. Found on the device walkthrough, 2026-09-29: the refusal
 * message lived inside the gate, and the gate renders nothing for a
 * signed-out player or on /auth. So the sign-out that follows a refusal
 * unmounted the message about half a second after it appeared, and the
 * player landed on the sign-in screen with no explanation. Measured on the
 * emulator: refusal visible at +150ms, gone by +600ms, URL /auth.
 *
 * These tests drive the real component through the whole sequence - answer,
 * sign-out, redirect to /auth - and pin that the refusal is still on screen
 * at the end of it, and that a minor's date of birth never leaves the device.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, useLocation, useNavigate } from 'react-router-dom';
import { useEffect } from 'react';

let currentUser: { id: string } | null = { id: 'player-1' };
const rpc = vi.fn();
const signOut = vi.fn(async () => {
  currentUser = null;
  return { error: null };
});
vi.mock('../../src/lib/supabase', () => ({
  supabase: {
    rpc: (...a: unknown[]) => rpc(...a),
    auth: { signOut: (...a: unknown[]) => signOut(...(a as [])) },
  },
}));
vi.mock('../../src/hooks/useAuthUser', () => ({
  useAuthUser: () => ({ user: currentUser, isHydrating: false }),
}));
vi.mock('../../src/utils/errorReporter', () => ({ reportError: vi.fn() }));
vi.mock('../../src/lib/appBase', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/lib/appBase')>()),
  IS_NATIVE_BUILD: true,
}));

import AgeGate from '../../src/components/legal/AgeGate';

/** What AuthGuard does in the app: a signed-out player is sent to /auth. */
function SendSignedOutToAuth() {
  const navigate = useNavigate();
  const { pathname } = useLocation();
  useEffect(() => {
    if (!currentUser && pathname !== '/auth') navigate('/auth?redirect=%2F', { replace: true });
  });
  return null;
}

const tree = () => (
  <MemoryRouter initialEntries={['/']}>
    <SendSignedOutToAuth />
    <AgeGate />
  </MemoryRouter>
);

function isoYearsAgo(years: number): string {
  const d = new Date();
  d.setFullYear(d.getFullYear() - years);
  return d.toISOString().slice(0, 10);
}

async function answer(dob: string) {
  const input = await screen.findByLabelText(/date of birth/i);
  fireEvent.change(input, { target: { value: dob } });
  fireEvent.click(screen.getByRole('button', { name: /continue/i }));
}

describe('the age gate refusal', () => {
  beforeEach(() => {
    cleanup();
    currentUser = { id: 'player-1' };
    rpc.mockReset();
    signOut.mockClear();
    rpc.mockImplementation(async (fn: string) =>
      fn === 'fn_my_age_gate_status'
        ? { data: { ok: true, verified: false }, error: null }
        : { data: { ok: true }, error: null }
    );
  });

  it('stays on screen through the sign-out and the redirect to /auth, until closed', async () => {
    const view = render(tree());
    await answer(isoYearsAgo(12));

    await waitFor(() => expect(signOut).toHaveBeenCalledTimes(1));
    // The session is gone: re-render as the app would, and let the redirect run.
    await act(async () => {
      view.rerender(tree());
    });
    await new Promise((r) => setTimeout(r, 50));

    const refusal = screen.getByRole('alertdialog', { name: /confirm your age/i });
    expect(refusal.textContent).toMatch(/must be 18 or older/i);
    expect(refusal.textContent).toMatch(/signed out/i);

    fireEvent.click(screen.getByRole('button', { name: /close/i }));
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });

  it("never sends a minor's date of birth anywhere", async () => {
    render(tree());
    await answer(isoYearsAgo(15));
    await waitFor(() => expect(signOut).toHaveBeenCalled());
    const called = rpc.mock.calls.map((c) => c[0]);
    expect(called).not.toContain('fn_set_my_birthday');
  });

  it('an adult is written once through the server function and let through', async () => {
    render(tree());
    const dob = isoYearsAgo(30);
    await answer(dob);
    await waitFor(() =>
      expect(rpc).toHaveBeenCalledWith('fn_set_my_birthday', { p_birthday: dob })
    );
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(signOut).not.toHaveBeenCalled();
  });
});
