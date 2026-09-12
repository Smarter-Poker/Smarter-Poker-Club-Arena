/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  THE PROMO SWEEP NAMES WHAT DRIVES IT
 *  BBJ programme, post-audit phase 4 of 5 (2026-09-12)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `fn_sweep_bbj_promo_all()` moves the 25% promo slice out of
 * `bbj_pools.promo_balance` into the union or club promo wallet. It runs every
 * five minutes and moved 24,965.28 chips in the seven days before this law was
 * written.
 *
 * NOTHING IN THIS REPO CALLS IT. No `cron.job` row, no trigger, no TypeScript
 * here or in the World Hub. The driver is a third repo: Open Claw dispatches
 * `/api/cron/bbj-detect` every five minutes, and
 * `smarter-poker-workers/src/routes/bbj-detect.ts` step 6 calls it. (The cron
 * expression is spelled out in words on purpose - written as the literal
 * five-minute glob it closes this block comment, which is how the first draft
 * of this law failed to parse at all.)
 *
 * That produced three failures of the same kind, and this law guards all three:
 *
 *   1. AN AUDITOR CONCLUDES IT IS DEAD AND DELETES IT. This audit did conclude
 *      that, from `promo_balance = 0.00` on every pool - the zero is the sweep
 *      working, not the slice being banked inline.
 *
 *   2. AN AUDITOR OBEYS THE COMMENT AND SCHEDULES IT AGAIN.
 *      `fn_sweep_bbj_promo_all`'s original comment ended by instructing the
 *      next agent to schedule it, when it is ALREADY driven - so obeying it
 *      adds a second driver looping every pool `FOR UPDATE` against the live
 *      run five minutes later.
 *
 *   3. AN AUDITOR NAMES THE WRONG SIBLING - which is what I did. The first
 *      version of this law, and the migration under it, said the per-club
 *      `fn_sweep_bbj_promo(uuid)` was the five-minute driver and that `_all`
 *      must never be scheduled. Exactly backwards, and it left "DO NOT
 *      SCHEDULE THIS" sitting on the one function the promo slice depends on
 *      being scheduled. The role was assigned by inference from
 *      `union_wallet_transactions` timestamps instead of read from the route,
 *      while the workers checkout sat on the same machine. Corrected by
 *      migration `20260912005352`; the last test below now reads that route
 *      rather than trusting any comment, including this one.
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
  /* THE DRIVER IS `fn_sweep_bbj_promo_all()`, NOT the per-club variant.
     This law's first version pinned it the other way round, because the
     migration it was written against had it the other way round: the sweep
     was measured running every five minutes, only two functions can write
     that tx_type, and the role was assigned to the per-club one by inference
     rather than read. `smarter-poker-workers/src/routes/bbj-detect.ts` step 6
     calls `fn_sweep_bbj_promo_all` and nothing in that repo calls the other.
     Corrected 2026-09-12 by migration `20260912005352`. */

  it('the LIVE DRIVER is the _all variant, and it names its route and cadence', () => {
    const m = sweepMigration();
    expect(m).toContain('COMMENT ON FUNCTION public.fn_sweep_bbj_promo_all()');
    const allComment = m.slice(m.indexOf('COMMENT ON FUNCTION public.fn_sweep_bbj_promo_all()'));
    expect(allComment).toMatch(/THIS IS THE LIVE DRIVER/);
    expect(allComment).toMatch(/bbj-detect/);
    expect(allComment).toMatch(/five minutes/i);
    // Never deleted as dead code, and never given a second driver.
    expect(allComment).toMatch(/DO NOT DELETE IT/);
    expect(allComment).toMatch(/DO NOT ADD A SECOND DRIVER/);
  });

  it('the per-club variant does not claim to be the driver', () => {
    const m = sweepMigration();
    const single = m.slice(m.indexOf('COMMENT ON FUNCTION public.fn_sweep_bbj_promo(uuid)'));
    expect(single).toMatch(/NOT SCHEDULED/);
    expect(single).toMatch(/mint_club_promo/);
  });

  it('the function that IS scheduled is never told not to be', () => {
    /* The exact inversion this law exists to prevent: a capitalised
       instruction not to schedule the one function the platform's promo slice
       depends on being scheduled. An agent obeying it removes the only driver
       promo has. */
    const m = sweepMigration();
    const allComment = m.slice(m.indexOf('COMMENT ON FUNCTION public.fn_sweep_bbj_promo_all()'));
    const end = allComment.indexOf('COMMENT ON FUNCTION public.fn_sweep_bbj_promo(uuid)');
    expect(end > -1 ? allComment.slice(0, end) : allComment).not.toMatch(/DO NOT SCHEDULE/);
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
       matches its own check. */
    const m = sweepMigration();
    const assertionBlock = m.slice(m.indexOf('DO $$'));
    expect(assertionBlock).not.toMatch(/position\('Schedule this'/);
  });

  it('the workers repo is where the driver lives, and it is readable from here', () => {
    /* The claim in every comment above depends on this file. It was asserted
       for ninety minutes without being opened - I told Dan the repo "isn't
       mounted in this session" while it sat at ~/Documents/smarter-poker-workers,
       and the inverted comment is what that cost. If the checkout is absent
       this test SKIPS rather than fails: its absence on some other machine is
       not evidence about production. What it must never do is pass while the
       file says something different. */
    const route = resolve(
      process.env.HOME || '',
      'Documents/smarter-poker-workers/src/routes/bbj-detect.ts'
    );
    let src: string;
    try {
      src = readFileSync(route, 'utf8');
    } catch {
      return; // not checked out here; the migration's own assertions still ran
    }
    expect(src).toMatch(/rpc\(\s*['"]fn_sweep_bbj_promo_all['"]\s*\)/);
    // And it does NOT call the per-club one, which is the whole correction.
    expect(src).not.toMatch(/rpc\(\s*['"]fn_sweep_bbj_promo['"]/);
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
