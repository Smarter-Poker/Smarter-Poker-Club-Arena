/**
 * THE WHEEL NEVER PAYS MORE THAN IT TAKES IN (Dan, 2026-09-07, BINDING)
 *
 * Dan: "House edge on this should be 20% and never pay more out than we take
 * in." And the same day: "1 diamond = 1 cent, 1 chip = 1 dollar."
 *
 * The Diamond Wheel (supabase/migrations/20260907233833_the_diamond_wheel.sql)
 * keeps both by ARITHMETIC, not by an odds table being honest:
 *
 *   - the prize table version that is active must return exactly 0.800000 of
 *     the spin and its weights must sum to 100,000, or it cannot be activated;
 *   - a chip prize is drawable only when chips_paid + prize <=
 *     chips_minted + this spin's mint + the host's exposure allowance, AND the
 *     host bank holds it; a diamond prize only when the diamond float covers
 *     it; a locked tier is left out of the draw and shown as locked;
 *   - the chip share of every spin is MINTED to the host through the declared
 *     issuance door (mint / issuance_reserve, registered by the chip_ledger
 *     issuance trigger), the diamond share accrues to the float, and the rest
 *     is retired diamonds: the house;
 *   - after every spin the pool re-checks paid <= minted + allowance and
 *     raises if the gate was bypassed;
 *   - the rate is a row (ca_bridge_rate), read by fn_ca_bridge_rate(); neither
 *     the wheel nor the owner bridge carries a literal.
 *
 * Every pin below is one of those. Weakening one re-opens a faucet.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'fs';
import { resolve } from 'path';

const DIR = resolve(__dirname, '..', 'supabase/migrations');
const files = readdirSync(DIR);

function latest(fragment: string): { name: string; sql: string } {
  const name = files
    .filter((f) => f.includes(fragment))
    .sort()
    .pop();
  expect(name, `no migration named like ${fragment}`).toBeTruthy();
  return { name: name as string, sql: readFileSync(resolve(DIR, name as string), 'utf8') };
}

function body(sql: string, fn: string): string {
  const open = sql.lastIndexOf(`CREATE OR REPLACE FUNCTION public.${fn}(`);
  expect(open, `${fn} has moved or gone`).toBeGreaterThan(-1);
  const start = sql.indexOf('$function$', open);
  const end = sql.indexOf('$function$', start + 10);
  expect(end).toBeGreaterThan(start);
  return sql.slice(start, end);
}

const wheel = latest('_the_diamond_wheel');
const bridge = latest('the_bridge_rate_is_a_row');
const word = latest('the_ledger_learns_the_word_wheel_prize');
const autoskip = latest('the_wheel_clears_its_autoskip');
const guard = latest('the_profile_guard_admits_the_wheel');

/** The spin body as it stands after the fix-forward migrations. */
const SPIN = body(autoskip.sql, 'fn_wheel_spin');

