/**
 * A CHIP IS TWO DECIMAL PLACES, EVERYWHERE IT IS STORED (#3358) - AND EVERY
 * PATH THAT COMPUTES ONE ROUNDS BEFORE IT LEAVES (2026-09-09).
 *
 * The 2026-09-08 add-on incident was one line: `Math.min(amount, maxBuyIn -
 * stack)` is a float subtraction (50 - 33.33 = 16.670000000000002), it went
 * to `atomic_table_addon`, and `atomic_table_addon` stores it verbatim. 49
 * rows in `table_pending_addons` and 62 in `table_addon_idempotency` on
 * production carry such a value. `resolve_pending_addon` cannot produce a
 * receipt that sums back to a non-cent amount, and the post-commit obligation
 * refuses one that does not - deterministically - so the next frozen row of
 * that shape would have stopped a cash table dealing until a human noticed.
 *
 * The sweep that followed found the SAME EXPRESSION on four more paths, one
 * of which (`BuyInModal`'s 33%/66% presets) could not seat a player at all,
 * because `CashBuyInRecovery.validIntent` refuses a non-cent intent and the
 * refusal surfaced as "Unable To Start Your Buy-In. Please Try Again."
 *
 * These pin the arithmetic at each door. They are source pins on purpose:
 * the failure is a value that only appears for particular stakes, so a unit
 * test with tidy numbers passes while the door is open.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { sliceMethod, sliceStatement } from './helpers/sourceWindow';

const read = (p: string) => readFileSync(resolve(__dirname, '..', p), 'utf8');
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');

describe('every client door that sizes a chip amount rounds it first', () => {
  it('the auto top-up rounds before it sends', () => {
    expect(strip(read('src/pages/TablePage.tsx'))).toMatch(
      /Math\.round\(Math\.min\(maxBuyIn - currentStack, accountBalance \?\? 0\) \* 100\) \/ 100/
    );
  });

  it('the bust rebuy rounds at the wire, not only in the modal', () => {
    const fn = sliceStatement(read('src/pages/TablePage.tsx'), 'const confirmBustRebuy');
    expect(fn).toMatch(/Math\.round\(requested \* 100\) \/ 100/);
  });

  it("BuyInModal's clamp is to the cent, which is what the buy-in journal demands", () => {
    const src = sliceStatement(read('src/components/table/BuyInModal.tsx'), 'const clampedBuyIn');
    expect(src).toMatch(/Math\.round\(raw \* 100\) \/ 100/);
  });

  it("the cashier's MAX preset is truncated like its three siblings", () => {
    expect(strip(read('src/components/table/CashierModal.tsx'))).toMatch(
      /\{ label: 'MAX', value: Math\.trunc\(max \* 100\) \/ 100 \}/
    );
  });

  it('a multi-table pot-sized raise is a cent amount, not a whole chip', () => {
    const src = strip(read('src/pages/MultiTablePage.tsx'));
    expect(src).toMatch(
      /Math\.round\(\(toCall \+ \(pot \+ toCall \* 2\) \* frac\) \* 100\) \/ 100/
    );
    // Rounding the WAGER to a whole chip sent a bet the player never chose.
    expect(src).not.toMatch(/Math\.round\(toCall \+ \(pot \+ toCall \* 2\) \* frac\)/);
  });

  it('the session record stores money to the cent', () => {
    const src = strip(read('src/services/SessionStatsService.ts'));
    expect(src).toMatch(/const cents = \(n: number\): number =>/);
    expect(src).toMatch(/session\.profitLoss = cents\(/);
    expect(src).toMatch(/session\.buyInTotal = cents\(/);
  });
});

describe('the engine refuses, and rounds, at its own doors', () => {
  it('/addchips refuses a non-cent amount at the boundary', () => {
    expect(strip(read('server/src/handlers/addchips.ts'))).toMatch(
      /Math\.round\(amount \* 100\) \/ 100 !== amount/
    );
  });

  it('addChips rounds what it sends to the ledger', () => {
    const src = strip(read('server/src/engine/ServerTableEngineSeating.ts'));
    expect(src).toMatch(
      /const applied = Math\.round\(Math\.min\(amount, headroom\) \* 100\) \/ 100;/
    );
  });

  it('the max buy-in itself is a cent number', () => {
    const src = sliceMethod(read('server/src/engine/ServerTableEngineBase.ts'), 'getMaxBuyIn()');
    expect(src).toMatch(/Math\.round\(raw \* 100\) \/ 100/);
  });

  it('every stack settlement writes is rounded, including the difference', () => {
    const src = strip(read('server/src/engine/ServerTableEngineSettlement.ts'));
    expect(src).toMatch(/const cents = \(n: number\): number =>/);
    expect(src).toMatch(/seatedPlayer\.stack = cents\(seatedPlayer\.stack \+ settlement\.payout\)/);
    // `before - stack` is float CANCELLATION, not merely imprecise.
    expect(src).toMatch(/const applied = cents\(before - seatedPlayer\.stack\)/);
  });

  it('every jackpot share landing on a seat is snapped, because each one is a division', () => {
    // 50 / 25 / 25 of the jackpot, the last split again per dealt-in player,
    // written onto the SAME seat array persistStacks writes to table_seats.
    const src = strip(read('server/src/engine/ServerTableEngineSettlement.ts'));
    expect(src).toMatch(/loserSeat\.stack = cents\(loserSeat\.stack \+ result\.loserShare\)/);
    expect(src).toMatch(/winnerSeat\.stack = cents\(winnerSeat\.stack \+ result\.winnerShare\)/);
    expect(src).toMatch(/seat\.stack = cents\(seat\.stack \+ result\.perPlayerShare\)/);
    // The mini jackpot's table share is reserve/players. Its existing stack,
    // credit and rounded result must all pass the finite-money boundary.
    expect(src).toMatch(/const credit = this\.requireFiniteStackMoney\(amount,/);
    expect(src).toMatch(/const stack = this\.requireFiniteStackMoney\(seat\.stack,/);
    expect(src).toMatch(/cents\(stack \+ credit\)/);
    expect(src).not.toMatch(/Seat\.stack \+= result\./);
  });

  it('the between-hands add-on snaps like the queued one beside it', () => {
    const src = strip(read('server/src/engine/ServerTableEngineSeating.ts'));
    expect(src).toMatch(
      /player\.stack = Math\.round\(\(player\.stack \+ applied\) \* 100\) \/ 100;/
    );
    expect(src).not.toMatch(/player\.stack \+= applied;/);
  });

  it('the stack-version baseline is cents, so an exact all-in is not refused', () => {
    // `amount > sv.stack` compares an all-in against this Map. 1e-13 of drift
    // there refuses a debit that is exactly the stack.
    const src = strip(read('server/src/engine/AtomicStackService.ts'));
    expect(src).toMatch(/const round2 = \(n: number\): number =>/);
    expect(src).toMatch(/stack: round2\(stack\), version: 1/);
    expect(src).toMatch(/sv\.stack = round2\(sv\.stack - amount\);/);
    expect(src).toMatch(/const nextStack = sv\.stack \+ amount;/);
    expect(src).toMatch(/sv\.stack = round2\(nextStack\);/);
    expect(src).toMatch(/sv\.stack = round2\(sv\.stack \+ s\.delta\);/);
  });

  it("a horse's rebuy is a cent amount, so its own guard cannot refuse it", () => {
    // autoRebuyHorse refuses non-2dp, so an unrounded bb*100 meant the horse
    // silently never rebought where a human did (CLAUDE.md 10.5).
    expect(strip(read('server/src/services/HorseRebuyPolicy.ts'))).toMatch(
      /Math\.round\(raw \* 100\) \/ 100/
    );
  });
});

describe('and the database will not accept one either', () => {
  const mig = read(
    'supabase/migrations/20260909062006_chips_are_two_decimals_on_the_addon_path.sql'
  );

  it('says who may call each function, so a replay cannot create it PUBLIC', () => {
    // CREATE OR REPLACE keeps an existing ACL, so this changes nothing live.
    // On a FRESH database these are CREATEs, and Postgres grants EXECUTE to
    // PUBLIC on creation - which would make a SECURITY DEFINER chip writer
    // callable by anon. PUBLIC has to be named: anon inherits from it.
    for (const fn of ['atomic_table_addon', 'atomic_table_buyin', 'resolve_pending_addon']) {
      const at = mig.indexOf(`REVOKE ALL ON FUNCTION public.${fn}(`);
      expect(at, `${fn} has no REVOKE`).toBeGreaterThan(-1);
      expect(mig.slice(at, mig.indexOf(';', at))).toMatch(/FROM PUBLIC, anon/);
      expect(mig).toMatch(new RegExp(`GRANT EXECUTE ON FUNCTION public\\.${fn}\\(`));
    }
    // The add-on and the resolver are engine-only; the buy-in is a player's
    // own call and keeps `authenticated`.
    expect(mig).toMatch(
      /REVOKE ALL ON FUNCTION public\.atomic_table_addon\([^)]*\)\s*\n\s*FROM PUBLIC, anon, authenticated;/
    );
    expect(mig).toMatch(
      /GRANT EXECUTE ON FUNCTION public\.atomic_table_buyin\([^)]*\)\s*\n\s*TO authenticated, service_role;/
    );
  });

  it('both cash doors refuse a non-cent amount before claiming a receipt', () => {
    for (const fn of ['atomic_table_addon', 'atomic_table_buyin']) {
      const at = mig.indexOf(`CREATE OR REPLACE FUNCTION public.${fn}(`);
      expect(at, fn).toBeGreaterThan(-1);
      const body = mig.slice(at, mig.indexOf('$function$;', at));
      const guard = body.indexOf('p_amount <> round(p_amount, 2)');
      const claim = body.indexOf('fn_claim_entry_purchase_receipt');
      expect(guard, `${fn} has no cent guard`).toBeGreaterThan(-1);
      // Before the claim, or a refused request burns its idempotency key.
      expect(guard, `${fn} guards after claiming`).toBeLessThan(claim);
    }
  });

  it('the resolution splits the STORED amount, so the receipt always sums back', () => {
    const at = mig.indexOf('CREATE OR REPLACE FUNCTION public.resolve_pending_addon(');
    const body = mig.slice(at, mig.indexOf('$function$;', at));
    expect(body).toMatch(/v_applied\s*:= round\(v_applied, 2\);/);
    expect(body).toMatch(/v_refunded := v_row\.amount - v_applied;/);
    // The old order derived the refund from an UNROUNDED applied, which is
    // why a non-cent amount could never be resolved at all.
    expect(body).not.toMatch(/v_refunded := ROUND\(v_row\.amount - v_applied, 2\)/);
  });

  it('the four unscaled columns carry a cent CHECK, and no settled row is rewritten', () => {
    for (const c of [
      'table_pending_addons_amount_is_cents',
      'table_pending_addons_applied_is_cents',
      'table_pending_addons_refunded_is_cents',
      'table_addon_idempotency_amount_is_cents',
    ]) {
      expect(mig, c).toContain(c);
    }
    // Four constraints; the header also explains NOT VALID twice.
    expect((mig.match(/\) NOT VALID;/g) || []).length).toBe(4);
    expect(mig).not.toMatch(/UPDATE public\.table_pending_addons\s+SET amount/);
  });
});
