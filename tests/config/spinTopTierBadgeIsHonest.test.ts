/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  THE SPIN TOP-TIER BADGE MUST NOT OUTLIVE ITS OWN NUMBER
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `useSpinTierAvailability` reads one boolean, `can_draw_100x`, from
 * `v_spin_tier_availability`. The lobby renders that boolean as a badge whose
 * LABEL carries the literal 100 - and the view's column name carries it too,
 * so neither side can be changed on its own without the other quietly
 * becoming a lie.
 *
 * That is fine while the top tier IS the 100x. The 500x was retired on
 * 2026-08-21 and the column went with it; if a future tier lands above the
 * 100x, this test is the thing that stops a badge saying "100x Live" on a
 * wheel whose headline prize is something else, or - worse - a badge sourced
 * from a boolean that no longer describes the tier it names.
 *
 * If this fails, the fix is NOT to change the number here. It is to add the
 * matching column to the view, point the hook at it, and then update the
 * label, the badge and this test together.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { act, cleanup, renderHook } from '@testing-library/react';
import { readFileSync } from 'fs';
import { join } from 'path';
import { SPIN_TIERS } from '../../src/config/spinSpec';

const root = join(__dirname, '..', '..');
const hookSrc = readFileSync(join(root, 'src/hooks/useSpinTierAvailability.ts'), 'utf8');
const lobbySrc = readFileSync(join(root, 'src/components/lobby/LobbyTable.tsx'), 'utf8');

describe('spin top-tier badge', () => {
  it('names the multiplier that is actually top of the wheel', () => {
    const top = SPIN_TIERS.reduce((a, b) => (b.multiplier > a.multiplier ? b : a));
    expect(top.multiplier).toBe(100);
  });

  it('reads the availability column that matches that multiplier', () => {
    expect(hookSrc).toContain('can_draw_100x');
    expect(hookSrc).toContain('v_spin_tier_availability');
  });

  it('labels the badge with the same multiplier the hook asks about', () => {
    expect(lobbySrc).toContain('const SPIN_TOP_MULTIPLIER = 100;');
    expect(lobbySrc).toContain('useSpinTierAvailability');
  });

  it('renders the badge only for spin rows and only when the flag is true', () => {
    expect(lobbySrc).toContain("e.kind === 'spin' && ctx.spinTopTierLive");
    expect(lobbySrc).toContain('spinTiers?.can_draw_100x === true');
  });

  it('gates the top tier on a reserve threshold, so the badge can be false', () => {
    const top = SPIN_TIERS.reduce((a, b) => (b.multiplier > a.multiplier ? b : a));
    expect(top.reserveThresholdX).toBeGreaterThan(0);
  });
});

const availabilityRead = vi.hoisted(() => ({ select: vi.fn() }));
vi.mock('../../src/lib/supabase', () => ({
  supabase: { from: () => ({ select: () => ({ abortSignal: availabilityRead.select }) }) },
}));
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('spin availability belongs to the requested club', () => {
  it('withholds the old club badge while a new club read is pending or absent', async () => {
    vi.resetModules();
    vi.useFakeTimers();
    vi.setSystemTime(100_000);
    availabilityRead.select.mockResolvedValueOnce({
      data: [{ club_id: 'club-a', can_draw_100x: true }],
      error: null,
    });
    const { useSpinTierAvailability } = await import('../../src/hooks/useSpinTierAvailability');
    const view = renderHook(({ clubId }) => useSpinTierAvailability(clubId), {
      initialProps: { clubId: 'club-a' as string | undefined },
    });
    await act(async () => {});
    expect(view.result.current?.can_draw_100x).toBe(true);
    vi.setSystemTime(200_000);
    let resolveRead!: (value: unknown) => void;
    availabilityRead.select.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveRead = resolve;
      })
    );
    view.rerender({ clubId: 'club-b' });
    expect(view.result.current).toBeNull();
    view.rerender({ clubId: undefined });
    expect(view.result.current).toBeNull();
    await act(async () => {
      resolveRead({ data: [{ club_id: 'club-b', can_draw_100x: false }], error: null });
    });
    expect(view.result.current).toBeNull();
    view.rerender({ clubId: 'club-b' });
    await act(async () => {});
    expect(view.result.current?.can_draw_100x).toBe(false);
  });
});

