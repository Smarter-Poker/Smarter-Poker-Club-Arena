/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  REWARDS ARE DIAMONDS, AND THE SCHEMA HAS NO YELLOW
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Two rulings from Dan on 2026-09-05, both verbatim:
 *
 *   "NOTHING EVER 'EARNS CHIPS' ONLY EVER DIAMONDS. MAKE SURE THATS THE CASE
 *    GLOBALLY!"
 *
 *   "YELLOW ISN'T A SMARTER.POKER ALLOWED COLOR SCHEMA."
 *
 * WHAT WAS WRONG
 *
 * The Referral panel on the profile said "Invite Friends And Earn Chips
 * Together!", counted "Chips Earned", and listed four milestones as
 * "2,500 / 5,000 / 15,000 / 50,000 Chips". It was not merely bad copy - both
 * referral RPCs really did pay chips, through `atomic_credit_wallet_and_log`,
 * which settles into `club_members.chip_balance`.
 *
 * Safe to correct because nothing had ever been paid: measured 2026-09-05,
 * `referral_redemptions` and `referral_milestone_claims` both held ZERO rows.
 * Migrations 20260905103510 and 20260905103839 moved both paths to
 * `add_diamonds_to_balance`.
 *
 * THE DISTINCTION THIS LAW DRAWS
 *
 * A REWARD is paid in diamonds. Chips are still chips where chips are the
 * subject: a pot won at the table, a tournament stack, an early-registration
 * stack bonus, a challenge OBJECTIVE ("Win 2,500 Chips In Pots Today" is a
 * thing you do, not a thing you are given). This law guards the reward
 * surfaces, not the felt.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = resolve(__dirname, '..');
const read = (p: string) => readFileSync(resolve(ROOT, p), 'utf8');
/** Headers quote the old copy to explain it; assertions read code, not prose. */
const strip = (s: string) =>
  s
    .replace(/\{\s*\/\*[\s\S]*?\*\/\s*\}/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');

const REFERRAL_PANEL = strip(read('src/components/social/ReferralDashboard.tsx'));
const REFERRAL_SERVICE = strip(read('src/services/ReferralService.ts'));

/* Each migration header QUOTES the chip call it replaced, so the SQL is read
   with its `--` comments removed - the assertion is about what the function
   does, not about how the file explains itself. */
const sql = (p: string) =>
  read(p)
    .split('\n')
    .filter((line) => !line.trim().startsWith('--'))
    .join('\n');

const MILESTONE_SQL = sql(
  'supabase/migrations/20260905103510_referral_milestones_pay_diamonds_not_chips.sql'
);
const SIGNUP_SQL = sql(
  'supabase/migrations/20260905103839_referral_signup_bonus_pays_diamonds_not_chips.sql'
);

describe('a referral reward is paid in diamonds', () => {
  it('says diamonds on the panel, and says chips nowhere', () => {
    expect(REFERRAL_PANEL).toContain('Diamonds Earned');
    expect(REFERRAL_PANEL).toContain('Earn Diamonds Together');
    expect(REFERRAL_PANEL).toContain('Diamonds</span>');
    expect(REFERRAL_PANEL.toLowerCase()).not.toContain('chips');
  });

  it('counts and promises diamonds in the service', () => {
    expect(REFERRAL_SERVICE).toContain('totalDiamondsEarned');
    expect(REFERRAL_SERVICE).not.toContain('totalChipsEarned');
    expect(REFERRAL_SERVICE).toContain('diamonds_awarded_referrer');
  });

  it('promises exactly what the server pays', () => {
    /* A panel that promises more than the RPC credits is the defect this
       sweep exists to remove, so the four numbers are asserted against the
       migration that pays them rather than merely being present. */
    for (const amount of ['250', '500', '1500', '5000']) {
      expect(REFERRAL_SERVICE, `milestone ${amount} missing from the panel`).toContain(
        `reward: ${amount}`
      );
      expect(MILESTONE_SQL, `milestone ${amount} missing from the RPC`).toContain(amount);
    }
  });

  it('credits the diamond balance and never the chip wallet', () => {
    for (const sql of [MILESTONE_SQL, SIGNUP_SQL]) {
      expect(sql).toContain('add_diamonds_to_balance');
      expect(sql).not.toContain('atomic_credit_wallet_and_log');
    }
    // Idempotent, and a refused credit must not leave a claimed-but-unpaid row.
    expect(MILESTONE_SQL).toContain('RAISE EXCEPTION');
    expect(SIGNUP_SQL).toContain('RAISE EXCEPTION');
  });
});

describe('the account surfaces carry no yellow', () => {
  /* The exact amber/gold/emerald literals that were on these three panels.
     #d6ad52 (brass) is the sanctioned warm accent and is NOT in this list. */
  const BANNED = [
    '#fbbf24',
    '#f59e0b',
    '#ffd700',
    '#eab308',
    '#facc15',
    '#fcd34d',
    '#10b981',
    '#059669',
    '#22c55e',
    'rgba(255, 215, 0',
    'rgba(251, 191, 36',
    'rgba(16, 185, 129',
  ];

  const SHEETS = [
    'src/components/social/FriendListPanel.module.css',
    'src/components/social/ReferralDashboard.css',
    'src/components/social/PlayerActivityFeed.css',
  ];

  it.each(SHEETS)('%s uses the palette', (sheet) => {
    // Comments explain what was removed and name the old colours.
    const css = read(sheet).replace(/\/\*[\s\S]*?\*\//g, '');
    for (const colour of BANNED) {
      expect(css.toLowerCase(), `${colour} is back in ${sheet}`).not.toContain(
        colour.toLowerCase()
      );
    }
  });

  it.each(SHEETS)('%s ships a light mode rather than one fixed dark look', (sheet) => {
    expect(read(sheet)).toContain("[data-theme='light']");
  });
});
