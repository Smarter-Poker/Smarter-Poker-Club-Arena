/**
 * THE DAILY FREE SPIN LEAVES THE BUILDING (2026-09-11, BINDING)
 *
 * Dan 2026-09-10 replaced the daily free spin with a one-time welcome spin:
 * "free spin should be once for a new user 100 diamonds ... All paid for by the
 * promo wallet." The replacement was built. The thing it replaced was left
 * standing, and on 2026-09-11 an audit found what that cost:
 *
 *   - free_spin_daily_budget_diamonds was read by NOTHING, sat at 2000 on both
 *     hosts, and could still be written by the operator console. A number a
 *     person can set that governs nothing is a trap, not a leftover;
 *   - free_spin_enabled had become the WELCOME spin's on/off switch while
 *     keeping the retired feature's name, so every reader was reasoning about a
 *     different feature than the name describes;
 *   - fn_wheel_free_history and fn_wheel_free_spin_result still answered over
 *     wheel_free_spins and wheel_free_segments, tables nothing writes;
 *   - and the DiamondWheel component still carried a `free` prop that re-inked
 *     the rim by amount instead of by kind, a rule written for the retired
 *     five-prize all-diamond table. The welcome spin draws the REAL wheel, so
 *     that rule was about to paint the real table by the wrong scheme.
 *
 * This law is what stops any of it coming back, and what stops the NEXT
 * replacement being left half-done: a feature is retired when its columns, its
 * functions, its tables, its payload keys and its client code all stop
 * describing it, not when something better exists beside it.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, existsSync } from 'fs';
import { resolve } from 'path';

const DIR = resolve(__dirname, '..', 'supabase/migrations');
const ROOT = resolve(__dirname, '..');
const files = readdirSync(DIR).filter((f) => f.endsWith('.sql'));

function latest(fragment: string): string {
  const name = files
    .filter((f) => f.includes(fragment))
    .sort()
    .pop();
  expect(name, `no migration named like ${fragment}`).toBeTruthy();
  return readFileSync(resolve(DIR, name as string), 'utf8');
}
const src = (p: string) => readFileSync(resolve(ROOT, p), 'utf8');

const OUT = latest('the_daily_free_spin_leaves_the_building');

/** Every migration that runs AFTER the retirement, so a later one cannot undo it. */
const AFTER = files
  .filter((f) => f >= '20260911052216')
  .map((f) => readFileSync(resolve(DIR, f), 'utf8'))
  .join('\n');

describe('the dead column is gone, not deprecated in a comment', () => {
  it('is dropped in the migration', () => {
    expect(OUT).toContain(
      'ALTER TABLE public.wheel_configs DROP COLUMN IF EXISTS free_spin_daily_budget_diamonds;'
    );
  });

  it('and nothing brings it back', () => {
    expect(AFTER).not.toMatch(/ADD COLUMN[^;]*free_spin_daily_budget_diamonds/);
  });
});

describe('the switch is named after the feature it governs', () => {
  it('free_spin_enabled is renamed, not shadowed by a second column', () => {
    expect(OUT).toContain(
      'ALTER TABLE public.wheel_configs RENAME COLUMN free_spin_enabled TO welcome_spin_enabled;'
    );
    expect(AFTER).not.toMatch(/ADD COLUMN[^;]*\bfree_spin_enabled\b/);
  });

  it('the client asks for the new name and no longer knows the old one', () => {
    const service = src('src/services/DiamondWheelService.ts');
    expect(service).toContain('welcome_spin_enabled');
    expect(service).not.toContain('free_spin_enabled');
    expect(service).not.toContain('fn_wheel_free_state');
    expect(service).not.toContain('fn_wheel_free_spin');
    expect(service).not.toContain('fn_wheel_set_free_spin');
  });
});

