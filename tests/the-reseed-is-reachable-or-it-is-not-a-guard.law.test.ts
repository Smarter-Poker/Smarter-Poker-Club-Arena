/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  THE BACKUP RESEED: REACHABLE, OR HONESTLY LABELLED
 *  BBJ programme phase 4 of 5 (2026-09-11)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Dan, 2026-08-18, quoted in migration 20260827e: "the back-up jackpot exists
 * so that when a hit takes 100% of main, the jackpot does not restart at
 * zero. If main is now empty, TRANSFER the reserve into it."
 *
 * `fn_bbj_reseed_main_from_backup` implements that correctly - it locks the
 * pool, respects parked shares, raises a drift incident when the reserve is
 * empty, and moves the banks through the conserving `fn_bbj_move_between_banks`.
 * `bbj_atomic_payout_v2` calls it behind `IF v_main <= v_reserved`, i.e. only
 * once a payout has taken every spendable chip of main.
 *
 * IT CANNOT GET THERE. The payout is a PERCENTAGE of spendable main, and the
 * highest percentage any stakes tier pays is 85:
 *
 *     nano 15 | micro 25 | small 40 | mid 55 | high 70 | nosebleeds 85
 *
 * so what is left is `(1 - pct/100) x spendable`, which is positive for every
 * tier. Rounding closes the gap only when spendable main is already down to a
 * few hundredths of a chip. Production agrees: across 34 real main hits the
 * largest share ever taken was 70%, the smallest pool at hit was 2,665.17, and
 * ZERO hits took everything.
 *
 * So the premise - a 100% hit - is one the payout schedule cannot produce, and
 * the guarantee Dan asked for ("does not restart at zero") is already
 * delivered by that schedule rather than by the reseed. The reseed is not
 * broken and must not be deleted: `bbj_atomic_payout_v2` accepts any percent
 * in (0, 100], so the day a tier is set to 100 it becomes live and correct.
 *
 * This law exists so nobody reads it as ACTIVE protection it is not currently
 * providing, and so the two facts stay tied together: if a tier ever pays
 * 100%, the reseed is reachable and this test says so out loud.
 *
 * Whether a 100% tier SHOULD exist is Dan's - it sets what players are owed in
 * future events (CLAUDE.md 10.9). This law does not decide it; it refuses to
 * let the answer drift silently.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = resolve(__dirname, '..');
const read = (p: string) => readFileSync(resolve(ROOT, p), 'utf8');

/** Every tier's bbjPayoutTotalPercent, read from the spec the engine uses. */
function payoutPercents(): Record<string, number> {
  const src = read('server/src/config/rakeSpec.ts');
  const out: Record<string, number> = {};
  const re = /^ {2}([a-z_0-9]+): \{$/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) {
    const entry = src.slice(m.index, src.indexOf('\n  },', m.index));
    const pct = entry.match(/bbjPayoutTotalPercent:\s*(\d+(?:\.\d+)?)/);
    if (pct) out[m[1]] = Number(pct[1]);
  }
  return out;
}

describe('the backup reseed and the payout schedule agree about whether it can fire', () => {
  const percents = payoutPercents();

  it('reads a real schedule', () => {
    expect(Object.keys(percents).length).toBeGreaterThanOrEqual(6);
    for (const [tier, pct] of Object.entries(percents)) {
      expect(pct, `${tier} percent`).toBeGreaterThan(0);
      expect(pct, `${tier} percent`).toBeLessThanOrEqual(100);
    }
  });

  it('NO tier pays 100%, so a hit cannot empty main and the reseed cannot fire', () => {
    /* If this test fails because a tier now pays 100, that is not a bug - it
       means the reseed has become LIVE. Move this expectation to its partner
       below in the same commit and say so in the pull request. */
    const hundreds = Object.entries(percents).filter(([, p]) => p >= 100);
    expect(hundreds, `tiers paying 100%: ${JSON.stringify(hundreds)}`).toEqual([]);
    expect(Math.max(...Object.values(percents))).toBeLessThan(100);
  });

  it('what a hit leaves behind is positive at every tier, by arithmetic', () => {
    // spendable main = 1 (normalised); remaining = 1 - pct/100
    for (const [tier, pct] of Object.entries(percents)) {
      const remaining = 1 - pct / 100;
      expect(remaining, `${tier} leaves nothing behind`).toBeGreaterThan(0);
    }
  });

  it('the reseed is still WIRED, so a future 100% tier works without new code', () => {
    /* Deleting it would be the wrong fix: the payout RPC validates the percent
       as (0, 100], so 100 is a configuration the platform already accepts. */
    const mig = read('supabase/migrations/20260827e_bbj_payouts_link_to_their_hand.sql');
    expect(mig).toContain('fn_bbj_reseed_main_from_backup');
    expect(mig).toMatch(/RESEED \(Dan 2026-08-18\)/);
  });

  it('the guarantee Dan asked for is delivered by the SCHEDULE, and that is written down', () => {
    // The changelog has to carry the reasoning, or the next agent re-derives it.
    const log = read('docs/changelog/2026-09-11-phase-4-the-reseed-and-the-rule.md');
    expect(log).toMatch(/85/);
    expect(log).toMatch(/cannot fire|can never fire|unreachable/i);
    expect(log).toMatch(/34/); // the production hit count this was measured against
  });
});
