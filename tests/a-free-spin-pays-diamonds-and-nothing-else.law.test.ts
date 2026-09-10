/**
 * A FREE SPIN PAYS DIAMONDS AND NOTHING ELSE (2026-09-09, BINDING)
 *
 * Dan 2026-09-07: the wheel must "never pay more out than we take in." A free
 * spin takes nothing in. So the free spin a day
 * (supabase/migrations/20260909234101_the_wheel_gives_a_free_spin_a_day.sql)
 * may pay diamonds - the platform's promotional currency, granted every day
 * already by the Daily Bonus and the missions - and may never pay a chip: a
 * chip minted against nothing is exactly the faucet the law closes.
 *
 * The pins below are the shape that keeps it:
 *
 *   - the free table has no kind column: every row is a positive number of
 *     diamonds, and the migration refuses to commit unless the weights sum to
 *     1,000, the table pays 9.75 a spin, and every segment pays;
 *   - fn_wheel_free_spin credits through add_diamonds_to_balance with a
 *     wheel:<id>:free reference (so the diamond earn ledger attributes it and
 *     the per-user daily cap applies) and touches no chip door, no bank, no
 *     pool and no member wallet;
 *   - free spins live in wheel_free_spins, never wheel_spins, so a spin with
 *     no intake cannot put the paid wheel's realised return over 100 percent;
 *   - one per player per host per day is a UNIQUE constraint, the day's pot
 *     is counted under the host's row lock, and the record is append-only;
 *   - the roll is the paid wheel's derivation byte for byte, so the player's
 *     own verifier checks a free spin unchanged;
 *   - the profile guard names the door, the way it names fn_wheel_spin;
 *   - no is_horse filter: a horse is a player (10.5).
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

const mig = latest('_the_wheel_gives_a_free_spin_a_day');
const SPIN = body(mig.sql, 'fn_wheel_free_spin');
const SERVICE = readFileSync(
  resolve(__dirname, '..', 'src/services/DiamondWheelService.ts'),
  'utf8'
);
const PAGE = readFileSync(resolve(__dirname, '..', 'src/pages/DiamondWheelPage.tsx'), 'utf8');

describe('the free table is diamonds, every row pays, and it audits before it commits', () => {
  it('has an amount and a weight and no kind', () => {
    const table = mig.sql.slice(
      mig.sql.indexOf('CREATE TABLE IF NOT EXISTS public.wheel_free_segments'),
      mig.sql.indexOf('ALTER TABLE public.wheel_free_segments ENABLE ROW LEVEL SECURITY')
    );
    expect(table).toContain('amount   integer NOT NULL CHECK (amount > 0)');
    expect(table).toContain('weight   integer NOT NULL CHECK (weight > 0)');
    expect(table).not.toMatch(/kind/);
  });

  it('as seeded: five prizes, weights 1,000, 9.75 diamonds a spin', () => {
    const block = mig.sql.slice(
      mig.sql.indexOf('INSERT INTO public.wheel_free_segments'),
      mig.sql.indexOf('ON CONFLICT (ord) DO NOTHING')
    );
    const rows = [...block.matchAll(/\((\d+),\s*'([^']+)',\s*(\d+),\s*(\d+)\)/g)];
    expect(rows.length).toBe(5);
    let weight = 0;
    let ev = 0;
    for (const [, , , amount, w] of rows) {
      expect(Number(amount)).toBeGreaterThan(0);
      weight += Number(w);
      ev += Number(amount) * Number(w);
    }
    expect(weight).toBe(1000);
    expect(ev / weight).toBe(9.75);
  });

  it('the migration refuses to commit on any other table', () => {
    expect(mig.sql).toContain('IF v_total <> 1000 THEN');
    expect(mig.sql).toContain('IF v_ev <> 9.75 THEN');
    expect(mig.sql).toContain(
      'IF EXISTS (SELECT 1 FROM public.wheel_free_segments WHERE amount <= 0) THEN'
    );
  });
});

describe('the free spin pays through the diamond door and no other', () => {
  it('credits diamonds with a wheel:<id>:free reference, and raises if the credit fails', () => {
    expect(SPIN).toContain("public.add_diamonds_to_balance(v_user, v_pick.amount, 'wheel_prize',");
    expect(SPIN).toContain("'wheel:' || v_spin_id::text || ':free'");
    expect(SPIN).toContain(
      "RAISE EXCEPTION 'fn_wheel_free_spin: the free spin prize could not be credited"
    );
  });

  it('never mints, never pays chips, never touches the bank, the pool or a member wallet', () => {
    for (const forbidden of [
      'fn_ca_mint',
      'fn_wheel_mint',
      'union_wallet',
      'chip_balance',
      'chip_transactions',
      'club_members SET',
      'wheel_pools',
      'deduct_diamonds',
      'INSERT INTO public.wheel_spins',
    ]) {
      expect(SPIN, `fn_wheel_free_spin must not touch ${forbidden}`).not.toContain(forbidden);
    }
    expect(SPIN).toContain('INSERT INTO public.wheel_free_spins');
  });

  it('prices the spin at nothing and says so in its result', () => {
    const result = body(mig.sql, 'fn_wheel_free_spin_result');
    expect(result).toContain("'free', true");
    expect(result).toContain("'spin_price_diamonds', 0");
    expect(result).toContain("'kind', 'diamonds'");
    expect(result).not.toContain("'chips'");
  });
});

describe('one a day, a pot a day, and a record that cannot be edited', () => {
  it('one per player per host per day is a constraint, not a check', () => {
    expect(mig.sql).toContain('UNIQUE (host_id, user_id, day)');
    expect(SPIN).toContain("(now() AT TIME ZONE 'America/Chicago')::date");
    expect(SPIN).toContain("'You Have Had Today''s Free Spin. Another Comes Tomorrow'");
  });

  it('the pot is counted under the host row lock, so two spins cannot share the last of it', () => {
    const lock = SPIN.indexOf('FROM public.wheel_configs WHERE host_id = v_host FOR UPDATE');
    const count = SPIN.indexOf('IF v_paid_today >= cfg.free_spin_daily_budget_diamonds THEN');
    expect(lock).toBeGreaterThan(-1);
    expect(count).toBeGreaterThan(lock);
    expect(SPIN).toContain("'Today''s Free Spins Are Gone. They Return Tomorrow'");
  });

  it('a free spin is a fact: append-only, like a paid one', () => {
    expect(mig.sql).toContain('CREATE TRIGGER trg_wheel_free_spins_append_only');
    expect(mig.sql).toContain('BEFORE UPDATE OR DELETE ON public.wheel_free_spins');
    expect(mig.sql).toContain('FOR EACH ROW EXECUTE FUNCTION public.fn_wheel_append_only();');
  });

  it('a commit is spent once: the second call replays the first spin', () => {
    expect(SPIN).toContain(
      'SELECT * INTO prior FROM public.wheel_free_spins WHERE commit_id = p_commit_id;'
    );
    expect(SPIN).toContain(
      "RETURN public.fn_wheel_free_spin_result(prior) || jsonb_build_object('replayed', true);"
    );
    expect(SPIN).toContain(
      'UPDATE public.wheel_seed_commits SET consumed_by = v_spin_id WHERE id = cm.id;'
    );
  });
});

describe('the same roll as a paid spin, and the same verifier', () => {
  it('derives the point from HMAC-SHA256(server seed, client:nonce) as 48 bits over the free weights', () => {
    expect(SPIN).toContain('c_two48 constant numeric := 281474976710656;');
    expect(SPIN).toContain(
      "v_hmac := extensions.hmac(convert_to(v_client || ':' || v_nonce::text, 'UTF8'),"
    );
    expect(SPIN).toContain("convert_to(cm.server_seed, 'UTF8'), 'sha256');");
    expect(SPIN).toContain(
      "v_roll  := (('x' || encode(substring(v_hmac from 1 for 6), 'hex'))::bit(48)::bigint)::numeric;"
    );
    expect(SPIN).toContain('v_point := floor(v_roll * v_total / c_two48);');
    expect(SPIN).toContain(
      'FOR seg IN SELECT * FROM public.wheel_free_segments g ORDER BY g.ord LOOP'
    );
  });

  it('the browser checks a free spin against the free table, a paid one against the paid table', () => {
    expect(PAGE).toContain('const eligible = (result.free ? freeSegments : segments)');
    expect(SERVICE).toContain("supabase.rpc('fn_wheel_free_spin', {");
    expect(SERVICE).toContain('free: Boolean(raw.free),');
  });
});

describe('the doors are named and a horse is a player', () => {
  it('the profile guard admits fn_wheel_free_spin the way it admits fn_wheel_spin', () => {
    expect(mig.sql).toContain("OR v_stack ~ 'function (public[.])?fn_wheel_free_spin[(]'");
    expect(mig.sql).toContain("NOT LIKE '%fn_wheel_free_spin[(]%'");
  });

  it('every door refuses anon and a caller with no account', () => {
    for (const fn of [
      'fn_wheel_free_state(uuid)',
      'fn_wheel_free_spin(uuid, uuid, text)',
      'fn_wheel_set_free_spin(uuid, jsonb)',
    ]) {
      expect(mig.sql).toContain(`REVOKE ALL ON FUNCTION public.${fn} FROM PUBLIC, anon;`);
    }
    expect(SPIN).toContain("RETURN jsonb_build_object('ok', false, 'error', 'Sign In To Spin');");
  });

  it('no is_horse filter anywhere in it', () => {
    expect(mig.sql).not.toMatch(/is_horse/);
    expect(latest('_the_wheel_remembers_its_free_spins').sql).not.toMatch(/is_horse/);
  });
});
