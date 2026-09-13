/**
 * THE RAIL MUST NOT SELL TO SOMEONE WHO ASKED TO BE STOPPED
 *
 * Two states, and this component knew about neither until 2026-09-13.
 *
 * The responsible-gaming one could not even be ASKED honestly. Proven in a
 * rolled-back transaction against production: for one self-excluded user, on
 * the same function, the house saw
 *   {"ok": false, "error": "self_excluded", ...}
 * and the player's own client saw
 *   {"ok": true,  "reason": "no_limits_set"}
 * because `fn_rg_require_not_excluded` is not SECURITY DEFINER and the limits
 * table had no policy admitting the user a row is about. The migration beside
 * this file closes that; these tests pin the client half.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { renderHook, waitFor } from '@testing-library/react';

const mocks = vi.hoisted(() => ({
  rpc: vi.fn(),
  session: vi.fn(),
  breakState: { active: false, breakEndsAtMs: null as number | null },
  reportError: vi.fn(),
}));

vi.mock('../../src/lib/supabase', () => ({ supabase: { rpc: mocks.rpc } }));
vi.mock('../../src/lib/authUtils', () => ({ readLocalSession: mocks.session }));
vi.mock('../../src/utils/errorReporter', () => ({
  reportError: mocks.reportError,
  reportWarning: vi.fn(),
}));
vi.mock('../../src/hooks/useMaintenanceBreak', () => ({
  useMaintenanceBreak: () => ({ maintenanceBreak: mocks.breakState }),
}));
vi.mock('../../src/hooks/useMasterBusSubscription', () => ({
  useMasterBusSubscription: () => {},
}));

import {
  resetRailSilenceCache,
  SPEAK_WHEN_UNKNOWN,
  useRailSilence,
} from '../../src/components/tournament/useRailSilence';

const UID = '11111111-2222-3333-4444-555555555555';

beforeEach(() => {
  resetRailSilenceCache();
  mocks.rpc.mockReset();
  mocks.reportError.mockReset();
  mocks.session.mockReturnValue({ userId: UID });
  mocks.breakState.active = false;
});

describe('a player who asked to be stopped', () => {
  it('silences the bar for a self-excluded player', async () => {
    mocks.rpc.mockResolvedValue({
      data: { ok: false, error: 'self_excluded', self_excluded_until: '2026-10-13' },
      error: null,
    });
    const { result } = renderHook(() => useRailSilence());
    await waitFor(() => expect(result.current.silent).toBe(true));
    expect(result.current.reason).toBe('self_excluded');
  });

  it('silences it for a cooling-off player too, and says which', async () => {
    mocks.rpc.mockResolvedValue({
      data: { ok: false, error: 'cooling_off', cooling_off_until: '2026-09-20' },
      error: null,
    });
    const { result } = renderHook(() => useRailSilence());
    await waitFor(() => expect(result.current.silent).toBe(true));
    expect(result.current.reason).toBe('cooling_off');
  });

  it('asks about THIS player, never about a user id from anywhere else', async () => {
    mocks.rpc.mockResolvedValue({ data: { ok: true }, error: null });
    renderHook(() => useRailSilence());
    await waitFor(() => expect(mocks.rpc).toHaveBeenCalled());
    expect(mocks.rpc).toHaveBeenCalledWith('fn_rg_require_not_excluded', {
      p_user_id: UID,
    });
  });

  it('lets the bar speak to a player with no limits set', async () => {
    mocks.rpc.mockResolvedValue({ data: { ok: true, reason: 'no_limits_set' }, error: null });
    const { result } = renderHook(() => useRailSilence());
    await waitFor(() => expect(mocks.rpc).toHaveBeenCalled());
    expect(result.current.silent).toBe(false);
  });

  it('asks once per player, not once per mount', async () => {
    mocks.rpc.mockResolvedValue({ data: { ok: true }, error: null });
    const first = renderHook(() => useRailSilence());
    await waitFor(() => expect(mocks.rpc).toHaveBeenCalledTimes(1));
    first.unmount();
    renderHook(() => useRailSilence());
    await waitFor(() => expect(mocks.rpc).toHaveBeenCalledTimes(1));
  });

  it('never remembers an answer it did not get', async () => {
    /* An unknown is not a "no". Caching it would make one blip permanent for
       the life of the tab. */
    mocks.rpc.mockResolvedValueOnce({ data: null, error: { message: 'network' } });
    const first = renderHook(() => useRailSilence());
    await waitFor(() => expect(mocks.reportError).toHaveBeenCalled());
    first.unmount();

    mocks.rpc.mockResolvedValueOnce({
      data: { ok: false, error: 'self_excluded' },
      error: null,
    });
    const second = renderHook(() => useRailSilence());
    await waitFor(() => expect(second.result.current.silent).toBe(true));
  });

  it('follows the policy in the constant when the read fails', async () => {
    mocks.rpc.mockResolvedValue({ data: null, error: { message: 'network' } });
    const { result } = renderHook(() => useRailSilence());
    await waitFor(() => expect(mocks.reportError).toHaveBeenCalled());
    expect(result.current.silent).toBe(!SPEAK_WHEN_UNKNOWN);
  });
});

