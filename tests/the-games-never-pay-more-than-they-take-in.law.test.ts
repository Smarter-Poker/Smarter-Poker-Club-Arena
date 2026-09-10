/**
 * THE GAMES NEVER PAY MORE THAN THEY TAKE IN (Dan, 2026-09-08, BINDING)
 *
 * Dan: "Two alternates to the Diamond To Chip spinning wheel. A Plinko
 * version, 50x can be higher on this, but crash out pays nothing, and you
 * still need to maintain the 20% edge. And a Crash / Aviator-style: the
 * multiplier climbs until it crashes; cash out first. 50x can be higher, crash
 * out pays nothing, and you still need to maintain the 20% edge."
 *
 * Diamond Plinko and Diamond Crash
 * (supabase/migrations/20260908010241_plinko_and_crash_the_two_alternates_to_the_wheel.sql)
 * keep the edge and the never-pay-more promise by ARITHMETIC, the wheel's way:
 *
 *   - a bet is a whole number of chips; 0.80 of it is MINTED to the host
 *     through the declared issuance door (mint / issuance_reserve, registered
 *     by the chip_ledger issuance trigger), and the rest is retired diamonds:
 *     the house;
 *   - before a round the pool computes the largest multiplier it can promise
 *     on that bet: cap_fraction of its headroom (minted + this mint +
 *     allowance - paid - reserved), never above the ceiling, never above what
 *     the host bank holds beyond open reservations; the round is played
 *     against min(table, cap), and the cap is shown before the bet;
 *   - a plinko table is activated only when it returns exactly 0.800000 on the
 *     binomial weights C(16,k)/65536, and every launch table does;
 *   - the crash point is floor(80 * 2^48 / (r + 1)) cents floored at 1.00, so
 *     P(X >= x) = 0.8 / x for every target: cashing out ANYWHERE returns 80
 *     percent; an open round reserves bet x cap until it settles, and the
 *     server clock decides it, never the browser;
 *   - after every money move the pool re-checks
 *     paid + reserved <= minted + allowance and raises if the cap was bypassed;
 *   - the rate is the row (fn_ca_bridge_rate), horses are not filtered
 *     anywhere, and no repair job exists: time settling a decided round is
 *     the live path finishing its own work (CLAUDE.md 10.12).
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
  // A door whose signature changed is dropped and re-created, so it may be a
  // plain CREATE rather than CREATE OR REPLACE. Both are the same statement to
  // this law; read whichever one the migration used.
  const open = Math.max(
    sql.lastIndexOf(`CREATE OR REPLACE FUNCTION public.${fn}(`),
    sql.lastIndexOf(`CREATE FUNCTION public.${fn}(`)
  );
  expect(open, `${fn} has moved or gone`).toBeGreaterThan(-1);
  const start = sql.indexOf('$function$', open);
  const end = sql.indexOf('$function$', start + 10);
  expect(end).toBeGreaterThan(start);
  return sql.slice(start, end);
}

const games = latest('plinko_and_crash_the_two_alternates_to_the_wheel');
const words = latest('the_ledger_learns_plinko_and_crash_prizes');
const opens = latest('the_wheel_opens_with_a_seeded_diamond_float');
/**
 * AMENDED 2026-09-10. Dan: "make sure that the chip payouts are 100% connected
 * and wired to the promo wallet and all diamonds taken in get credited to the
 * union owners wallet, or the club owners wallet." The law is unchanged - these
 * games still never pay out more than they take in - but the money it is stated
 * on moved: nothing is minted, the intake is the host owner's, and every payout
 * comes out of the host's promo wallet. Every body below is read from that
 * migration, which is the one that is live.
 */
const host = latest('the_games_belong_to_the_host');

