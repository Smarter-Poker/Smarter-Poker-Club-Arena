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
/**
 * AMENDED 2026-09-10, the same day. Dan: "the back up is the union or club main
 * bank, if the promo pool runs dry. wire that in." and "free spin should be once
 * for a new user 100 diamonds ... they simply receive no diamonds ... All paid
 * for by the promo wallet."
 *
 * The wheel is ONE body now with two doors: fn_wheel_spin passes false and
 * fn_wheel_free_spin passes true, so a welcome spin is provably the same wheel,
 * the same odds and the same gates as a paid one. The law is read off the core.
 */
const bank = latest('the_bank_backs_the_promo_wallet');
/** The same day again: each door asks who is calling before it delegates. */
const doors = latest('the_wheel_doors_ask_who_is_calling');

/** The spin body as it stands after the fix-forward migrations. */
const SPIN = body(bank.sql, 'fn_wheel_spin_core');

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
  it('gates a chip tier on what was taken in AND the cover that pays it', () => {
    expect(SPIN).toContain(
      'ELSIF pool.chips_paid + seg.amount * v_mult > v_intake_chips + cfg.exposure_allowance_chips THEN'
    );
    // v_bank is COVER: the promo wallet plus the host bank behind it.
    expect(SPIN).toContain('IF v_bank < seg.amount * v_mult THEN');
    // v_intake_chips IS what the wheel has taken in, this spin included, and a
    // welcome spin adds nothing to it.
    expect(SPIN).toContain(
      'v_intake_chips := round((pool.intake_diamonds + v_dia_now)::numeric / v_rate, 2);'
    );
    expect(SPIN).toContain(
      'SELECT c.o_promo, c.o_bank, c.o_cover INTO v_promo, v_bank_only, v_bank'
    );
    // A welcome spin is bounded by its own budget instead.
    expect(SPIN).toContain(
      'IF COALESCE(pool.welcome_chips_paid, 0) + seg.amount * v_mult > cfg.welcome_budget_chips THEN'
    );
  });

  it('gates a diamond tier on the diamond float', () => {
    expect(SPIN).toContain('IF pool.diamond_float + v_dia_now < seg.amount * v_mult THEN');
    // AND the host's owner must hold it: the owner pays every diamond prize now.
    expect(SPIN).toContain('IF v_owner_dia + v_dia_now < seg.amount * v_mult THEN');
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

  it('a chip prize leaves through the one payer: promo wallet first, bank behind', () => {
    // The wheel no longer moves a wallet itself. Every chip it pays goes through
    // fn_diamond_game_pay_chips, which draws the promo wallet down to nothing
    // and takes the remainder from the host's own bank, writing one journal row
    // per wallet it touched, from the paying side.
    expect(SPIN).toContain('SELECT * INTO v_pay FROM public.fn_diamond_game_pay_chips(');
    expect(SPIN).toContain("'wheel_prize', v_host, v_kind, p_club_id, v_user, v_prize_chips,");
    expect(SPIN).not.toContain('UPDATE public.union_wallets SET promo_wallet');
    expect(SPIN).not.toContain('UPDATE public.clubs SET promo_balance');
    expect(SPIN).not.toContain('chip_treasury = chip_treasury -');
    expect(SPIN).not.toContain('chip_balance = chip_balance -');
    expect(word.sql).toContain("'wheel_prize'::text");
    expect(word.sql).toMatch(/NOT VALID;/);
  });

  it('THE PAYER: the promo wallet is drained first and the bank covers the rest', () => {
    const PAY = body(bank.sql, 'fn_diamond_game_pay_chips');
    expect(PAY).toContain('from_promo := LEAST(p_amount, v_lock.o_promo);');
    expect(PAY).toContain('from_bank  := p_amount - from_promo;');
    // Never more than the host actually holds, and the gate is meant to have
    // caught it long before this raise.
    expect(PAY).toContain('IF from_bank > v_lock.o_bank THEN');
    expect(PAY).toContain('after the gate passed');
    // One key per wallet, so a split reads as two rows that add to the prize.
    expect(PAY).toContain(
      "PERFORM public.fn_ca_declare_ledger(p_category, 'player_wallet', p_user, NULL, p_key, ARRAY['club_members']);"
    );
    expect(PAY).toContain("p_key || ':bank'");
    // Both halves refuse to carry on if the wallet moved unjournaled.
    expect(PAY).toContain('the promo wallet moved but no leg was journaled');
    expect(PAY).toContain('the host bank moved but no leg was journaled');
    // And the autoskip is cleared, or the next write in the transaction is silent.
    expect(PAY).toContain("PERFORM set_config('app.ledger_autoskip_club_members', '', true);");
  });

  it('COVER is promo plus bank, and every gate is measured against it', () => {
    const COVER = body(bank.sql, 'fn_diamond_game_cover');
    expect(COVER).toContain('public.fn_diamond_game_promo(p_host, p_kind)');
    expect(COVER).toContain('public.fn_diamond_game_bank(p_host, p_kind)');
    // A wallet that has gone negative covers nothing rather than eating the
    // other wallet's headroom.
    const LOCK = body(bank.sql, 'fn_diamond_game_cover_lock');
    expect(LOCK).toContain('o_promo := GREATEST(COALESCE(o_promo, 0), 0);');
    expect(LOCK).toContain('o_bank  := GREATEST(COALESCE(o_bank, 0), 0);');
    expect(LOCK).toContain('FOR UPDATE');
  });

  it('THE WELCOME SPIN is the same wheel, takes nothing in, and is bounded by its own budget', () => {
    // Once, ever: the unique index is the promise, not a check that can race.
    expect(bank.sql).toContain(
      'CREATE UNIQUE INDEX IF NOT EXISTS wheel_spins_one_welcome_per_member'
    );
    expect(bank.sql).toContain('ON public.wheel_spins (host_id, user_id) WHERE is_welcome;');
    // The owner simply receives no diamonds: nothing moves on a welcome spin.
    expect(SPIN).toContain('v_dia_now      := CASE WHEN p_welcome THEN 0 ELSE v_price END;');
    expect(SPIN).toContain('IF NOT p_welcome THEN');
    // Its payout never enters the paid game's books, and never exceeds the
    // budget the host declared for it.
    expect(SPIN).toContain(
      'chips_paid = chips_paid + CASE WHEN p_welcome THEN 0 ELSE v_prize_chips END,'
    );
    expect(SPIN).toContain(
      'welcome_chips_paid = welcome_chips_paid + CASE WHEN p_welcome THEN v_value_chips ELSE 0 END,'
    );
    expect(SPIN).toContain('IF pool.welcome_chips_paid > cfg.welcome_budget_chips THEN');
    expect(SPIN).toContain('the gate was bypassed');
    // A host that has not funded one does not offer one.
    expect(SPIN).toContain('The Welcome Spin Is Not Funded Here Yet');
    expect(SPIN).toContain('You Have Already Taken Your Welcome Spin Here');
    expect(SPIN).toContain('The Host Does Not Take Its Own Welcome Spin');
  });

  it('the browser cannot ask for a free spin: only the two doors set the flag', () => {
    // The doors were rewritten the same day so each ASKS who is calling before
    // it delegates (20260910235243): "the thing I call asks" is not the same
    // promise as "I ask", and check-definer-authorization reads the door.
    expect(doors.sql).toContain(
      'RETURN public.fn_wheel_spin_core(p_club_id, p_commit_id, p_client_seed, false);'
    );
    expect(doors.sql).toContain(
      'RETURN public.fn_wheel_spin_core(p_club_id, p_commit_id, p_client_seed, true);'
    );
    expect(body(doors.sql, 'fn_wheel_spin')).toContain('IF auth.uid() IS NULL THEN');
    expect(body(doors.sql, 'fn_wheel_free_spin')).toContain('IF auth.uid() IS NULL THEN');
    expect(doors.sql).toContain('a wheel door still does not ask who is calling');
    expect(bank.sql).toContain(
      'REVOKE ALL ON FUNCTION public.fn_wheel_spin_core(uuid, uuid, text, boolean) FROM PUBLIC, anon, authenticated;'
    );
    expect(bank.sql).not.toMatch(
      /GRANT EXECUTE ON FUNCTION public\.fn_wheel_spin_core\([^)]*\) TO authenticated/
    );
    // And the migration refuses to commit if that ever stops being true.
    expect(bank.sql).toContain(
      "IF has_function_privilege('authenticated', 'public.fn_wheel_spin_core(uuid, uuid, text, boolean)', 'EXECUTE') THEN"
    );
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
    // It moved with the payment: the payer clears all three now, because it is
    // the only thing that moves a wallet.
    const PAY = body(bank.sql, 'fn_diamond_game_pay_chips');
    expect(PAY).toContain("PERFORM set_config('app.ledger_autoskip_union_wallets', '', true);");
    expect(PAY).toContain("PERFORM set_config('app.ledger_autoskip_clubs', '', true);");
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

  it('and the core joins it, because a SQL wrapper does not appear in the stack the guard reads', () => {
    expect(bank.sql).toContain("OR v_stack ~ 'function (public[.])?fn_wheel_spin_core[(]'");
    expect(bank.sql).toContain(
      'the profile guard does not name fn_wheel_spin_core, so a diamond prize will be refused'
    );
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

/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  WHEEL v4 (owner ruling 2026-09-21, R2 / R12 / R13 / R15)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Dan moved the mix to a bonus game 50% of the time, an instant chip win 30%
 * and a throwable / time bank / rabbit hunt 20%, and when told that mix could
 * not hold 80% at the old prize values he chose "Hold 80% payback": the item
 * prizes drop from half an entry to a quarter and the chip ladder is re-solved.
 * At the same time no prize may follow itself, a VIP never wins an item, and
 * "Diamonds" becomes a three-card game paying half, double or triple the risk.
 *
 * The law is UNCHANGED: 80 percent out, 20 percent house, never more than was
 * taken in. The numbers it is stated on moved, so the proofs move with them,
 * and they are done here in exact integers, never in floating point:
 *
 *   - the published table is twelve weights out of 100,000 and is worth exactly
 *     0.8 of the entry, standard AND VIP, so swapping three item cards for
 *     three chip cards changes nobody's money;
 *   - no prize may repeat, and the mix still cannot drift, because the
 *     follow-up matrix is SYMMETRIC with rows summing to the base weights: its
 *     columns therefore sum to them too, which is the stationarity that keeps
 *     every spin's unconditional law equal to the published one;
 *   - no conditional expectation, after any prize, ever reaches the entry;
 *   - a three-times card is covered before the seed is read and stays reserved
 *     against both the owner's custody and the wheel's float until it is picked,
 *     so a prize that pays three entries can never be drawn unbacked.
 */
const v4 = latest('diamond_wheel_v4_draws_a_different_prize');

type V4Row = {
  ord: number;
  label: string;
  kind: string;
  game: string | null;
  multiplier: string;
  sixths: string;
  vipLabel: string;
  vipKind: string;
  vipMultiplier: string;
  vipSixths: string;
  weight: number;
};

/** Read the installed model straight out of the migration: no retyped numbers. */
function v4Model(): V4Row[] {
  const rows = [
    ...v4.sql.matchAll(
      /^ \((\d+),'([^']*)','([^']*)',(NULL|'[a-z]+'),([\d.]+),([\d.]+),'([^']*)','([^']*)',([\d.]+),([\d.]+),(\d+)\),?$/gm
    ),
  ].map((m) => ({
    ord: Number(m[1]),
    label: m[2],
    kind: m[3],
    game: m[4] === 'NULL' ? null : m[4].slice(1, -1),
    multiplier: m[5],
    sixths: m[6],
    vipLabel: m[7],
    vipKind: m[8],
    vipMultiplier: m[9],
    vipSixths: m[10],
    weight: Number(m[11]),
  }));
  expect(rows).toHaveLength(12);
  return rows;
}

/** And the installed follow-up matrix, as twelve rows of twelve. */
function v4Follow(): number[][] {
  const rows = [...v4.sql.matchAll(/^ \((\d+),((?:\d+,){11}\d+)\),?$/gm)].map((m) => ({
    prev: Number(m[1]),
    weights: m[2].split(',').map(Number),
  }));
  expect(rows).toHaveLength(12);
  rows.forEach((r, i) => expect(r.prev).toBe(i + 1));
  return rows.map((r) => r.weights);
}

/** A value in sixths of one entry, as an exact integer of tenths of a sixth. */
const tenths = (sixths: string) => BigInt(Math.round(Number(sixths) * 10));

describe('wheel v4 is still exactly 80 percent, and no prize may repeat', () => {
  it('the published table is twelve weights out of 100,000, standard and VIP', () => {
    const model = v4Model();
    expect(model.map((r) => r.ord)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
    expect(model.reduce((sum, r) => sum + r.weight, 0)).toBe(100000);
    expect(model.map((r) => r.label)).toEqual([
      'Diamond Plinko',
      '1x Chips',
      'Throwables',
      'Diamond Crash',
      'Diamonds',
      'Time Bank',
      'Donkey Cross',
      '2x Chips',
      'Rabbit Hunt',
      'Diamond Mines',
      '3x Chips',
      'Upgrade',
    ]);
    // R13: a game half the time, instant chips three tenths, an item a fifth.
    const bucket = (kinds: string[]) =>
      model.filter((r) => kinds.includes(r.kind)).reduce((sum, r) => sum + r.weight, 0);
    expect(bucket(['bonus', 'upgrade', 'diamonds'])).toBe(50000);
    expect(bucket(['chips'])).toBe(30000);
    expect(bucket(['throwables', 'time_bank', 'rabbit_hunt'])).toBe(20000);
  });

  it('EXACTLY 0.8 of the entry, in integers, on both tables and at every stake', () => {
    const model = v4Model();
    // sum(weight * value) where value is carried in tenths of a sixth: the
    // payback is 0.8 when that sum is 100000 * 6 * 0.8 * 10 = 4,800,000.
    const standard = model.reduce((sum, r) => sum + BigInt(r.weight) * tenths(r.sixths), 0n);
    const vip = model.reduce((sum, r) => sum + BigInt(r.weight) * tenths(r.vipSixths), 0n);
    expect(standard).toBe(4800000n);
    expect(vip).toBe(4800000n);
    // And therefore exactly four fifths of every permitted entry, with no
    // remainder at all: in tenths of a diamond the payback is 8 x the stake.
    for (const stake of [25, 26, 27, 99, 100, 333, 2499, 2500]) {
      expect((standard * BigInt(stake) * 10n) % 6000000n).toBe(0n);
      expect((standard * BigInt(stake) * 10n) / 6000000n).toBe(8n * BigInt(stake));
      expect((vip * BigInt(stake) * 10n) / 6000000n).toBe(8n * BigInt(stake));
    }
  });

  it('R2: a VIP table has no items, and the swap is worth the same 5000', () => {
    const model = v4Model();
    expect(
      model.filter((r) => ['throwables', 'time_bank', 'rabbit_hunt'].includes(r.kind))
    ).toHaveLength(3);
    expect(
      model.filter((r) => ['throwables', 'time_bank', 'rabbit_hunt'].includes(r.vipKind))
    ).toHaveLength(0);
    expect(model.filter((r) => r.vipKind === 'chips')).toHaveLength(6);
    const swapped = model.filter((r) => [3, 6, 9].includes(r.ord));
    expect(swapped.map((r) => r.vipLabel)).toEqual(['0.2x Chips', '0.25x Chips', '0.3x Chips']);
    // 0.2*6667 + 0.25*6666 + 0.3*6667 = 5000, and the items it replaces are
    // 0.25 * (6667 + 6666 + 6667) = 5000 as well. Integers, in hundredths.
    const hundredths = (m: string) => BigInt(Math.round(Number(m) * 100));
    expect(swapped.reduce((s, r) => s + BigInt(r.weight) * hundredths(r.vipMultiplier), 0n)).toBe(
      500000n
    );
    expect(swapped.reduce((s, r) => s + BigInt(r.weight) * hundredths(r.multiplier), 0n)).toBe(
      500000n
    );
    // R13: an item is a quarter of the entry now, where v3 paid half.
    expect(swapped.every((r) => r.multiplier === '0.25')).toBe(true);
    expect(v4.sql).toContain("v_price*.25/100,cm.server_seed,'wheel-v4-item:'");
  });

  it('R12: the follow-up matrix is symmetric, hollow, and preserves the law', () => {
    const W = v4Model().map((r) => r.weight);
    const F = v4Follow();
    for (let i = 0; i < 12; i += 1) {
      expect(F[i][i]).toBe(0);
      expect(F[i].reduce((sum, w) => sum + w, 0)).toBe(W[i]);
      for (let j = 0; j < 12; j += 1) {
        expect(F[i][j]).toBe(F[j][i]);
        if (i !== j) expect(F[i][j]).toBeGreaterThan(0);
      }
    }
    // STATIONARITY. Symmetry plus row sums gives column sums, and a column sum
    // of W[j] is exactly sum_i P(i) P(j | i) = W[j] / 100000: the unconditional
    // law of EVERY spin is the published one, so the mix cannot drift and the
    // payback stays 0.8 even though nothing may repeat.
    for (let j = 0; j < 12; j += 1) {
      expect(F.reduce((sum, row) => sum + row[j], 0)).toBe(W[j]);
    }
  });

  it('R12: no conditional expectation, after any prize, ever reaches the entry', () => {
    const model = v4Model();
    const F = v4Follow();
    for (const table of ['sixths', 'vipSixths'] as const) {
      for (let i = 0; i < 12; i += 1) {
        const value = F[i].reduce((sum, w, j) => sum + BigInt(w) * tenths(model[j][table]), 0n);
        // value / (W[i] * 60) is the expectation in entries. It must stay below
        // one, which is the whole point: a no-repeat rule must not become a
        // free spin after an expensive one.
        expect(value).toBeLessThan(BigInt(model[i].weight) * 60n);
      }
    }
  });

  it('R12: the cross-tier rule moves weight only between equally valued games', () => {
    const model = v4Model();
    const F = v4Follow();
    const gameOrds = model.filter((r) => r.kind === 'bonus').map((r) => r.ord);
    expect(gameOrds).toEqual([1, 4, 7, 10]);
    // Every ordinary game is worth the same, so re-sharing 108 among three of
    // them cannot move the payback; the migration does exactly that and nothing else.
    expect(new Set(gameOrds.map((ord) => model[ord - 1].sixths)).size).toBe(1);
    expect(gameOrds.every((ord) => F[11][ord - 1] === 108)).toBe(true);
    expect(108 % 3).toBe(0);
    // And two Upgrades in a row are impossible, so an Upgrade needs no exclusion
    // of its own on the main wheel.
    expect(F[11][11]).toBe(0);
    // The Upgrade wheel: 20000 shared by the other three Super games, all worth
    // 1.6 entries each, so it is still worth four entries.
    expect(v4.sql).toContain('fn_wheel_v4_upgrade_weights');
    expect(20000 % 3).toBe(2);
  });

  it('R15: the three-card game is eleven sixths, and it is covered before the seed', () => {
    const model = v4Model();
    const cards = model[4];
    expect(cards.label).toBe('Diamonds');
    expect(cards.kind).toBe('diamonds');
    // half + double + triple = 0.5 + 2 + 3 = 5.5 entries over three cards.
    expect(tenths(cards.sixths)).toBe(110n);
    expect(110n * 3n).toBe(BigInt(Math.round((0.5 + 2 + 3) * 60)));
    // THE COVER. The old gate asked for half an entry; a card can pay three, so
    // the gate asks for three, and every unpicked card keeps its triple reserved
    // against the owner's custody AND the wheel's float until it is picked.
    // That reservation is why wheel_pools.diamond_float >= 0 still holds.
    expect(v4.sql).toContain('v_owner_dia+v_dia_now-v_card_hold<3*v_price');
    expect(v4.sql).toContain('pool.diamond_float+v_dia_now-v_card_hold_float<3*v_price');
    expect(v4.sql).toContain('COALESCE(sum(3*c.risk_diamonds),0)');
    expect(v4.sql).not.toContain('ceil(v_price*.5)');
    // Nothing is paid at the spin, and the values never leave the row early.
    expect(v4.sql).toContain(
      "'cards',jsonb_build_object('award_id',v_card.id,'risk_diamonds',v_price,'status','pending')"
    );
    expect(v4.sql).toContain("'wheel-cards:'||a.id");
  });

  it('the new draw domains make no old vector reusable, and the release says 4', () => {
    for (const domain of [
      "'wheel-v4:'",
      "'wheel-v4-upgrade:'",
      "'wheel-v4-cards:'",
      "'wheel-v4-cards-half:'",
      "'wheel-v4-rounding:'",
      "'wheel-v4-item:'",
    ]) {
      expect(v4.sql).toContain(domain);
    }
    expect(v4.sql).toContain('UPDATE public.diamond_wheel_release SET contract_version=4');
    // v3 stays installed, because every stored v3 receipt must still verify.
    expect(v4.sql).toContain('fn_wheel_v3_upgrade_model()');
    expect(v4.sql).not.toContain('DROP FUNCTION public.fn_wheel_v3_model');
  });

  it('the browser mirror carries the same law as the migration', async () => {
    const mirror = await import('../src/utils/wheelV4Model');
    expect(mirror.WHEEL_V4_WEIGHTS).toEqual(v4Model().map((r) => r.weight));
    expect(mirror.WHEEL_V4_FOLLOW.map((row) => [...row])).toEqual(v4Follow());
    expect(mirror.WHEEL_V4_TOTAL).toBe(100000);
  });
});
