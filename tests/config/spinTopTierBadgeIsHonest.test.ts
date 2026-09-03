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

import { describe, it, expect } from 'vitest';
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