const CAP = body(host.sql, 'fn_diamond_game_cap_cents');
const ADMIT = body(host.sql, 'fn_diamond_game_admit');
const DROP = body(host.sql, 'fn_plinko_drop');
const START = body(host.sql, 'fn_crash_start');
const DECIDE = body(host.sql, 'fn_crash_decide');
const TAKE = body(host.sql, 'fn_diamond_game_take_bet');
const PRIZE = body(host.sql, 'fn_diamond_game_prize_leg');
const AUDIT = body(games.sql, 'fn_plinko_table_audit');

const C16 = [
  1, 16, 120, 560, 1820, 4368, 8008, 11440, 12870, 11440, 8008, 4368, 1820, 560, 120, 16, 1,
];

describe('the house share is arithmetic, not an odds table being honest', () => {
  it('a bet is whole chips at the bridge rate', () => {
    expect(ADMIT).toContain('o_rate := public.fn_ca_bridge_rate();');
    expect(ADMIT).toContain('p_bet % o_rate <> 0');
    expect(ADMIT).toContain('o_bet_chips := round(p_bet::numeric / o_rate, 2);');
    expect(ADMIT).not.toMatch(/o_rate\s*:=\s*\d/);
  });

  it('NOTHING IS MINTED, and the helper that minted is dropped', () => {
    expect(host.sql).toContain(
      'DROP FUNCTION IF EXISTS public.fn_diamond_game_mint_leg(uuid, text, numeric, text);'
    );
    for (const b of [DROP, START, ADMIT, CAP, PRIZE, TAKE]) {
      expect(b).not.toContain('issuance_reserve');
      expect(b).not.toContain('fn_diamond_game_mint_leg');
    }
    expect(host.sql).toContain('the host is the house: a game still mints');
  });

  it('the bet is paid through deduct_diamonds AND credited to the host owner', () => {
    expect(TAKE).toContain(
      "v_deduct := public.deduct_diamonds(p_user, p_bet, p_description, p_type, 'diamond_game',"
    );
    expect(TAKE).toContain(
      "v_credit := public.add_diamonds_to_balance(p_owner, p_bet, 'transfer', p_owner_note, p_reference || ':intake');"
    );
    expect(TAKE).toContain('the bet could not be credited to the host owner');
    // The owner is the union's owner for a union host, the club's for a club.
    const owner = body(host.sql, 'fn_diamond_game_owner');
    expect(owner).toContain('SELECT u.owner_id FROM public.unions u WHERE u.id = p_host');
    expect(owner).toContain('SELECT c.owner_id FROM public.clubs c WHERE c.id = p_host');
    expect(ADMIT).toContain('o_owner := public.fn_diamond_game_owner(o_host, o_kind);');
    expect(DROP).toContain("'plinko:' || v_id::text");
    expect(DROP).toContain("'plinko_drop'");
    expect(START).toContain("'crash:' || v_id::text");
    expect(START).toContain("'crash_bet'");
  });

  it('the bank a payout comes out of IS the promo wallet, on both host shapes', () => {
    expect(ADMIT).toContain('o_bank := public.fn_diamond_game_promo_lock(o_host, o_kind);');
    const lock = body(host.sql, 'fn_diamond_game_promo_lock');
    expect(lock).toContain(
      'SELECT COALESCE(w.promo_wallet, 0) INTO v_promo FROM public.union_wallets w'
    );
    expect(lock).toContain('SELECT COALESCE(c.promo_balance, 0) INTO v_promo FROM public.clubs c');
    expect(lock).toContain('FOR UPDATE');
  });
});

