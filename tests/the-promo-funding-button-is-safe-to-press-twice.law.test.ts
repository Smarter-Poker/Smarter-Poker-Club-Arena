/**
 * THE PROMO FUNDING BUTTON IS SAFE TO PRESS TWICE (2026-09-11, BINDING)
 *
 * fn_diamond_game_fund_promo moves chips from a host's bank into its promo
 * wallet, which is what pays every chip prize in the three Diamond Games. It
 * was written on 2026-09-10 with this line in it:
 *
 *     v_key text := 'diamond-games-fund:' || gen_random_uuid()::text;
 *
 * A key the server mints per call is not an idempotency key. The journal's
 * ux_chip_ledger_idempotency_key index cannot refuse a replay it has never
 * seen, so a double-tap, or a request that succeeded and lost its reply on the
 * way back, moved the chips twice and wrote two legs that both looked right. A
 * rolled-back probe on production proved it: two identical presses of 25 chips
 * moved 50 and wrote two legs under two generated keys.
 *
 * `disabled={funding}` is not a defence. It is released the moment the promise
 * settles, and it never existed for the retry.
 *
 * WHAT IS PINNED HERE, SO THE SHAPE CANNOT COME BACK:
 *
 *   - the key comes from the CALLER and the keyless door is gone, not left
 *     ajar beside the new one;
 *   - the server namespaces and validates what it is given, so a caller can
 *     only ever write inside this function's own keyspace;
 *   - the replay guard sits AFTER fn_diamond_game_cover_lock has taken the
 *     host's wallet row FOR UPDATE, which is the whole reason check-then-act
 *     is safe here, and it answers with the balances rather than an error;
 *   - the guard is load-bearing: the function refuses to return unless a leg
 *     actually carries the key, because replay protection that reads a journal
 *     row is worth nothing if the row can quietly not be written;
 *   - both host shapes write the operator's own wallet history, not just the
 *     union one;
 *   - the client mints ONE key per intent and HOLDS it across a thrown
 *     request, which is the half of the protection that lives in the browser.
 *     A key minted per press would put the bug straight back;
 *   - and a request that never answered is reported as what it is. The first
 *     cut of this said "Those Chips Could Not Be Moved" on a thrown request,
 *     which is a claim nobody in the browser is in a position to make, printed
 *     over numbers that were never rechecked. The console rereads instead.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'fs';
import { resolve } from 'path';

const DIR = resolve(__dirname, '..', 'supabase/migrations');
const SRC = resolve(__dirname, '..', 'src');
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

const src = (p: string) => readFileSync(resolve(SRC, p), 'utf8');

const twice = latest('the_promo_funding_button_is_safe_to_press_twice');
const FUND = body(twice.sql, 'fn_diamond_game_fund_promo');

const PAGES = [
  'pages/club/ClubDiamondGamesOperationsPage.tsx',
  'pages/club/ClubWheelOperationsPage.tsx',
];

describe('the key comes from the caller', () => {
  it('the door takes p_key and the keyless one is dropped', () => {
    expect(twice.sql).toContain('p_key     text');
    expect(twice.sql).toContain(
      'DROP FUNCTION IF EXISTS public.fn_diamond_game_fund_promo(uuid, numeric);'
    );
  });

  it('the server never mints one for itself', () => {
    // The defect, exactly: a key generated inside the body is no key at all.
    expect(FUND).not.toContain('gen_random_uuid()');
  });

  it('it is namespaced and shape-checked before it is used', () => {
    expect(FUND).toContain("v_key := 'diamond-games-fund:' || p_key;");
    expect(FUND).toContain("p_key !~ '^[A-Za-z0-9_-]{8,64}$'");
    // A key this door cannot trust is refused. Falling back on a generated one
    // is the bug wearing a validation check.
    const guard = FUND.slice(FUND.indexOf('p_key !~'), FUND.indexOf('v_key :='));
    expect(guard).toContain('RETURN jsonb_build_object');
  });
});

describe('the replay guard', () => {
  it('reads the journal only after the host row is held FOR UPDATE', () => {
    const lock = FUND.indexOf('fn_diamond_game_cover_lock');
    const guard = FUND.indexOf('WHERE l.idempotency_key = v_key');
    expect(lock).toBeGreaterThan(-1);
    expect(guard).toBeGreaterThan(lock);
  });

  it('answers a replay with the balances, not an error', () => {
    expect(FUND).toContain("'ok', true, 'replayed', true");
    expect(FUND).toContain("'ok', true, 'replayed', false");
  });

  it('refuses to return unless a leg actually carries the key', () => {
    const assertion = FUND.slice(
      FUND.lastIndexOf('IF NOT EXISTS (SELECT 1 FROM public.chip_ledger')
    );
    expect(assertion).toContain('RAISE EXCEPTION');
    expect(assertion).toContain('wrote no journal leg');
  });

  it('does not move the chips before it has checked', () => {
    const guard = FUND.indexOf('WHERE l.idempotency_key = v_key');
    expect(FUND.indexOf('UPDATE public.union_wallets')).toBeGreaterThan(guard);
    expect(FUND.indexOf('UPDATE public.clubs')).toBeGreaterThan(guard);
  });
});

describe('the operator sees their own money move', () => {
  it('a union host writes union_wallet_transactions', () => {
    expect(FUND).toContain('INSERT INTO public.union_wallet_transactions');
  });

  it('a standalone club writes club_wallet_transactions, which it never used to', () => {
    expect(FUND).toContain('INSERT INTO public.club_wallet_transactions');
    // The type vocabulary is fixed and none of its nine other words mean this,
    // so it is booked as other rather than widening a money constraint.
    expect(FUND).toContain("'other'");
  });

  it('fractions of a cent are answered in words, not by a constraint violation', () => {
    expect(FUND).toContain('p_amount <> round(p_amount, 2)');
    expect(FUND).toContain('Chips Move In Whole Cents');
  });
});

describe('the door says who may knock', () => {
  it('PUBLIC and anon are revoked and the browser role is granted', () => {
    expect(twice.sql).toContain(
      'REVOKE ALL ON FUNCTION public.fn_diamond_game_fund_promo(uuid, numeric, text) FROM PUBLIC;'
    );
    expect(twice.sql).toContain(
      'REVOKE ALL ON FUNCTION public.fn_diamond_game_fund_promo(uuid, numeric, text) FROM anon;'
    );
    expect(twice.sql).toContain(
      'GRANT EXECUTE ON FUNCTION public.fn_diamond_game_fund_promo(uuid, numeric, text) TO authenticated;'
    );
  });

  it('it asks who is calling, which is what check-definer-authorization wants', () => {
    expect(FUND).toContain('auth.uid()');
    expect(FUND).toContain('fn_wheel_can_operate');
  });
});

describe('the half of the protection that lives in the browser', () => {
  it('the service requires the key and sends it', () => {
    const s = src('services/DiamondGamesService.ts');
    expect(s).toContain('key: string');
    expect(s).toContain('p_key: key,');
    // Optional would mean callers could quietly go back to not sending one.
    expect(s).not.toContain('key?: string');
  });

  it.each(PAGES)('%s mints one key per intent and holds it across a failure', (page) => {
    const s = src(page);
    expect(s).toContain('fundKeyRef');
    expect(s).toContain(
      'const intent = held && held.amount === amount ? held : { amount, key: uuid() };'
    );
    expect(s).toContain('DiamondGamesService.fundPromo(clubUuid, amount, intent.key)');
    // Cleared only where the server has answered. If the catch block cleared
    // it too, the retry would mint a new key and move the chips twice.
    const clears = s.split('fundKeyRef.current = null;').length - 1;
    expect(clears).toBe(1);
    const cleared = s.indexOf('fundKeyRef.current = null;');
    const caught = s.indexOf('} catch (err) {', s.indexOf('const moveIntoPromo'));
    expect(cleared).toBeLessThan(caught);
  });

  it.each(PAGES)('%s tells the operator a replay moved nothing', (page) => {
    expect(src(page)).toContain("'Those Chips Were Already Moved'");
  });

  it.each(PAGES)('%s rereads after a thrown request instead of claiming it failed', (page) => {
    const s = src(page);
    const caught = s.slice(s.indexOf('} catch (err) {', s.indexOf('const moveIntoPromo')));
    const block = caught.slice(0, caught.indexOf('} finally {'));
    // Nobody in the browser knows whether a request that never answered moved
    // the chips. Saying it did not is a claim, and it sat on stale numbers.
    expect(block).not.toContain('Those Chips Could Not Be Moved');
    expect(block).toContain("toast.error('No Answer Came Back. The Numbers Below Are Rechecked')");
    expect(block).toContain('load(');
  });
});
