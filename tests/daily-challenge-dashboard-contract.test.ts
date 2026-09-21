import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  readDailyChallengesSurface,
  readDailyChallengesUnit,
} from './helpers/dailyChallengesSources';

const migration = readFileSync(
  resolve(
    __dirname,
    '../supabase/migrations/20260830235963_daily_challenge_dashboard_contract.sql'
  ),
  'utf8'
);
const service = readFileSync(
  resolve(__dirname, '../src/services/DailyChallengeService.ts'),
  'utf8'
);
const page = readFileSync(resolve(__dirname, '../src/pages/DailyChallengesPage.tsx'), 'utf8');
const actions = readDailyChallengesUnit('useDailyMissionActions.ts');
const dashboard = readDailyChallengesUnit('useDailyMissionDashboard.ts');
const surface = readDailyChallengesSurface();
const titleCaseMigration = readFileSync(
  resolve(__dirname, '../supabase/migrations/20260901030700_daily_mission_catalog_title_case.sql'),
  'utf8'
);
const revisionReceiptMigration = readFileSync(
  resolve(__dirname, '../supabase/migrations/20260901030800_daily_mission_revision_receipt.sql'),
  'utf8'
);
const certificationRepairMigration = readFileSync(
  resolve(
    __dirname,
    '../supabase/migrations/20260906093500_daily_mission_certification_repairs.sql'
  ),
  'utf8'
);

