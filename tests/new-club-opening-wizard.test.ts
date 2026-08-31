import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(__dirname, '..');
const read = (path: string) => readFileSync(resolve(root, path), 'utf8');
const wizard = read('src/components/club/ClubOpeningWizard.tsx');
const wizardCss = read('src/components/club/ClubOpeningWizard.css');
const home = read('src/pages/ClubHomePage.tsx');
const settings = read('src/pages/ClubSettingsPage.tsx');
const openingSql = read('supabase/migrations/20260901073000_club_opening_setup_wizard.sql');
const payoutSql = read(
  'supabase/migrations/20260901074000_leaderboard_promo_first_overlay_waterfall.sql'
);

describe('new club opening wizard', () => {
  it('is a complete full-viewport page with a bottom-anchored action footer', () => {
    expect(wizardCss).toMatch(
      /\.club-setup-wizard\s*\{[\s\S]*position:\s*fixed;[\s\S]*inset:\s*0;/
    );
    expect(wizardCss).toContain('min-height: 100dvh');
    expect(wizardCss).toMatch(/grid-template-rows:\s*auto auto minmax\(0, 1fr\) auto/);
    expect(wizardCss).not.toContain('clip-path');
    expect(wizard).toContain('Step {step + 1} Of {STEPS.length}');
  });

  it('asks every required financial question and uses safe launch defaults', () => {
    for (const copy of [
      'Choose Your Cash-Game Rake',
      'Do You Want A Bad Beat Jackpot?',
      'Do You Want To Offer Spins?',
      'Set Up Your First Promotion',
      'Will Leaderboards Be Display Only Or Pay Prizes?',
    ]) {
      expect(wizard).toContain(copy);
    }
    expect(wizard).toContain('useState(false);\n  const [spinMaxStake');
    expect(wizard).toContain('Math.max(100, requiredSeedForStake(spinMaxStake))');
    expect(wizard).toContain('BBJ Seed Must Be At Least 100 Chips');
    expect(wizard).toContain('Recommended For New Clubs');
    expect(wizard).toContain('[100, 500, 1000]');
  });

  it('keeps a custom tag line separate and never paints the Shark line globally', () => {
    expect(openingSql).toContain('ADD COLUMN IF NOT EXISTS tagline text');
    expect(home).toContain('Boolean(club.tagline?.trim())');
    expect(home).toContain('club.tagline?.trim() || `Welcome To ${club.name}`');
    expect(settings).toContain('value={settings.tagline}');
    expect(home.toLowerCase()).not.toContain('all fish of all shapes and sizes are welcome');
    expect(wizard.toLowerCase()).toContain('that tag line belongs to shark club');
  });

  it('commits opening allocations once and never trusts a browser-side debit', () => {
    expect(openingSql).toContain('SECURITY DEFINER');
    expect(openingSql).toContain('Only The Club Owner Can Complete Opening Setup');
    expect(openingSql).toContain('Club Bank Has % Chips But Setup Requires %');
    expect(openingSql).toContain("'spin_reserve'");
    expect(openingSql).toContain("'bbj_main'");
    expect(openingSql).toContain("'leaderboard_prizes'");
    expect(openingSql).toContain('leaderboard_seed_remaining');
    expect(openingSql).toContain('REVOKE ALL ON FUNCTION public.fn_complete_club_opening_setup');
  });
});

describe('paid leaderboard funding waterfall', () => {
  it('uses the first-round seed, then Promo Funds, then an explicit overlay', () => {
    expect(payoutSql).toContain('v_seed_debit := LEAST(v_total, v_seed_available)');
    expect(payoutSql).toContain(
      'v_promo_debit := LEAST(v_total - v_seed_debit, v_promo_available)'
    );
    expect(payoutSql).toContain('v_overlay := v_total - v_seed_debit - v_promo_debit');
    expect(payoutSql).toContain('chip_treasury = chip_treasury - v_overlay');
    expect(payoutSql).toContain('leaderboard_seed_remaining = 0');
  });

  it('records and credits one atomic, idempotent payout batch', () => {
    expect(payoutSql).toContain('UNIQUE (club_id, period, period_start)');
    expect(payoutSql).toContain('public.fn_credit_and_log(');
    expect(payoutSql).toContain("format('leaderboard:%s:%s:%s:%s'");
    expect(payoutSql).toContain('INSERT INTO public.leaderboard_payout_batches');
    expect(payoutSql).toContain('INSERT INTO public.leaderboard_payouts');
    expect(payoutSql).toContain('Leaderboard Credit Key Already Exists Without A Batch Receipt');
  });

  it('settles only through the server role and has a scheduled boundary sweep', () => {
    expect(payoutSql).toContain('CREATE OR REPLACE FUNCTION public.fn_settle_due_leaderboards()');
    expect(payoutSql).toContain("'leaderboard-payout-waterfall-daily'");
    expect(payoutSql).toContain("'20 0 * * *'");
    expect(payoutSql).toContain('FROM PUBLIC, anon, authenticated');
    expect(payoutSql).toContain('TO service_role');
  });
});