describe('the cap: a round is promised only what the pool can pay now', () => {
  it('is cap_fraction of the headroom, never above the ceiling, never above the bank', () => {
    // The headroom is what the game HAS TAKEN IN, this bet included.
    expect(CAP).toContain(
      'v_intake numeric := COALESCE(p_pool.intake_diamonds, 0) / public.fn_ca_bridge_rate() + p_bet_chips;'
    );
    expect(CAP).toContain('v_headroom  := v_intake + p_cfg.exposure_allowance_chips');
    expect(CAP).toContain('- COALESCE(p_pool.chips_paid, 0) - COALESCE(p_pool.reserved_chips, 0);');
    expect(CAP).toContain(
      'v_bank_room := COALESCE(p_bank, 0) - COALESCE(p_pool.reserved_chips, 0);'
    );
    expect(CAP).toContain('floor(p_cfg.cap_fraction * v_headroom / p_bet_chips * 100)');
    expect(CAP).toContain('floor(v_bank_room / p_bet_chips * 100)');
    expect(games.sql).toMatch(
      /cap_fraction\s+numeric\(4,3\) NOT NULL DEFAULT 0\.950 CHECK \(cap_fraction > 0 AND cap_fraction < 1\)/
    );
  });

  it('plinko plays min(table, cap) and refuses a bet the cap cannot lift above 1.01x', () => {
    expect(DROP).toContain('v_mult := LEAST(v_table_mult, v_cap);');
    expect(DROP).toContain('IF v_cap < 101 THEN');
    expect(DROP).toContain('v_payout := round(adm.o_bet_chips * v_mult / 100, 2);');
  });

  it('crash reserves bet x cap while the round is open and pays never more than that', () => {
    expect(START).toContain('v_reserve := round(adm.o_bet_chips * v_cap / 100, 2);');
    expect(START).toContain('reserved_chips = reserved_chips + v_reserve,');
    expect(DECIDE).toContain('IF v_payout > r.reserved_chips THEN');
    expect(DECIDE).toContain('reserved_chips = reserved_chips - r.reserved_chips,');
    expect(games.sql).toMatch(
      /reserved_chips\s+numeric\(16,2\) NOT NULL DEFAULT 0 CHECK \(reserved_chips >= 0\)/
    );
  });

  it('re-checks the invariant after every move and raises if the cap was bypassed', () => {
    expect(DROP).toContain(
      'IF pool.chips_paid + pool.reserved_chips > v_intake_chips + (adm.o_cfg).exposure_allowance_chips THEN'
    );
    expect(START).toContain(
      'IF pool.chips_paid + pool.reserved_chips > v_intake_chips + (adm.o_cfg).exposure_allowance_chips THEN'
    );
    expect(DECIDE).toContain(
      'IF pool.chips_paid + pool.reserved_chips > v_intake_chips + cfg.exposure_allowance_chips + 0.000001 THEN'
    );
    // And v_intake_chips is read off the pool, never off a mint that no longer happens.
    for (const b of [DROP, START, DECIDE]) {
      expect(b).toMatch(/v_intake_chips := round\(pool\.intake_diamonds::numeric \/ /);
    }
    for (const b of [DROP, START, DECIDE]) expect(b).toContain('the cap was bypassed');
  });
});

describe('plinko returns exactly 80 percent or the table cannot be activated', () => {
  it('the audit derives the return from the binomial weights of a 16-row board', () => {
    expect(AUDIT).toContain(
      'ARRAY[1,16,120,560,1820,4368,8008,11440,12870,11440,8008,4368,1820,560,120,16,1]'
    );
    expect(AUDIT).toContain('spec_rtp := round(v_ev / (65536 * 100), 6);');
    const act = body(games.sql, 'fn_plinko_activate_table');
    expect(act).toContain('IF a.spec_rtp <> 0.800000 THEN');
    const cfg = body(games.sql, 'fn_diamond_game_set_config');
    expect(cfg).toContain('WHERE t.activated_at IS NOT NULL AND a.spec_rtp = 0.800000');
  });

  it('every launch table sums to exactly 5,242,880 cents-weight (0.80 of 65,536 chips) with a dead centre', () => {
    const block = games.sql.slice(
      games.sql.indexOf('INSERT INTO public.plinko_tables'),
      games.sql.indexOf('ON CONFLICT (version) DO NOTHING')
    );
    const rows = [...block.matchAll(/\((\d+), '([^']+)',\s*ARRAY\[([\d,]+)\], (\d+),/g)];
    expect(rows.length).toBe(3);
    for (const [, , name, list, max] of rows) {
      const m = list.split(',').map(Number);
      expect(m.length, name).toBe(17);
      expect(m[8], `${name} centre`).toBe(0);
      let total = 0;
      for (let k = 0; k < 17; k++) {
        total += C16[k] * m[k];
        expect(m[k], `${name} symmetric`).toBe(m[16 - k]);
      }
      expect(total, name).toBe(Math.round(0.8 * 65536 * 100));
      expect(Math.max(...m)).toBe(Number(max));
    }
    // Moonshot: 1000x at the edge, the table Dan asked for when he said "50x can be higher".
    expect(block).toContain("(3, 'Moonshot', ARRAY[100000,");
  });

  it('the ball follows sixteen bits of the HMAC and the slot is the number of rights', () => {
    expect(DROP).toContain('FOR i IN 0..15 LOOP');
    expect(DROP).toContain('IF get_bit(v_hmac, i) = 1 THEN');
    expect(DROP).toContain('v_slot := v_slot + 1;');
    expect(DROP).toContain('v_table_mult := t.multipliers_cents[v_slot + 1];');
  });
});

describe('crash returns exactly 80 percent at every cash-out target', () => {
  it('the crash point is floor(80 * 2^48 / (r + 1)) cents, floored at 1.00', () => {
    const p = body(games.sql, 'fn_crash_point_cents');
    expect(p).toContain(
      'GREATEST(100::bigint, floor(22517998136852480::numeric / (p_roll + 1))::bigint)'
    );
    expect(22517998136852480n).toBe(80n * 2n ** 48n);
    // The migration asserts the pinned vector before it commits.
    expect(games.sql).toContain(
      "IF v_x <> 201 THEN RAISE EXCEPTION 'POST-APPLY: crash point for the pinned roll is %, expected 201', v_x; END IF;"
    );
  });

  it('the server clock decides a round; the browser only asks', () => {
    expect(DECIDE).toContain(
      'v_elapsed_ms := floor(extract(epoch FROM (clock_timestamp() - r.started_at)) * 1000)::bigint;'
    );
    expect(DECIDE).toContain(
      'v_now_cents := public.fn_crash_multiplier_cents(r.growth_k, v_elapsed_ms, r.cap_cents);'
    );
    // an auto target below the crash point is honoured the moment the curve passes it
    expect(DECIDE).toContain(
      'IF r.auto_cashout_cents IS NOT NULL AND r.auto_cashout_cents < r.crash_cents AND v_now_cents >= r.auto_cashout_cents THEN'
    );
    // reaching the cap before the crash point cashes at the cap
    expect(DECIDE).toContain(
      'ELSIF r.crash_cents >= r.cap_cents AND v_now_cents >= r.cap_cents THEN'
    );
    // reaching the crash point pays nothing
    expect(DECIDE).toContain('ELSIF v_now_cents >= r.crash_cents THEN');
    expect(DECIDE).toContain("v_result := 'crashed'; v_at_cents := NULL;");
    // a manual cash-out is the server's reading, never a number the client sent
    const settle = body(games.sql, 'fn_crash_settle');
    expect(settle).not.toMatch(/p_cents|p_multiplier/);
    expect(games.sql).toContain(
      'CREATE OR REPLACE FUNCTION public.fn_crash_settle(p_round_id uuid, p_cashout boolean)'
    );
  });

  it('an open round reveals nothing that gives the crash point away', () => {
    const r = body(games.sql, 'fn_crash_round_result');
    expect(r).toContain("|| CASE WHEN r.status = 'open' THEN '{}'::jsonb");
    expect(r).toContain(
      "ELSE jsonb_build_object('server_seed', r.server_seed, 'roll', r.roll, 'crash_cents', r.crash_cents) END"
    );
    expect(r).toContain(
      "'outcome', CASE WHEN r.status = 'open' THEN NULL ELSE jsonb_build_object("
    );
  });

  it('time settles a decided round on the live path, not by a cron', () => {
    const decided = body(games.sql, 'fn_crash_settle_decided');
    expect(decided).toContain("WHERE c.host_id = p_host AND c.status = 'open'");
    expect(decided).toContain('ln(c.cap_cents::numeric / 100) / c.growth_k');
    expect(ADMIT).toContain('PERFORM public.fn_crash_settle_decided(o_host);');
    expect(games.sql).not.toMatch(/cron\.schedule/);
    expect(games.sql).not.toMatch(/fn_\w*(repair|backpay|redrive|sweep|catchup|heal)\w*/);
  });
});

describe("every payout is the platform's own door, and nobody is filtered", () => {
  it('a payout is one journal row, PROMO WALLET to player, under its own category', () => {
    expect(PRIZE).toContain("DECLARE v_category text := p_game || '_prize';");
    // The PROMO side writes the leg, so the counterparty it declares is the
    // player it is paying, and the member side is the one told to stand down.
    expect(PRIZE).toContain(
      "PERFORM public.fn_ca_declare_ledger(v_category, 'player_wallet', p_user, NULL, p_key, ARRAY['club_members']);"
    );
    // The wallet it actually spends, on both host shapes, and never the bank.
    expect(PRIZE).toContain(
      'UPDATE public.union_wallets SET promo_wallet = COALESCE(promo_wallet, 0) - p_amount'
    );
    expect(PRIZE).toContain(
      'UPDATE public.clubs SET promo_balance = COALESCE(promo_balance, 0) - p_amount'
    );
    expect(PRIZE).not.toContain('chip_treasury');
    expect(PRIZE).not.toContain('chip_balance = chip_balance -');
    expect(PRIZE).toContain('the host promo wallet refused');
    // The movement is journaled exactly once: the promo side writes the leg and
    // the member side stands down, so there is no anonymous twin.
    expect(PRIZE).toContain('the promo wallet moved but no prize leg was journaled');
    expect(PRIZE).toContain("PERFORM set_config('app.ledger_autoskip_club_members', '', true);");
    expect(words.sql).toContain("'plinko_prize'::text, 'crash_prize'::text");
    expect(words.sql).toMatch(/NOT VALID;/);
  });

  it('never mentions is_horse: horses are players (CLAUDE.md 10.5)', () => {
    expect(games.sql).not.toMatch(/is_horse/);
    expect(opens.sql).not.toMatch(/is_horse/);
  });

  it('the wheel opened with a seeded diamond float, and it still bounds the diamond side', () => {
    expect(opens.sql).toMatch(
      /ADD COLUMN IF NOT EXISTS diamond_seed integer NOT NULL DEFAULT 2500 CHECK \(diamond_seed >= 0\)/
    );
    const t = body(opens.sql, 'fn_wheel_pool_seed');
    expect(t).toContain(
      'NEW.diamond_float := COALESCE(NEW.diamond_float, 0) + COALESCE(v_seed, 0);'
    );
    // 2026-09-10: the house take is what the host kept - everything it took in,
    // less the chips and the diamonds it paid back out. Nothing is minted, so
    // there is no mint to subtract and no seed to net out.
    const m = body(host.sql, 'fn_wheel_metrics');
    expect(m).toContain('THEN round(pool.intake_diamonds::numeric / v_rate - pool.chips_paid');
    expect(m).toContain('- pool.diamonds_paid::numeric / v_rate, 4) END,');
    expect(m).not.toContain('pool.chips_minted');
  });

  it('the registry knows the three money movers', () => {
    expect(games.sql).toContain("('fn_plinko_drop', 'approved',");
    expect(games.sql).toContain("('fn_crash_start', 'approved',");
    expect(games.sql).toContain("('fn_crash_settle', 'approved',");
  });
});
