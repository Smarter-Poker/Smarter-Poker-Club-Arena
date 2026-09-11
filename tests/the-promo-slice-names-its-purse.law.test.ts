/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  THE POOL IS THE OCCASION, NOT THE PURSE
 *  BBJ programme phase 5 of 5 (2026-09-11)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `fn_bbj_promo_payout_atomic` says it in its own body, and has since Dan's
 * ruling of 2026-09-03: the promo money is spent from the union's
 * `promo_wallet`, or a standalone club's `clubs.promo_balance`. THE PURSE.
 * `bbj_pools.promo_balance` is a staging slot that `fn_sweep_bbj_promo` empties
 * continuously - twelve sweeps in the hour this was measured - so it sits near
 * zero by design.
 *
 * Every promo surface read the staging slot. Measured on production
 * 2026-09-11:
 *
 *     THE PURSE   Midway Union        56,291.01
 *                 Deep Stack Society  21,246.52
 *     THE POOL    union pool              14.61   <- what the page showed
 *                 Deep Stack Society        7.28
 *
 * and the jackpot page used that 14.61 for the balance it displayed, the guard
 * on the amount, the input's `max`, the Max button, AND the condition that
 * decided whether the control appeared at all.
 *
 * WORSE, THE CONTROL COULD NEVER WORK. It called `fn_bbj_promo_rain`, which is
 * a deliberate stub: "the splash pot has never been built or specified ...
 * THIS MOVES NO CHIPS." `BBJService.executePromoRain` did not map
 * `not_built_yet`, so confirming a dialog that said "this can't be undone"
 * produced a toast reading `not_built_yet`.
 *
 * The money was never wrong - `fn_bbj_promo_bank_check()` reconciles with
 * `unexplained: 0`. This law is about the reporting.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = resolve(__dirname, '..');
const read = (p: string) => readFileSync(resolve(ROOT, p), 'utf8');

/**
 * The CODE, with comments removed.
 *
 * Every "must not contain" below is about what the app DOES, and the files
 * deliberately explain in prose what was removed and why - quoting the old
 * button labels and the old bar heading. Asserting against the raw text makes
 * the explanation itself illegal, which would push the next author to delete
 * the reasoning to get the law green. Strip the comments and assert on code.
 */
const code = (p: string) =>
  read(p)
    .replace(/\{\s*\/\*[\s\S]*?\*\/\s*\}/g, '') // JSX comment blocks
    .replace(/\/\*[\s\S]*?\*\//g, '') // block comments
    .replace(/^\s*\/\/.*$/gm, ''); // line comments

describe('no surface offers the promo rain while it is a stub', () => {
  it('the client cannot call fn_bbj_promo_rain at all', () => {
    for (const f of [
      'src/services/BBJService.ts',
      'src/pages/BadBeatJackpotPage.tsx',
      'src/components/bbj/BBJAdminAnalytics.tsx',
    ]) {
      const src = code(f);
      // naming it in a comment that explains the removal is the point; calling
      // it is not.
      expect(src, `${f} must not call the stub`).not.toMatch(
        /supabase\.rpc\(\s*'fn_bbj_promo_rain'/
      );
      expect(src, `${f} must not call executePromoRain`).not.toMatch(
        /BBJService\.executePromoRain\(/
      );
    }
  });

  it('the dead control and its state are gone, not merely disabled', () => {
    // A disabled control still advertises a feature (CLAUDE.md 10.12).
    const page = code('src/pages/BadBeatJackpotPage.tsx');
    expect(page).not.toMatch(/const runPromoRain\b/);
    expect(page).not.toMatch(/setDistributingPromo\(/);
    expect(page).not.toMatch(/Rain To Active Players/);
    expect(page).not.toMatch(/Rain it/);
  });
});

describe('promo money is reported from the purse, never the staging slot', () => {
  const MIGRATION = 'supabase/migrations/20260911170328_the_promo_slice_names_its_purse.sql';

  it('the read exists and names the purse both ways', () => {
    expect(existsSync(resolve(ROOT, MIGRATION))).toBe(true);
    const sql = read(MIGRATION);
    expect(sql).toMatch(/CREATE OR REPLACE FUNCTION public\.fn_bbj_promo_facts/);
    // union -> promo_wallet, standalone club -> clubs.promo_balance
    expect(sql).toMatch(/uw\.promo_wallet/);
    expect(sql).toMatch(/FROM public\.clubs c\s*\n\s*WHERE c\.id = pool\.club_id/);
  });

  it('the rate is OBSERVED from the rows, never a constant', () => {
    // it has varied by stakes tier and over time; rows from before the triple
    // bank carry NULL portions and must not be counted as zero.
    const sql = read(MIGRATION);
    expect(sql).toMatch(/x\.promo_portion IS NOT NULL/);
    expect(sql).not.toMatch(/0\.25|BBJ_POOL_ALLOCATION/);
  });

  it('it is operator data: names its own actor, and no pre-login role holds it', () => {
    const sql = read(MIGRATION);
    expect(sql).toMatch(/auth\.uid\(\) IS NOT NULL/);
    expect(sql).toMatch(
      /REVOKE ALL ON FUNCTION public\.fn_bbj_promo_facts\(uuid\) FROM PUBLIC, anon;/
    );
    // NULL, never zero, for a caller who may not see it
    expect(sql).toMatch(/CASE WHEN caller\.is_operator THEN ROUND\(purse\.available, 2\) END/);
  });

  it('the page reads the purse and shows no staged residue as a balance', () => {
    const page = code('src/pages/BadBeatJackpotPage.tsx');
    expect(page).toMatch(/supabase\.rpc\('fn_bbj_promo_facts'/);
    expect(page).toContain('purseAvailable');
    // the old card printed bbj_pools.promo_balance as "Promo Pool"
    expect(page).not.toMatch(/<span className="info-label">Promo Pool<\/span>/);
    expect(page).not.toMatch(/max=\{jackpot\?\.promo_balance/);
  });

  it('the operator bar draws only the banks the jackpot actually holds', () => {
    // promo's swept residue used to be a segment, rendering at ~0.007% and
    // telling operators that promo gets nothing. It gets 26.1%.
    const panel = code('src/components/bbj/BBJAdminAnalytics.tsx');
    expect(panel).not.toMatch(/bbj-admin__bar-promo/);
    expect(panel).not.toMatch(/Pool Split - Main/);
    expect(panel).toMatch(/Jackpot Banks - Main/);
    expect(panel).toMatch(/Promo Is Not A Bank Here/);
    // the total that sizes the bar must not include promo any more
    expect(panel).toMatch(
      /const total = Number\(data\.main_balance\) \+ Number\(data\.backup_balance\);/
    );
  });
});
