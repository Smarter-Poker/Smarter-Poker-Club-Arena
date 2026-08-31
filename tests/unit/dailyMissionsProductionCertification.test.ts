import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const root = resolve(import.meta.dirname, '../..');

function source(path: string) {
  return readFileSync(resolve(root, path), 'utf8');
}

describe('Daily Missions production certification', () => {
  it('runs the isolated certification after every successful production publish', () => {
    const workflow = source('.github/workflows/post-deploy-e2e.yml');
    expect(workflow).toContain("DAILY_MISSIONS_CERTIFICATION: '1'");
    expect(workflow).toContain('tests/e2e/production-daily-missions.spec.ts');
    expect(workflow).toContain(
      'SUPABASE_SERVICE_ROLE_KEY: ${{ secrets.SUPABASE_SERVICE_ROLE_KEY }}'
    );
  });

  it('covers the production load, economy, realtime, recovery and accessibility contracts', () => {
    const spec = source('tests/e2e/production-daily-missions.spec.ts');
    for (const contract of [
      'get_daily_challenge_dashboard',
      'challenge_reroll:',
      'buy_streak_freeze',
      'bump_challenge_progress',
      'claim_daily_challenges',
      'Preference On, Device Disconnected',
      'Mission Network Unavailable',
      'document.documentElement.scrollWidth',
      "dailyTab.press('ArrowRight')",
    ]) {
      expect(spec).toContain(contract);
    }
    expect(spec).toContain('cleanupTemporaryCustomizationAccount(environment, account)');
  });

  it('hard-deletes all Daily Missions and reward-ledger fixture residue', () => {
    const helper = source('tests/e2e/support/temporaryCustomizationAccount.ts');
    for (const table of [
      'daily_mission_operations',
      'daily_challenge_claim_batches',
      'daily_challenge_dashboard_revisions',
      'user_daily_challenges',
      'challenge_streak_state',
      'user_notification_preferences',
      'notifications',
      'push_outbox',
      'wallet_credit_idempotency',
      'wallets',
      'chip_transactions',
    ]) {
      expect(helper).toContain(`'${table}'`);
    }
    expect(helper).toContain('reserved fixture residue remains after cleanup');
  });

  it('keeps decorative card chrome out of every mission control hit target', () => {
    const css = source('src/pages/DailyChallengesPage.module.css');
    const before = css.slice(
      css.indexOf('.challengeCard::before'),
      css.indexOf('.challengeCard::after')
    );
    const after = css.slice(css.indexOf('.challengeCard::after'), css.indexOf('.cardCompleted'));
    expect(before).toContain('pointer-events: none');
    expect(after).toContain('pointer-events: none');
  });
});