describe('the rate is a row, never a literal', () => {
  it('ca_bridge_rate reads 100 diamonds per chip and is read through fn_ca_bridge_rate()', () => {
    expect(bridge.sql).toMatch(/CREATE TABLE IF NOT EXISTS public\.ca_bridge_rate/);
    expect(bridge.sql).toMatch(
      /VALUES \(1, 100, 'Dan 2026-09-07: 1 diamond = 1 cent, 1 chip = 1 dollar/
    );
    expect(bridge.sql).toMatch(/CREATE OR REPLACE FUNCTION public\.fn_ca_bridge_rate\(\)/);
    expect(bridge.sql).toMatch(/AFTER INSERT OR UPDATE ON public\.ca_bridge_rate/);
  });

  it('the owner bridge divides by the row and refuses a fraction of a cent', () => {
    const b = body(bridge.sql, 'fn_mint_chips_from_diamonds');
    expect(b).toContain('v_rate := public.fn_ca_bridge_rate();');
    expect(b).toContain('v_chips := round(v_diamonds / v_rate, 2);');
    expect(b).not.toContain('v_diamonds * 100');
    expect(b).toContain('v_chips * v_rate <> v_diamonds');
  });

  it('the wheel reads the same row and never a literal', () => {
    expect(SPIN).toContain('v_rate integer := public.fn_ca_bridge_rate();');
    expect(SPIN).toContain('v_intake := v_price::numeric / v_rate;');
    // The only 100 in the body is the cents rounding of the mint carry.
    expect(SPIN).not.toMatch(/v_rate\s*:=\s*\d/);
    expect(SPIN).not.toContain('v_diamonds * 100');
  });
});

describe('the prize table returns exactly 80 percent or it cannot be activated', () => {
  it('activation refuses any table off 100,000 weight or off 0.800000 return', () => {
    const a = body(wheel.sql, 'fn_wheel_activate_segments');
    expect(a).toContain('IF a.weight_total <> 100000 THEN');
    expect(a).toContain('IF a.spec_rtp <> 0.800000 THEN');
  });

  it('the spin refuses to run on a table that fails its audit', () => {
    expect(SPIN).toContain(
      'a.weight_total IS DISTINCT FROM 100000 OR a.spec_rtp IS DISTINCT FROM 0.800000'
    );
  });

  it('version 1 as seeded sums to 100,000 and returns exactly 0.80 of a 100-diamond spin', () => {
    const block = wheel.sql.slice(
      wheel.sql.indexOf('INSERT INTO public.wheel_segments'),
      wheel.sql.indexOf('ON CONFLICT (version, ord) DO NOTHING')
    );
    const rows = [
      ...block.matchAll(
        /\(1,\s*(\d+),\s*'([^']+)',\s*'(nothing|chips|diamonds)',\s*([\d.]+),\s*(\d+)\)/g
      ),
    ];
    expect(rows.length).toBe(11);
    const rate = 100;
    const intakeChips = 100 / rate;
    let weight = 0;
    let ev = 0;
    let evChips = 0;
    let evDia = 0;
    for (const [, , , kind, amount, w] of rows) {
      const value =
        kind === 'chips' ? Number(amount) : kind === 'diamonds' ? Number(amount) / rate : 0;
      weight += Number(w);
      ev += value * Number(w);
      if (kind === 'chips') evChips += value * Number(w);
      if (kind === 'diamonds') evDia += value * Number(w);
    }
    expect(weight).toBe(100000);
    expect(ev / weight / intakeChips).toBeCloseTo(0.8, 9);
    expect(evChips / weight / intakeChips).toBeCloseTo(0.743, 9);
    expect(evDia / weight / intakeChips).toBeCloseTo(0.057, 9);
    // The migration asserts the same three shares before it commits.
    expect(wheel.sql).toContain(
      'a.chip_share <> 0.743000 OR a.diamond_share <> 0.057000 OR a.house_share <> 0.200000'
    );
  });
});

describe('a prize is drawable only when it can be paid now', () => {
  it('gates a chip tier on the exposure allowance AND the host bank', () => {
    expect(SPIN).toContain(
      'IF pool.chips_paid + seg.amount * v_mult > pool.chips_minted + v_mint_now + cfg.exposure_allowance_chips THEN'
    );
    expect(SPIN).toContain('IF v_bank + v_mint_now < seg.amount * v_mult THEN');
  });

  it('gates a diamond tier on the diamond float', () => {
    expect(SPIN).toContain('IF pool.diamond_float + v_dia_now < seg.amount * v_mult THEN');
  });

  it('draws only from the eligible tiers and reports the locked ones', () => {
    expect(SPIN).toContain(
      'WHERE g.version = cfg.segment_version AND g.ord = ANY (v_eligible) ORDER BY g.ord'
    );
    expect(SPIN).toMatch(/'locked', v_locked/);
  });

  it('re-checks the invariant after the pool moves and raises if the gate was bypassed', () => {
    expect(SPIN).toContain(
      'IF pool.chips_paid > pool.chips_minted + cfg.exposure_allowance_chips THEN'
    );
    expect(SPIN).toContain('the gate was bypassed');
    expect(wheel.sql).toMatch(
      /diamond_float\s+numeric\(16,4\) NOT NULL DEFAULT 0 CHECK \(diamond_float >= 0\)/
    );
  });
});

