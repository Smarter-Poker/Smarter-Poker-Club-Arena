/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  A SPIN'S LADDER IS ONE LADDER (2026-09-02)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * MEASURED. 95 completed Spins at 10x and above paid first place the WHOLE
 * pool and second (and third) nothing, because tournaments.payout_structure on
 * their own row had been overwritten with `[{"place":1,"percentage":100}]`.
 * 1,878.00 chips, 92 games, 69 players, all back-paid on 2026-09-02.
 *
 * Two different causes, one column:
 *   * the engine's cache dropped payout_structure from the draw patch (#2645);
 *   * fn_ca_fund_overlay_on_lock rewrote the ladder from the SIZE OF THE FIELD
 *     ("pay the top N%"), which on three seats rounds to one place.
 *
 * WHY A LAW AND NOT JUST A FIX. The ladder is now written down in two places -
 * SPIN_TIERS in the engine, and public.spin_payout_ladder in the database,
 * because the payout auditor runs in SQL and had no way to tell a drawn ladder
 * from an overwritten one. Two copies of a number is exactly how the four
 * disagreeing multiplier tables happened (see the note above SPIN_RAKE_RATE).
 * This test is what stops them drifting apart.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(__dirname, '..');
const spec = readFileSync(resolve(root, 'server/src/config/spinSpec.ts'), 'utf8');

const seedFile = readdirSync(resolve(root, 'supabase/migrations')).find((f) =>
  f.includes('the_spin_ladder_written_down_where_the_auditor_can_read_it')
);

/** multiplier -> payouts, read out of SPIN_TIERS itself. */
function laddersFromSpec(): Map<number, number[]> {
  const out = new Map<number, number[]>();
  const arr = spec.slice(spec.indexOf('export const SPIN_TIERS'));
  const re = /multiplier:\s*(\d+)[\s\S]*?payouts:\s*\[([^\]]*)\]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(arr))) {
    out.set(
      Number(m[1]),
      m[2]
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
        .map(Number)
    );
  }
  return out;
}

/** multiplier -> percentages, read out of the migration that seeds the table. */
function laddersFromSql(): Map<number, number[]> {
  const out = new Map<number, number[]>();
  if (!seedFile) return out;
  const sql = readFileSync(resolve(root, 'supabase/migrations', seedFile), 'utf8');
  const block = sql.slice(sql.indexOf('INSERT INTO public.spin_payout_ladder'));
  const re = /\((\d+),\s*'(\[[^']*\])'::jsonb\)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(block))) {
    const places = JSON.parse(m[2]) as Array<{ place: number; percentage: number }>;
    out.set(
      Number(m[1]),
      places.sort((a, b) => a.place - b.place).map((p) => p.percentage)
    );
  }
  return out;
}

describe('the engine and the database owe the same Spin ladder', () => {
  it('the migration that seeds the database ladder is still in the repo', () => {
    // Applied straight to production and never committed is how the repo and
    // the database drift; the 17:11 ladder fix on 2026-09-02 was exactly that.
    expect(seedFile, 'spin_payout_ladder seed migration is missing').toBeTruthy();
  });

  it('every multiplier in SPIN_TIERS has a row in the database ladder', () => {
    const fromSpec = laddersFromSpec();
    const fromSql = laddersFromSql();
    expect(fromSpec.size, 'no tiers parsed from spinSpec.ts').toBeGreaterThan(0);
    for (const mult of fromSpec.keys()) {
      expect(fromSql.has(mult), `multiplier ${mult}x is missing from spin_payout_ladder`).toBe(
        true
      );
    }
  });

  it('and pays exactly the same shares, place for place', () => {
    const fromSpec = laddersFromSpec();
    const fromSql = laddersFromSql();
    for (const [mult, payouts] of fromSpec) {
      const asPercent = payouts.map((p) => Math.round(p * 100));
      expect(fromSql.get(mult), `${mult}x disagrees between spinSpec.ts and the database`).toEqual(
        asPercent
      );
    }
  });

  it('10x is 80/20 and 25x/50x/100x are 80/12/8 - the shares that were underpaid', () => {
    const fromSpec = laddersFromSpec();
    expect(fromSpec.get(10)).toEqual([0.8, 0.2]);
    for (const m of [25, 50, 100]) expect(fromSpec.get(m)).toEqual([0.8, 0.12, 0.08]);
  });

  it('every share adds up to the whole pool', () => {
    for (const [mult, payouts] of laddersFromSpec()) {
      const total = payouts.reduce((a, b) => a + b, 0);
      expect(Math.abs(total - 1) < 1e-9, `${mult}x pays ${total} of the pool, not all of it`).toBe(
        true
      );
    }
  });
});

describe('the guard that restores the ladder still runs last', () => {
  const migrations = readdirSync(resolve(root, 'supabase/migrations'));
  const attach = migrations.find((f) => f.includes('attach_the_spin_ladder_guard'));

  it('the guard is attached to tournaments', () => {
    expect(attach, 'attach_the_spin_ladder_guard migration is missing').toBeTruthy();
    const sql = readFileSync(resolve(root, 'supabase/migrations', attach!), 'utf8');
    expect(sql).toMatch(/CREATE TRIGGER\s+zzz_spin_ladder_is_the_drawn_one/);
  });

  it('and its name still sorts AFTER the trigger that overwrote the ladder', () => {
    /**
     * Postgres fires BEFORE triggers in alphabetical order. The trigger that
     * caused this is attached as `zz_ca_fund_overlay_on_lock`; the guard has to
     * sort after it to correct what it writes. Rename either one without the
     * other and the guard runs first, corrects nothing, and the hole re-opens
     * silently - which is the failure mode this whole law exists for.
     */
    const guard = 'zzz_spin_ladder_is_the_drawn_one';
    const offender = 'zz_ca_fund_overlay_on_lock';
    expect(guard > offender, `${guard} must sort after ${offender}`).toBe(true);
  });

  it('normalises rather than refusing, so it can never stop a Spin starting', () => {
    const seed = readFileSync(resolve(root, 'supabase/migrations', seedFile!), 'utf8');
    const fn = seed.slice(seed.indexOf('fn_spin_ladder_is_the_drawn_one'));
    expect(fn).toMatch(/NEW\.payout_structure\s*:=\s*v_expected::text/);
    // A guard that can refuse is a guard that can strand a game.
    expect(fn).not.toMatch(/RAISE EXCEPTION/);
  });
});