describe('the house is closed', () => {
  it('silences the bar during the hourly maintenance break', async () => {
    mocks.rpc.mockResolvedValue({ data: { ok: true }, error: null });
    mocks.breakState.active = true;
    const { result } = renderHook(() => useRailSilence());
    await waitFor(() => expect(result.current.silent).toBe(true));
    expect(result.current.reason).toBe('maintenance_break');
  });

  it('outranks everything: a frozen house sells nothing to anybody', async () => {
    mocks.rpc.mockResolvedValue({ data: { ok: true }, error: null });
    mocks.breakState.active = true;
    const { result } = renderHook(() => useRailSilence());
    await waitFor(() => expect(result.current.reason).toBe('maintenance_break'));
  });
});

describe('the container actually obeys it', () => {
  const TICKER = readFileSync(
    resolve(__dirname, '../../src/components/tournament/TournamentStartingTicker.tsx'),
    'utf8'
  );

  it('gates visibility on the silence, not merely on the settings', () => {
    expect(TICKER).toContain('const silence = useRailSilence();');
    const BLOCK = TICKER.slice(
      TICKER.indexOf('const barVisible ='),
      TICKER.indexOf('/* The strip retracts')
    );
    expect(BLOCK).toContain('!silence.silent');
  });
});

describe('the migration that makes the question answerable ships alongside', () => {
  const SQL = readFileSync(
    resolve(
      __dirname,
      '../../supabase/migrations/20260913172658_a_player_can_see_their_own_responsible_gaming_state.sql'
    ),
    'utf8'
  );

  it('adds a select policy scoped to the caller, not a definer function', () => {
    /* A definer would answer for ANY user id passed to it, and one person's
       self-exclusion is not a fact other players get to query. */
    expect(SQL).toContain('CREATE POLICY rg_limits_user_select_own');
    expect(SQL).toContain('FOR SELECT');
    expect(SQL).toContain('user_id = (SELECT auth.uid())');
    /* Scoped to what the migration DOES, not what it discusses: the rationale
       explains why a definer function was rejected, so a bare string search
       for those two words matches the prose. It creates no function at all. */
    expect(SQL).not.toMatch(/CREATE\s+(OR\s+REPLACE\s+)?FUNCTION/i);
  });

  it('hoists auth.uid(), which the estate guard requires', () => {
    expect(SQL).not.toMatch(/USING \(user_id = auth\.uid\(\)\)/);
  });

  it('is one transaction, per the production DDL policy', () => {
    expect(SQL).toContain('BEGIN;');
    expect(SQL).toContain('COMMIT;');
    expect((SQL.match(/^BEGIN;/gm) || []).length).toBe(1);
  });

  it('proves the behaviour rather than asserting the policy exists', () => {
    expect(SQL).toContain('fn_rg_require_not_excluded');
    expect(SQL).toContain('the player is still told they are fine');
  });

  it('leaves the table as it found it', () => {
    expect(SQL).toContain('DELETE FROM public.responsible_gaming_limits');
  });
});
