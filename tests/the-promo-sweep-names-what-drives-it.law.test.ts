/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  THE PROMO SWEEP NAMES WHAT DRIVES IT
 *  BBJ programme, post-audit phase 4 of 5 (2026-09-12)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `fn_sweep_bbj_promo` moves the 25% promo slice out of
 * `bbj_pools.promo_balance` into the union or club promo wallet. It runs every
 * five minutes and moved 24,965.28 chips in the seven days before this law was
 * written.
 *
 * NOTHING IN THIS REPO CALLS IT. No `cron.job` row, no trigger, no TypeScript
 * here or in the World Hub. The driver is a third repo: Open Claw dispatches
 * `/api/cron/bbj-detect` every five minutes and the route lives in the workers
 * repo. (The cron expression is spelled out in words on purpose - written as
 * the literal five-minute glob it closes this block comment, which is how the
 * first draft of this law failed to parse at all.)
 *
 * That produced two failures of the same kind, and this law guards both:
 *
 *   1. AN AUDITOR CONCLUDES IT IS DEAD AND DELETES IT. This audit did conclude
 *      that, from `promo_balance = 0.00` on every pool - the zero is the sweep
 *      working, not the slice being banked inline.
 *
 *   2. AN AUDITOR OBEYS THE COMMENT AND SCHEDULES THE OTHER ONE.
 *      `fn_sweep_bbj_promo_all`'s comment used to end by instructing the next
 *      agent to schedule it. It is not scheduled and its sibling already is,
 *      so a second driver would loop every pool `FOR UPDATE` against the live
 *      one on the same rows.
 *
 * The fix was the comments, because the comments were what was wrong. This law
 * keeps them saying what they say, and keeps the migration honest about the
 * trap it exists to close.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = resolve(__dirname, '..');
const read = (p: string) => readFileSync(resolve(ROOT, p), 'utf8');

/** The migration that re-comments the sweeps, found by content not filename. */
function sweepMigration(): string {
  const dir = resolve(ROOT, 'supabase/migrations');
  const hit = readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .reverse()
    .map((f) => readFileSync(resolve(dir, f), 'utf8'))
    .find((s) => s.includes('COMMENT ON FUNCTION public.fn_sweep_bbj_promo_all()'));
  if (!hit) throw new Error('no migration comments fn_sweep_bbj_promo_all');
  return hit;
}

describe('the promo sweep names what drives it', () => {
  it('the live sweep names its driver, its repo and its cadence', () => {
    const m = sweepMigration();
    expect(m).toContain('COMMENT ON FUNCTION public.fn_sweep_bbj_promo(uuid)');
    // The route, the scheduler and the repo that owns it.
    expect(m).toMatch(/bbj-detect/);
    expect(m).toMatch(/Open Claw/);
    expect(m).toMatch(/workers repo/);
    // And says plainly it is neither dead nor to be given a cron row here.
    expect(m).toMatch(/do not delete this function as dead code/i);
  });

  it('the _all variant refuses to be scheduled', () => {
    const m = sweepMigration();
    expect(m).toContain('DO NOT SCHEDULE THIS');
    expect(m).toMatch(/second driver/i);
  });

  it('the migration asserts no cron row has acquired either sweep', () => {
    /* If one ever does, the two-driver race is live and somebody has to look
       rather than merge past it. The assertion is in the migration so it runs
       against the real cron table, not here against a file. */
    const m = sweepMigration();
    expect(m).toMatch(/FROM cron\.job/);
    expect(m).toMatch(/ILIKE '%fn_sweep_bbj_promo%'/);
  });

  it('the assertion does not quote the sentence it forbids', () => {
    /* The phase 2 corrective pass hit this four times: a migration asserting
       the ABSENCE of a phrase, which quotes the phrase in order to assert it,
       matches its own check. This migration refuses by asserting the presence
       of the refusal instead, and says so. */
    const m = sweepMigration();
    const assertionBlock = m.slice(m.indexOf('DO $$'));
    expect(assertionBlock).not.toMatch(/position\('Schedule this'/);
  });

  it('this repo still has no cron row and no caller for the sweep', () => {
    /* The premise of every comment above. If a caller appears in this repo,
       the comments are now wrong and somebody must reconcile the two drivers
       before this law is weakened to let it pass. Migrations are excluded:
       they are where the function is DEFINED and commented. */
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const e of readdirSync(resolve(ROOT, dir), { withFileTypes: true })) {
        const rel = `${dir}/${e.name}`;
        if (e.isDirectory()) {
          if (['node_modules', 'dist', '.git', 'migrations'].includes(e.name)) continue;
          walk(rel);
        } else if (/\.(ts|tsx|js|mjs|cjs)$/.test(e.name)) {
          const src = readFileSync(resolve(ROOT, rel), 'utf8');
          // A CALL, not a mention in a comment.
          if (/rpc\(\s*['"]fn_sweep_bbj_promo/.test(src)) offenders.push(rel);
        }
      }
    };
    for (const top of ['src', 'server/src', 'scripts']) walk(top);
    expect(offenders).toEqual([]);
  });

  it('the band-aid register carries the row, and calls it what it is', () => {
    const reg = read('docs/BAND-AIDS-REGISTER.md');
    expect(reg).toMatch(/BBJ promo sweep/i);
    /* It is listed WITHOUT being a band-aid, and the register has to say so -
       an entry that reads as debt invites somebody to "close" it by deleting
       a live money path. */
    expect(reg).toMatch(/NOT-A-BAND-AID/);
    expect(reg).toMatch(/fn_bbj_promo_bank_check/);
  });
});
