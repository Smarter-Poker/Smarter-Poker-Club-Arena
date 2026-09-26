import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { sliceSqlStatement } from './helpers/sourceWindow';

const root = resolve(__dirname, '..');
const read = (path: string) => readFileSync(resolve(root, path), 'utf8');
const migrationsDir = resolve(root, 'supabase/migrations');
const newestFirst = readdirSync(migrationsDir)
  .filter((name) => name.endsWith('.sql'))
  .sort()
  .reverse();

/**
 * The live rule is the NEWEST migration that says it, the way the mint law
 * test picks its file: migrations apply in version order, so an older file is
 * history. A pin against a fixed old file keeps passing after the rule it
 * describes has been replaced, which is how this suite came to pin an overlay
 * waterfall that 20260906084547 had already removed.
 */
function newestMigrationMatching(pattern: RegExp): { file: string; sql: string } {
  for (const file of newestFirst) {
    const sql = readFileSync(resolve(migrationsDir, file), 'utf8');
    if (pattern.test(sql)) return { file, sql };
  }
  throw new Error(`No migration matches ${pattern}`);
}
const definesFunction = (fn: string) =>
  new RegExp(`CREATE\\s+(?:OR\\s+REPLACE\\s+)?FUNCTION\\s+public\\.${fn}\\(`);