describe('spin availability freshness', () => {
  it('expires a mounted live claim without polling the reserve', async () => {
    vi.resetModules();
    vi.useFakeTimers();
    vi.setSystemTime(100_000);
    availabilityRead.select
      .mockReset()
      .mockResolvedValue({ data: [{ club_id: 'club-a', can_draw_100x: true }], error: null });
    const { useSpinTierAvailability } = await import('../../src/hooks/useSpinTierAvailability');
    const view = renderHook(() => useSpinTierAvailability('club-a'));
    await act(async () => {});
    expect(view.result.current?.can_draw_100x).toBe(true);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_001);
    });
    expect(view.result.current).toBeNull();
    expect(availabilityRead.select).toHaveBeenCalledTimes(1);
    availabilityRead.select.mockResolvedValue({
      data: [{ club_id: 'club-a', can_draw_100x: false }],
      error: null,
    });
    await act(async () => {
      window.dispatchEvent(new Event('focus'));
    });
    expect(view.result.current?.can_draw_100x).toBe(false);
  });
  it('does not reuse an expired true claim when a new read fails', async () => {
    vi.resetModules();
    vi.useFakeTimers();
    vi.setSystemTime(100_000);
    availabilityRead.select
      .mockReset()
      .mockResolvedValueOnce({ data: [{ club_id: 'club-a', can_draw_100x: true }], error: null });
    const { useSpinTierAvailability } = await import('../../src/hooks/useSpinTierAvailability');
    const first = renderHook(() => useSpinTierAvailability('club-a'));
    await act(async () => {});
    first.unmount();
    vi.setSystemTime(200_000);
    availabilityRead.select.mockResolvedValueOnce({
      data: null,
      error: new Error('read unavailable'),
    });
    const next = renderHook(() => useSpinTierAvailability('club-a'));
    expect(next.result.current).toBeNull();
    await act(async () => {});
    expect(next.result.current).toBeNull();
  });
  it('releases a hung shared read so a later focus can obtain current availability', async () => {
    vi.resetModules();
    vi.useFakeTimers();
    vi.setSystemTime(100_000);
    let resolveOld!: (value: unknown) => void;
    availabilityRead.select.mockReset().mockReturnValueOnce(
      new Promise((resolve) => {
        resolveOld = resolve;
      })
    );
    const { useSpinTierAvailability } = await import('../../src/hooks/useSpinTierAvailability');
    const view = renderHook(() => useSpinTierAvailability('club-a'));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(12_001);
    });
    expect(view.result.current).toBeNull();
    availabilityRead.select.mockResolvedValueOnce({
      data: [{ club_id: 'club-a', can_draw_100x: true }],
      error: null,
    });
    await act(async () => {
      window.dispatchEvent(new Event('focus'));
    });
    expect(view.result.current?.can_draw_100x).toBe(true);
    await act(async () => {
      resolveOld({ data: [{ club_id: 'club-a', can_draw_100x: false }], error: null });
    });
    expect(view.result.current?.can_draw_100x).toBe(true);
  });
  it('does not turn a malformed boolean into a payable claim', async () => {
    vi.resetModules();
    vi.useFakeTimers();
    vi.setSystemTime(100_000);
    availabilityRead.select.mockReset().mockResolvedValueOnce({
      data: [{ club_id: 'club-a', can_draw_100x: 'false' }],
      error: null,
    });
    const { useSpinTierAvailability } = await import('../../src/hooks/useSpinTierAvailability');
    const view = renderHook(() => useSpinTierAvailability('club-a'));
    await act(async () => {});
    expect(view.result.current).toBeNull();
  });
});