describe("every leg is the platform's own door", () => {
  it('the spin is paid through deduct_diamonds under a wheel reference', () => {
    expect(SPIN).toContain('v_deduct := public.deduct_diamonds(');
    expect(SPIN).toContain("'wheel_spin', 'wheel_spin',");
    expect(SPIN).toContain("'wheel:' || v_spin_id::text, 0);");
  });

  it('the host share is a declared, registered issuance', () => {
    expect(SPIN).toContain(
      "PERFORM public.fn_ca_declare_ledger('mint', 'issuance_reserve', NULL, NULL, 'wheel-mint:' || v_spin_id::text, NULL);"
    );
    expect(SPIN).toContain('the host bank moved but no mint leg was journaled');
  });

  it('a chip prize is one journal row, host bank to player, category wheel_prize', () => {
    expect(SPIN).toContain("PERFORM public.fn_ca_declare_ledger('wheel_prize',");
    expect(SPIN).toContain(
      "CASE WHEN v_kind = 'union' THEN 'union_bank' ELSE 'club_treasury' END,"
    );
    expect(SPIN).toContain(
      "CASE WHEN v_kind = 'union' THEN ARRAY['union_wallets'] ELSE ARRAY['clubs'] END"
    );
    expect(word.sql).toContain("'wheel_prize'::text");
    expect(word.sql).toMatch(/NOT VALID;/);
  });

  it('a diamond prize goes through add_diamonds_to_balance under a wheel reference', () => {
    expect(SPIN).toContain("public.add_diamonds_to_balance(v_user, v_prize_dia, 'wheel_prize',");
    expect(SPIN).toContain("'wheel:' || v_spin_id::text || ':prize'");
    expect(bridge.sql).toContain(
      "WHEN starts_with(p_reference_id, 'wheel:')            THEN 'wheel'"
    );
  });

  it('the autoskip is cleared after the prize leg so the next mint is journaled', () => {
    expect(SPIN).toContain("PERFORM set_config('app.ledger_autoskip_union_wallets', '', true);");
    expect(SPIN).toContain("PERFORM set_config('app.ledger_autoskip_clubs', '', true);");
  });

  it('the profile guard admits fn_wheel_spin by name, beside the daily bonus claim', () => {
    const g = body(guard.sql, 'fn_guard_profile_privileged_columns');
    expect(g).toContain("'function (public[.])?fn_wheel_spin[(]'");
    expect(g).toContain("'function (public[.])?fn_ca_daily_bonus_claim[(]'");
    expect(g).toContain("'function (public[.])?deduct_diamonds[(]'");
  });
});

describe('the wheel is fair by construction and closed to the browser', () => {
  it('commits to the server seed by hash and rolls HMAC(server, client:nonce) over 2^48', () => {
    const c = body(wheel.sql, 'fn_wheel_commit');
    expect(c).toContain("v_hash := encode(extensions.digest(v_seed, 'sha256'), 'hex');");
    expect(SPIN).toContain(
      "v_hmac := extensions.hmac(convert_to(v_client || ':' || v_nonce::text, 'UTF8'),"
    );
    expect(SPIN).toContain('c_two48 constant numeric := 281474976710656;');
    expect(SPIN).toContain('v_point := floor(v_roll * v_total / c_two48);');
  });

  it('a spent commit replays the first answer and moves nothing twice', () => {
    expect(SPIN).toContain(
      'SELECT * INTO prior FROM public.wheel_spins WHERE commit_id = p_commit_id;'
    );
    expect(SPIN).toContain(
      "RETURN public.fn_wheel_spin_result(prior) || jsonb_build_object('replayed', true);"
    );
  });

  it('refuses during the maintenance freeze and under the wheel kill switch, before any money moves', () => {
    const freeze = SPIN.indexOf('IF public.fn_platform_frozen() THEN');
    const kill = SPIN.indexOf("WHERE f.scope = 'wheel' AND f.cleared_at IS NULL");
    const money = SPIN.indexOf('v_deduct := public.deduct_diamonds(');
    expect(freeze).toBeGreaterThan(-1);
    expect(kill).toBeGreaterThan(-1);
    expect(freeze).toBeLessThan(money);
    expect(kill).toBeLessThan(money);
    expect(bridge.sql).toContain("'arena_withdrawals'::text, 'wheel'::text");
  });

  it('spins are append-only and the tables are closed to anon and authenticated', () => {
    expect(wheel.sql).toMatch(/BEFORE UPDATE OR DELETE ON public\.wheel_spins/);
    expect(wheel.sql).toMatch(
      /REVOKE ALL ON public\.wheel_segment_versions, public\.wheel_segments, public\.wheel_configs,\s+public\.wheel_config_history, public\.wheel_pools, public\.wheel_seed_commits, public\.wheel_spins\s+FROM PUBLIC, anon, authenticated;/
    );
    for (const t of ['wheel_configs', 'wheel_pools', 'wheel_seed_commits', 'wheel_spins']) {
      expect(wheel.sql).toContain(`ALTER TABLE public.${t} ENABLE ROW LEVEL SECURITY;`);
    }
  });

  it('the money movers are on the register', () => {
    expect(wheel.sql).toContain("('fn_wheel_spin', 'approved',");
    expect(wheel.sql).toContain("('fn_wheel_set_config', 'approved',");
    expect(wheel.sql).toContain("('fn_wheel_activate_segments', 'approved',");
  });
});
