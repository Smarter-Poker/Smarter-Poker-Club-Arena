/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  A REWARD IS PAID IN DIAMONDS
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Dan, 2026-09-05, verbatim: "NOTHING EVER 'EARNS CHIPS' ONLY EVER DIAMONDS.
 * MAKE SURE THATS THE CASE GLOBALLY!"
 *
 * DAILY MISSIONS WAS THE LARGEST VIOLATION, AND IT WAS NOT COSMETIC
 *
 * Three RPCs credited chips through `atomic_credit_wallet_and_log`, which
 * settles into `club_members.chip_balance`:
 *
 *     claim_daily_challenge              one mission
 *     claim_daily_challenges             the "claim all" batch
 *     fn_award_daily_mission_milestones  the streak circuits
 *
 * Measured on production before the fix:
 *
 *     user_daily_challenges chip snapshots      695,783,800
 *     ...completed and awaiting a claim         425,819,000
 *     every chip in every member wallet            ~121,000,000
 *     rows ever claimed                                     0
 *     claim batches ever run                                0
 *     streak circuits ever claimed                          0
 *
 * Nobody had ever pressed the button in five and a half months, and the button
 * paid several times the platform's entire chip supply. Migration
 * 20260905114421 removed the crediting, zeroed the catalog, and denominated the
 * five streak circuits in diamonds. Every mission keeps the diamond reward it
 * already carried.
 *
 * WHAT THIS LAW DOES NOT SAY
 *
 * Chips are still chips where chips are the SUBJECT rather than the reward: a
 * pot won at the table, a tournament stack, a reroll's COST, and a challenge
 * OBJECTIVE ("Win 2,500 Chips In Pots Today" is a thing you do, not a thing you
 * are given). This law guards the crediting, not the felt.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  CHALLENGE_POOL,
  WEEKLY_CHALLENGE_POOL,
  MONTHLY_CHALLENGE_POOL,
} from '../src/services/DailyChallengeService';

const ROOT = resolve(__dirname, '..');
const read = (p: string) => readFileSync(resolve(ROOT, p), 'utf8');

/**
 * The header AND the function bodies quote the call that was removed, in order
 * to say where it stood - so both comment styles come off before anything is
 * asserted. What is left is what the database will execute.
 */
const sql = (p: string) =>
  read(p)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((line) => !line.trim().startsWith('--'))
    .join('\n');

/** Same for TSX/TS: comments name the old behaviour on purpose. */
const strip = (s: string) =>
  s
    .replace(/\{\s*\/\*[\s\S]*?\*\/\s*\}/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');

const MIGRATION = sql('supabase/migrations/20260905114421_a_mission_pays_diamonds_not_chips.sql');
const SERVICE = strip(read('src/services/DailyChallengeService.ts'));
const PAGE = strip(read('src/pages/DailyChallengesPage.tsx'));

const ALL = [...CHALLENGE_POOL, ...WEEKLY_CHALLENGE_POOL, ...MONTHLY_CHALLENGE_POOL];

describe('no mission RPC credits a chip', () => {
  it('all four rewritten functions are free of the chip credit', () => {
    /* One assertion over the whole migration body: whatever else it does, the
       call that moved chips into a member wallet is not in it. The three claim
       paths and the dashboard are rewritten in this one file. */
    expect(MIGRATION).not.toContain('atomic_credit_wallet_and_log');
    for (const fn of [
      'public.claim_daily_challenge(',
      'public.claim_daily_challenges(',
      'public.fn_award_daily_mission_milestones(',
      'public.get_daily_challenge_dashboard(',
    ]) {
      expect(MIGRATION, `${fn} is not rewritten by this migration`).toContain(fn);
    }
  });

  it('the streak circuits are diamonds, paid through the audited path', () => {
    expect(MIGRATION).toContain('RENAME COLUMN reward_chips TO reward_diamonds');
    expect(MIGRATION).toContain('add_diamonds_to_balance');
    // A claimed circuit that paid nothing would be worse than an unclaimed one.
    expect(MIGRATION).toContain('RAISE EXCEPTION');
  });

  it('the catalog stops promising chips', () => {
    expect(MIGRATION).toContain('UPDATE public.daily_challenge_catalog SET chip_reward = 0');
  });

  it('leaves every assigned player contract exactly as it was issued', () => {
    /* The first draft of that migration zeroed chip_reward_snapshot on 32,793
       rows and fn_snapshot_daily_challenge_contract refused it - correctly. A
       contract already handed to a player is immutable, and the liability is
       closed by removing the PAYING, not by rewriting what a player holds.
       CLAUDE.md 10.9 rule 3 says the same in words. */
    expect(MIGRATION).not.toContain('chip_reward_snapshot = 0');
    expect(MIGRATION).not.toMatch(/SET[\s\S]{0,120}chip_reward_snapshot\s*=/i);
  });
});

describe('nothing on the missions surface offers a chip reward', () => {
  it('no challenge in any pool carries one', () => {
    expect(ALL.length).toBeGreaterThan(50);
    for (const c of ALL) {
      expect(c, `"${c.id}" still carries a chip reward`).not.toHaveProperty('chipReward');
      expect(c.diamondReward, `"${c.id}" pays nothing`).toBeGreaterThan(0);
    }
  });

  it('the service maps no chip field off the RPC receipts', () => {
    expect(SERVICE).not.toContain('chipReward');
    expect(SERVICE).not.toContain('totalChipsEarned');
    expect(SERVICE).not.toContain('chip_reward');
  });

  it('the page never renders a chip amount', () => {
    expect(PAGE).not.toContain('chipReward');
    expect(PAGE).not.toContain('reward.chips');
    expect(PAGE).not.toContain('unclaimed.chips');
    // Objectives are allowed to be about chips; payouts are not.
    expect(PAGE).not.toMatch(/Bonus Chips|Chips<\/span>|\} Chips</);
  });
});
