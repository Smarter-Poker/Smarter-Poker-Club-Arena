/**
 * THE WHEEL NEVER PAYS MORE THAN IT TAKES IN (Dan, 2026-09-07, BINDING)
 *
 * Dan: "House edge on this should be 20% and never pay more out than we take
 * in." And the same day: "1 diamond = 1 cent, 1 chip = 1 dollar."
 *
 * The Diamond Wheel keeps both by ARITHMETIC, not by an odds table being
 * honest. AMENDED 2026-09-10 (migration 20260910192951_the_games_belong_to_the_host,
 * Dan: "all diamonds taken in get credited to the union owners wallet, or the
 * club owners wallet ... chip payouts are 100% connected and wired to the promo
 * wallet"). The law is unchanged; the money it is stated on moved:
 *
 *   - the prize table version that is active must return exactly 0.800000 of
 *     the spin and its weights must sum to 100,000, or it cannot be activated;
 *   - NOTHING IS MINTED any more. Every diamond taken in is credited to the
 *     host's OWNER, and every chip prize is paid out of the host's PROMO
 *     wallet, so the games add nothing to chip supply;
 *   - a chip prize is drawable only when chips_paid + prize <= the chips this
 *     wheel HAS TAKEN IN (this spin included) + the host's exposure allowance,
 *     AND the promo wallet holds it; a diamond prize only when the wheel's own
 *     diamond float covers it AND the owner holds it; a locked tier is left out
 *     of the draw and shown as locked;
 *   - after every spin the pool re-checks paid <= taken in + allowance and
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
/** The 2026-09-10 rewrite: the host is the house. */
const host = latest('the_games_belong_to_the_host');

/** The spin body as it stands after the fix-forward migrations. */
const SPIN = body(host.sql, 'fn_wheel_spin');

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
  it('gates a chip tier on what was taken in AND the promo wallet that pays it', () => {
    expect(SPIN).toContain(
      'IF pool.chips_paid + seg.amount * v_mult > v_intake_chips + cfg.exposure_allowance_chips THEN'
    );
    expect(SPIN).toContain('IF v_bank < seg.amount * v_mult THEN');
    // v_intake_chips IS what the wheel has taken in, this spin included.
    expect(SPIN).toContain(
      'v_intake_chips := round((pool.intake_diamonds + v_price)::numeric / v_rate, 2);'
    );
    expect(SPIN).toContain('v_bank := public.fn_diamond_game_promo_lock(v_host, v_kind);');
  });

  it('gates a diamond tier on the diamond float', () => {
    expect(SPIN).toContain('IF pool.diamond_float + v_dia_now < seg.amount * v_mult THEN');
    // AND the host's owner must hold it: the owner pays every diamond prize now.
    expect(SPIN).toContain('IF v_owner_dia + v_price < seg.amount * v_mult THEN');
  });

  it('draws only from the eligible tiers and reports the locked ones', () => {
    expect(SPIN).toContain(
      'WHERE g.version = cfg.segment_version AND g.ord = ANY (v_eligible) ORDER BY g.ord'
    );
    expect(SPIN).toMatch(/'locked', v_locked/);
  });

  it('re-checks the invariant after the pool moves and raises if the gate was bypassed', () => {
    expect(SPIN).toContain(
      'IF pool.chips_paid > round(pool.intake_diamonds::numeric / v_rate, 2) + cfg.exposure_allowance_chips THEN'
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

  it('NOTHING IS MINTED: the intake is the host owner\u2019s, as a transfer', () => {
    expect(SPIN).not.toContain('issuance_reserve');
    expect(SPIN).not.toContain('fn_diamond_game_mint_leg');
    expect(SPIN).toContain("public.add_diamonds_to_balance(v_owner, v_price, 'transfer',");
    expect(SPIN).toContain("'wheel:' || v_spin_id::text || ':intake'");
    expect(SPIN).toContain('the spin price could not be credited to the host owner');
    // And the mint helper the other two games used is gone from the platform.
    expect(host.sql).toContain(
      'DROP FUNCTION IF EXISTS public.fn_diamond_game_mint_leg(uuid, text, numeric, text);'
    );
  });

  it('a chip prize is one journal row, PROMO WALLET to player, category wheel_prize', () => {
    // The leg is declared from the PROMO side and the member side stands down,
    // so the row names the column the chips left (union_wallets.promo_wallet or
    // clubs.promo_balance) instead of naming the member wallet twice. The two
    // host shapes journal under different account names for the same promo
    // column, which is why the label, not the account, is what says promo.
    expect(SPIN).toContain("PERFORM public.fn_ca_declare_ledger('wheel_prize', 'player_wallet',");
    expect(SPIN).toContain("ARRAY['club_members']");
    // The wallet it actually spends, on both host shapes.
    expect(SPIN).toContain(
      'UPDATE public.union_wallets SET promo_wallet = promo_wallet - v_prize_chips'
    );
    expect(SPIN).toContain('UPDATE public.clubs SET promo_balance = promo_balance - v_prize_chips');
    expect(SPIN).not.toContain('chip_treasury = chip_treasury - v_prize_chips');
    expect(SPIN).not.toContain('chip_balance = chip_balance - v_prize_chips');
    // And it refuses to carry on if the wallet moved without a journal row.
    expect(SPIN).toContain(
      "IF NOT EXISTS (SELECT 1 FROM public.chip_ledger WHERE idempotency_key = 'wheel-prize:'"
    );
    expect(word.sql).toContain("'wheel_prize'::text");
    expect(word.sql).toMatch(/NOT VALID;/);
  });

  it('a diamond prize is paid BY THE OWNER, under a wheel reference', () => {
    expect(SPIN).toContain(
      'PERFORM public.fn_diamond_game_pay_diamonds(v_owner, v_user, v_prize_dia,'
    );
    expect(SPIN).toContain("'wheel:' || v_spin_id::text || ':prize'");
    const pay = body(host.sql, 'fn_diamond_game_pay_diamonds');
    expect(pay).toContain("public.add_diamonds_to_balance(p_owner, -p_amount, 'transfer'");
    expect(pay).toContain("public.add_diamonds_to_balance(p_user, p_amount, 'transfer'");
    expect(bridge.sql).toContain(
      "WHEN starts_with(p_reference_id, 'wheel:')            THEN 'wheel'"
    );
  });

  it('the autoskip is cleared after the prize leg so the next write is journaled', () => {
    expect(SPIN).toContain("PERFORM set_config('app.ledger_autoskip_union_wallets', '', true);");
    expect(SPIN).toContain("PERFORM set_config('app.ledger_autoskip_clubs', '', true);");
  });

  it('the profile guard admits fn_wheel_spin by name, beside the daily bonus claim', () => {
    const g = body(guard.sql, 'fn_guard_profile_privileged_columns');
    expect(g).toContain("'function (public[.])?fn_wheel_spin[(]'");
    expect(g).toContain("'function (public[.])?fn_ca_daily_bonus_claim[(]'");
    expect(g).toContain("'function (public[.])?deduct_diamonds[(]'");
  });

  it('and the two games that now pay an owner join it in the same migration', () => {
    expect(host.sql).toContain("OR v_stack ~ 'function (public[.])?fn_plinko_drop[(]'");
    expect(host.sql).toContain("OR v_stack ~ 'function (public[.])?fn_crash_start[(]'");
    expect(host.sql).toContain('the profile guard does not name every door');
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