/** Just that function's statement, from its newest definition. */
function liveFunction(fn: string): string {
  const { file, sql } = newestMigrationMatching(definesFunction(fn));
  const start = sql.search(definesFunction(fn));
  expect(start, `${fn} in ${file} has no live definition`).toBeGreaterThanOrEqual(0);
  return sliceSqlStatement(
    sql,
    sql.slice(start).match(/^CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+public\.[^(]+\(/i)?.[0] ??
      `FUNCTION public.${fn}(`
  );
}

const wizard = read('src/components/club/ClubOpeningWizard.tsx');
const wizardCss = read('src/components/club/ClubOpeningWizard.css');
const home = read('src/pages/ClubHomePage.tsx');
const settings = read('src/pages/ClubSettingsPage.tsx');
const memberManagement = read('src/pages/MemberManagementPage.tsx');
const openingSql = newestMigrationMatching(definesFunction('fn_complete_club_opening_setup')).sql;
const taglineSql = read('supabase/migrations/20260901072500_club_tagline_is_its_own_field.sql');
const payoutSql = liveFunction('fn_payout_leaderboard');
const payoutFile = newestMigrationMatching(definesFunction('fn_payout_leaderboard')).sql;
const sweepSql = liveFunction('fn_settle_due_leaderboards');
const batchTableSql = newestMigrationMatching(
  /CREATE TABLE IF NOT EXISTS public\.leaderboard_payout_batches/
).sql;
const sweepScheduleSql = newestMigrationMatching(/'leaderboard-payout-waterfall-daily'/).sql;

describe('new club opening wizard', () => {
  it('is a complete full-viewport page with a bottom-anchored action footer', () => {
    expect(wizardCss).toMatch(
      /\.club-setup-wizard\s*\{[\s\S]*position:\s*fixed;[\s\S]*inset:\s*0;/
    );
    expect(wizardCss).toContain('min-height: 100dvh');
    expect(wizardCss).toMatch(/grid-template-rows:\s*auto minmax\(0, 1fr\) auto/);
    expect(wizardCss).not.toContain('clip-path');
    expect(wizard).toContain('pill={`Step ${step + 1} Of ${STEPS.length}`}');
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
    expect(taglineSql).toContain('ADD COLUMN IF NOT EXISTS tagline text');
    expect(home).toContain('Boolean(club.tagline?.trim())');
    /* What this spec protects: a club that wrote a tag line and no day's
       message still sees its own line.
       
       It used to be protected by the SECOND LINK of a fallback chain
       (`lobby_message -> tagline -> "Welcome To <Club>"`) inside the lobby
       message strip. On 2026-09-03 that strip was removed from the layout and
       the day's message became a full-screen greeting on entry, which does NOT
       fall back to the tag line - a popup that says "Welcome To Club Jaqk"
       interrupts a player to tell them nothing.
       
       So the tag line needed its own home rather than a borrowed one, and it
       has the welcome block: this is the club's permanent identity, it does not
       change from one day to the next, and it is the one thing on that block
       safe to bake in. Pinned at the element now, not at a fallback. */
    expect(home).toContain('club-lobby-command-top__tagline');
    expect(home).toContain('{club.tagline?.trim() && (');
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

  it('ends the launch checklist with a fully configured first agent', () => {
    expect(home).toContain("id: 'first-agent'");
    expect(home).toContain("label: 'Configure Your First Agent'");
    expect(home).toContain('Promote A Player, Choose Prepaid Or Credit, And Assign Rakeback');
    expect(home).toContain('agent.is_prepaid === true && Number(agent.credit_limit || 0) === 0');
    expect(home).toContain('agent.is_prepaid === false && Number(agent.credit_limit || 0) > 0');
    expect(home).toContain('agent.player_rakeback_rate != null');
    expect(home).toContain('navigate(`/clubs/${clubId}/members`)');
  });

  it('keeps the checklist visible until every launch task is complete', () => {
    expect(home).toContain('openingChecklistEligible &&');
    expect(home).toContain('launchTasks.some((task) => !task.complete && !task.skipped)');
    expect(home).toContain('{showLaunchChecklist && (');
    expect(home).not.toContain('noticeEditable && totalGameCount === 0');
  });

  it('derives the lobby level from live members and cannot celebrate a hierarchy level', () => {
    expect(home).toContain('getClubLevelInfoFromMembers(clubData.member_count || 0)');
    expect(home).not.toContain("rpc('recompute_club_levels'");
  });

  it('keeps agent terms separate from the owner’s manual chip transfer', () => {
    expect(memberManagement).toContain('A credit LIMIT is');
    expect(memberManagement).toContain('never an automatic transfer');
    expect(memberManagement).toContain('Fund Them Now?');
    expect(memberManagement).toContain('Send Chips');
    expect(memberManagement).toContain('Not Now');
  });
});

describe('paid leaderboard funding waterfall', () => {
  it('uses the first-round seed, then Promo Funds, then an explicit overlay the owner allowed', () => {
    expect(payoutSql).toContain('v_seed_debit := LEAST(v_total, v_seed_available)');
    expect(payoutSql).toContain('v_promo_debit := v_total - v_seed_debit - v_overlay;');
    expect(payoutSql).toContain('v_overlay := v_total - v_seed_available - v_promo_available;');
    expect(payoutSql).toContain('chip_treasury = chip_treasury - v_overlay');
    expect(payoutSql).toContain('leaderboard_seed_remaining = 0');
    // The overlay is never silent: without the owner's per-program opt-in the
    // round is refused as underfunded and retried, and a union is never debited.
    expect(payoutSql).toContain('SELECT program.overlay_enabled');
    expect(payoutSql).toMatch(
      /IF NOT v_overlay_enabled THEN\s*RAISE EXCEPTION\s*'LEADERBOARD_PROMO_UNDERFUNDED\|/
    );
    expect(payoutSql).toContain("AND program.funding_owner_type = 'club';");
    expect(payoutSql).toContain("set_config('app.ledger_category', 'overlay', true)");
  });

  it('records and credits one atomic, idempotent payout batch', () => {
    expect(batchTableSql).toContain('UNIQUE (club_id, period, period_start)');
    expect(payoutSql).toContain('public.fn_credit_and_log(');
    expect(payoutSql).toContain("format('leaderboard:%s:%s:%s:%s'");
    expect(payoutSql).toContain('INSERT INTO public.leaderboard_payout_batches');
    expect(payoutSql).toContain('INSERT INTO public.leaderboard_payouts');
    expect(payoutSql).toContain('Leaderboard Credit Key Already Exists Without A Batch Receipt');
    expect(payoutSql).toContain("'overlay_funded', v_overlay,");
  });

  it('settles only through the server role and has a scheduled boundary sweep', () => {
    expect(sweepSql).toContain('CREATE OR REPLACE FUNCTION public.fn_settle_due_leaderboards()');
    expect(sweepScheduleSql).toContain("'leaderboard-payout-waterfall-daily'");
    expect(sweepScheduleSql).toContain("'20 0 * * *'");
    expect(payoutFile).toMatch(
      /REVOKE ALL ON FUNCTION public\.fn_payout_leaderboard\(uuid, text, text, timestamptz, timestamptz\)\s*FROM PUBLIC, anon, authenticated;/
    );
    expect(payoutFile).toMatch(
      /GRANT EXECUTE ON FUNCTION public\.fn_payout_leaderboard\(uuid, text, text, timestamptz, timestamptz\)\s*TO service_role;/
    );
  });
});