describe('the old doors are removed, not left answering beside the new ones', () => {
  it.each([
    ['fn_wheel_free_state(uuid)'],
    ['fn_wheel_free_spin(uuid, uuid, text)'],
    ['fn_wheel_set_free_spin(uuid, jsonb)'],
    ['fn_wheel_free_history(uuid, integer)'],
    ['fn_wheel_free_spin_result(public.wheel_free_spins)'],
  ])('%s is dropped', (sig) => {
    expect(OUT).toContain(`DROP FUNCTION IF EXISTS public.${sig};`);
  });

  it('and the new ones say who may knock', () => {
    for (const sig of [
      'fn_wheel_welcome_state(uuid)',
      'fn_wheel_welcome_spin(uuid, uuid, text)',
      'fn_wheel_set_welcome_spin(uuid, jsonb)',
    ]) {
      expect(OUT).toContain(`REVOKE ALL ON FUNCTION public.${sig} FROM PUBLIC;`);
      expect(OUT).toContain(`REVOKE ALL ON FUNCTION public.${sig} FROM anon;`);
      expect(OUT).toContain(`GRANT EXECUTE ON FUNCTION public.${sig} TO authenticated;`);
    }
    // The window helper is internal: no browser role may call it at all.
    expect(OUT).toContain(
      'REVOKE ALL ON FUNCTION public.fn_wheel_welcome_spent(uuid, integer) FROM authenticated;'
    );
  });
});

describe('the retired tables are registered, so a future read fails the build', () => {
  it('in the database registry', () => {
    expect(OUT).toContain('INSERT INTO public.deprecated_tables');
    expect(OUT).toContain("('wheel_free_spins',");
    expect(OUT).toContain("('wheel_free_segments',");
  });

  it('and in the gate that scans source, which is what actually catches a reader', () => {
    const gate = src('scripts/ci/check-deprecated-tables.mjs');
    expect(gate).toContain("wheel_free_spins: 'wheel_spins WHERE is_welcome'");
    expect(gate).toContain("wheel_free_segments: 'wheel_segments'");
  });
});

describe('the browser stops describing a feature that is gone', () => {
  it('the wheel no longer inks a rim for the retired five-prize table', () => {
    const wheel = src('src/components/wheel/DiamondWheel.tsx');
    expect(wheel).toContain('function materialClass(seg: WheelSegment): string {');
    expect(wheel).not.toContain('free?: boolean;');
    expect(wheel).not.toContain('materialClass(seg, free)');
  });

  it('the games hub no longer offers one free spin a day paid in diamonds', () => {
    const hub = src('src/pages/DiamondGamesPage.tsx');
    expect(hub).not.toContain('Free Spin');
    expect(hub).not.toContain('One Free Spin A Day');
    expect(hub).toContain('Welcome Spin');
  });

  it('the wheel page reads the welcome flag, not the retired one', () => {
    const page = src('src/pages/DiamondWheelPage.tsx');
    expect(page).toContain('WheelWelcomeState');
    expect(page).not.toContain('result.free');
    expect(page).not.toContain('lastResult.free');
  });

  it('the retired test file went with the feature', () => {
    expect(existsSync(resolve(ROOT, 'tests/unit/wheelFreeSpin.test.ts'))).toBe(false);
    expect(existsSync(resolve(ROOT, 'tests/unit/wheelWelcomeSpin.test.ts'))).toBe(true);
  });
});

describe('the operator can set the window, and cannot set a silly one', () => {
  it('the column carries its own floor', () => {
    expect(OUT).toContain(
      'ADD COLUMN IF NOT EXISTS welcome_budget_period_days integer NOT NULL DEFAULT 30'
    );
    expect(OUT).toContain('CHECK (welcome_budget_period_days >= 0)');
  });

  it('and the door refuses a negative in words before the constraint has to', () => {
    expect(OUT).toContain('The Welcome Budget Period Cannot Be Negative');
  });

  it('the console offers the window beside the budget', () => {
    const ops = src('src/pages/club/ClubWheelOperationsPage.tsx');
    expect(ops).toContain('welcome_budget_period_days');
    expect(ops).toContain('Budget Window (Days)');
  });
});
