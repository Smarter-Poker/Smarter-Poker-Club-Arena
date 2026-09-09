/**
 * ===========================================================================
 *  A SETTLED CHEST CANNOT BE PAID A SECOND TIME (2026-08-30)
 * ===========================================================================
 *
 * The sibling guard, bountyPoolConservation.guard.test.ts, pinned the FIRST
 * residual payer to the ledger. A conservation check the following morning
 * still found two events over pool:
 *
 *   Saturday Mystery                pool 776.00  paid 783.20   (+7.20)
 *   Pre-Dawn Mystery Bounty (PLO5)  pool  30.00  paid  32.60   (+2.60)
 *
 * Chest e794df3d of the PLO5 event is worth 260 cents and was paid twice, ten
 * seconds apart, to the same person:
 *
 *   03:33:01  "Unclaimed mystery bounty chests awarded to champion"   2.60
 *   03:33:11  "Mystery bounty revealed from eliminated player"        2.60
 *
 * fn_mystery_bounty_settle swept the chest to the champion and marked the
 * CHEST void, but left the AWARD attached to it alive. The reveal already in
 * flight then paid the same chest to the knocker under its own idempotency
 * key -- 'mb:<award>:<user>' rather than 'mb-residual:<tournament>' -- so
 * neither credit could see the other.
 *
 * THE RULES THIS PINS:
 *   1. settle pays what is already revealed BEFORE it decides what is
 *      unclaimed, so an opened chest belongs to whoever opened it;
 *   2. settle voids the awards of the chests it sweeps, in the same
 *      transaction as the sweep;
 *   3. fn_mystery_bounty_pay refuses a voided award and a voided chest;
 *   4. the champion residual is clamped to what the pool still holds
 *      according to the LEDGER.
 *
 * If any of these fails, someone has re-opened the double-spend. The fix is
 * never to relax the guard.
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

const MIGRATIONS = path.join(process.cwd(), '..', 'supabase', 'migrations');

/** Strip SQL comments so a guard cannot pass on prose describing the old code. */
const strip = (s: string) => s.replace(/^\s*--.*$/gm, '');

/**
 * The NEWEST definition of the named function, sliced out of the migration
 * that carries it. Sliced, because a migration that redefines two functions
 * would otherwise let one of them satisfy an assertion about the other.
 */
function newestDefining(fn: string, required = ''): string {
  const bodies = fs
    .readdirSync(MIGRATIONS)
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .map((f) => strip(fs.readFileSync(path.join(MIGRATIONS, f), 'utf8')))
    // ACL/search-path hardening migrations legitimately contain
    // `ALTER FUNCTION public.<name>`. They are not a function definition and
    // must never outrank the newest CREATE body merely because they sort later.
    .filter((b) => b.includes(`CREATE OR REPLACE FUNCTION public.${fn}`))
    .map((body) => {
      const start = body.indexOf(`CREATE OR REPLACE FUNCTION public.${fn}`);
      const next = body.indexOf('CREATE OR REPLACE FUNCTION', start + 1);
      return body.slice(start, next === -1 ? undefined : next);
    })
    .filter((body) => !required || body.includes(required));
  expect(bodies.length).toBeGreaterThan(0);
  return bodies[bodies.length - 1];
}

describe('fn_mystery_bounty_settle', () => {
  it('pays the already revealed awards before it decides what is unclaimed', () => {
    const def = newestDefining('fn_mystery_bounty_settle', 'PERFORM public.fn_mystery_bounty_pay');
    const paysRevealed = def.indexOf('PERFORM public.fn_mystery_bounty_pay');
    const countsUnclaimed = def.indexOf("status IN ('available','reserved','revealed')");
    expect(paysRevealed).toBeGreaterThan(-1);
    expect(countsUnclaimed).toBeGreaterThan(-1);
    expect(paysRevealed).toBeLessThan(countsUnclaimed);
  });

  it('voids the awards of the chests it sweeps to the champion', () => {
    const def = newestDefining('fn_mystery_bounty_settle', 'PERFORM public.fn_mystery_bounty_pay');
    expect(def).toMatch(
      /UPDATE\s+public\.tournament_bounty_awards[\s\S]{0,200}SET\s+status\s*=\s*'void'/
    );
  });

  it('clamps the champion residual to what the pool still holds in the ledger', () => {
    const def = newestDefining('fn_mystery_bounty_settle', 'PERFORM public.fn_mystery_bounty_pay');
    expect(def).toContain('FROM wallet_transactions wt');
    expect(def).toMatch(/v_room/);
    expect(def).toMatch(/v_residual\s*>\s*v_room/);
  });
});

describe('fn_mystery_bounty_pay', () => {
  it('refuses an award the settlement already voided', () => {
    const def = newestDefining('fn_mystery_bounty_pay', 'award_voided_by_settlement');
    expect(def).toContain('award_voided_by_settlement');
    expect(def).toMatch(/v_a\.status\s*=\s*'void'/);
  });

  it('refuses a chest that was settled to the champion', () => {
    const def = newestDefining('fn_mystery_bounty_pay', 'award_voided_by_settlement');
    expect(def).toContain('chest_settled_to_champion');
  });

  it('is a self-contained root with the global terminal lock and exact obligation payer', () => {
    const root = newestDefining('fn_mystery_bounty_pay');
    expect(root).not.toContain('fn_mystery_bounty_pay_unguarded_20260907');
    expect(root).toContain("hashtextextended('ca:tournament-terminal-settlement:v1',0)");
    expect(root).toContain('public.fn_settle_tournament_obligation(');
    expect(root).toContain('completed_award_marker_incomplete');
    expect(root).toContain('public.fn_bounty_obligation_has_complete_marker');
  });
});