describe('daily challenge dashboard contract', () => {
  it('snapshots the full assigned mission contract and makes it immutable', () => {
    for (const column of [
      'challenge_name_snapshot',
      'challenge_description_snapshot',
      'challenge_type_snapshot',
      'tier_snapshot',
      'requirement_snapshot',
      'chip_reward_snapshot',
      'diamond_reward_snapshot',
    ]) {
      expect(migration).toContain(column);
    }
    expect(migration).toContain('Assigned daily challenge contracts are immutable');
    expect(migration).toContain('trg_snapshot_daily_challenge_contract_insert');
    expect(migration).toContain('trg_snapshot_daily_challenge_contract_update');
  });

  it('pays and totals the immutable assignment snapshot instead of the mutable catalog', () => {
    expect(migration).toContain('v_row.chip_reward_snapshot');
    expect(migration).toContain('v_row.diamond_reward_snapshot');
    expect(migration).toContain('v_row.requirement_snapshot');
    expect(migration).toContain('COALESCE(sum(chip_reward_snapshot) FILTER (WHERE claimed), 0)');
    expect(migration).not.toContain('LIMIT QUERY_LIMITS');
  });

  it('keeps every completed unclaimed period in the persistent reward vault', () => {
    expect(migration).toContain('idx_user_daily_challenges_reward_vault');
    expect(migration).toContain('AND completed = true');
    expect(migration).toContain('AND claimed = false');
    expect(migration).toContain("'hasMore', v_vault_count > VAULT_PAGE_SIZE");
    const vaultBody = migration.slice(
      migration.indexOf('SELECT count(*),'),
      migration.indexOf('SELECT COALESCE(diamonds, 0)')
    );
    expect(vaultBody).not.toContain('assigned_date IN');
  });

  it('locks streak inventory and supports milestones beyond day 100', () => {
    expect(migration).toContain('FOR UPDATE;');
    expect(migration).toContain('v_entitlements := v_streak / EARN_EVERY');
    expect(migration).toContain('POST_CENTURY_INTERVAL constant integer := 30');
    expect(migration).toContain('v_next_milestone := v_previous_milestone + POST_CENTURY_INTERVAL');
    expect(migration).not.toContain('assigned_date::date >= v_today - 400');
  });

  it('exposes only the authenticated dashboard RPC', () => {
    expect(migration).toContain('CREATE OR REPLACE FUNCTION public.get_daily_challenge_dashboard');
    expect(migration).toContain(
      'REVOKE ALL ON FUNCTION public.get_daily_challenge_dashboard(text, text[], text, text[], text, text[])'
    );
    expect(migration).toContain('FROM PUBLIC, anon;');
    expect(migration).toContain('TO authenticated, service_role;');
  });

  it('wires the page to one dashboard receipt and the persistent vault', () => {
    expect(service).toContain("supabase.rpc('get_daily_challenge_dashboard_v3'");
    expect(service).toContain('retryFetch(');
    expect(service).toContain('{ maxRetries: 2, baseDelayMs: 250 }');
    expect(dashboard).toContain('dailyChallengeService.getDashboard(uid)');
    expect(surface).not.toContain('dailyChallengeService.getAllChallenges(uid)');
    expect(surface).not.toContain('dailyChallengeService.getStats(uid)');
    expect(surface).not.toContain('dailyChallengeService.getStreak(uid)');
    expect(surface).not.toContain('dailyChallengeService.getDiamondBalance(uid)');
    expect(actions).toContain(
      'const dashboard = await dailyChallengeService.getDashboard(userId);'
    );
    expect(actions).toContain('ready = dashboard.vault.items;');
    expect(actions).toContain(
      'if (!userId || claimAllGuardRef.current || economyGuardRef.current) return;'
    );
    expect(actions).toContain('claimAllGuardRef.current = true;');
    expect(actions).toContain('claimAllGuardRef.current = false;');
    expect(surface).not.toContain('const ready = rewardVault.items;');
    expect(page).toContain('width: `${stats?.milestoneProgressPercent ?? 0}%`');
  });

  it('returns a coherent dashboard revision for dropped-event reconciliation', () => {
    expect(revisionReceiptMigration).toContain(
      'CREATE OR REPLACE FUNCTION public.get_daily_challenge_dashboard_v2'
    );
    expect(revisionReceiptMigration).toContain('FOR UPDATE;');
    expect(revisionReceiptMigration).toContain("jsonb_build_object('revision'");
    expect(revisionReceiptMigration).toContain('FROM PUBLIC, anon;');
    expect(service).toContain(
      "revision: readReceiptInteger(payload.revision, context, 'dashboard revision', 1)"
    );
    expect(service).toContain('async getDashboardRevision(userId: string)');
  });

  it('uses server UTC keys and rotates through the complete Daily catalog', () => {
    const assignmentBody = certificationRepairMigration.slice(
      certificationRepairMigration.indexOf(
        'CREATE OR REPLACE FUNCTION public.fn_assign_current_challenge_period'
      ),
      certificationRepairMigration.indexOf(
        'REVOKE ALL ON FUNCTION public.fn_assign_current_challenge_period'
      )
    );
    expect(certificationRepairMigration).toContain(
      'CREATE OR REPLACE FUNCTION public.get_daily_challenge_dashboard_v3()'
    );
    expect(certificationRepairMigration).toContain("transaction_timestamp() AT TIME ZONE 'utc'");
    expect(assignmentBody).toContain("WHERE c.tier = 'daily'");
    expect(assignmentBody).toContain('c.is_active');
    expect(assignmentBody).toContain('PARTITION BY c.challenge_type');
    expect(assignmentBody).not.toContain('buckets(reward, ordinal)');
    expect(assignmentBody).not.toContain('c.diamond_reward = b.reward');
    expect(certificationRepairMigration).toContain('ADD COLUMN IF NOT EXISTS is_active');
    expect(certificationRepairMigration).toContain(
      'Active Daily Mission catalog does not match the canonical 39/8/6 contract set'
    );
    expect(certificationRepairMigration).toContain('AND c.is_active');
    expect(certificationRepairMigration).toContain(
      'CREATE OR REPLACE FUNCTION public.reroll_daily_challenge'
    );
  });

  it('assigns before locking the revision cursor and denies browser mutation authority', () => {
    const v2Body = certificationRepairMigration.slice(
      certificationRepairMigration.indexOf(
        'CREATE OR REPLACE FUNCTION public.get_daily_challenge_dashboard_v2'
      ),
      certificationRepairMigration.indexOf(
        'CREATE OR REPLACE FUNCTION public.get_daily_challenge_dashboard_v3'
      )
    );
    expect(v2Body.indexOf('PERFORM public.assign_user_challenges')).toBeGreaterThan(-1);
    expect(v2Body.indexOf('PERFORM public.assign_user_challenges')).toBeLessThan(
      v2Body.indexOf('FOR UPDATE')
    );
    expect(certificationRepairMigration).toContain('FROM PUBLIC, anon, authenticated;');
    expect(certificationRepairMigration).toContain(
      "has_table_privilege('authenticated', 'public.daily_challenge_catalog', 'UPDATE')"
    );
  });

  it('Title Cases database copy at rest and again at the page boundary', () => {
    expect(service).toContain('name: titleCase(name)');
    expect(service).toContain('description: titleCase(description)');
    expect(titleCaseMigration).toContain("WHEN 'hands_10' THEN 'Play 10 Hands Today'");
    expect(titleCaseMigration).toContain("WHEN 'hands_25' THEN 'Play 25 Hands Today'");
    expect(titleCaseMigration).toContain("WHEN 'showdown_3' THEN 'Reach 3 Showdowns Today'");
    expect(titleCaseMigration).toContain("WHEN 'weekly_hands_250' THEN 'Play 250 Hands This Week'");
    expect(titleCaseMigration).toContain(
      'Daily Mission catalog or assigned display copy is not Title Cased'
    );
  });
});
