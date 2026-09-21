import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';
import { readDailyChallengesUnit } from '../helpers/dailyChallengesSources';

import { readDailyChallengesStylesheet } from '../helpers/dailyChallengesSources';

const root = resolve(import.meta.dirname, '../..');

function source(path: string) {
  return readFileSync(resolve(root, path), 'utf8');
}

describe('Daily Missions production certification', () => {
  it('runs the isolated certification after every successful production publish', () => {
    const workflow = source('.github/workflows/post-deploy-e2e.yml');
    expect(workflow).toContain("DAILY_MISSIONS_CERTIFICATION: '1'");
    expect(workflow).toContain('tests/e2e/production-daily-missions.spec.ts');
    expect(workflow).toContain('tests/e2e/daily-challenges-accessibility-responsive.spec.ts');
    expect(workflow).toContain('tests/e2e/daily-missions-database-settlement.spec.ts');
    expect(workflow).toContain('e2e-report/daily-missions-accessibility.json');
    expect(workflow).toContain('e2e-report/daily-missions-settlement.json');
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
      'record_daily_challenge_event',
      'daily_challenge_dashboard_revisions',
      "getByText('Live Now')",
      'claim_daily_challenges',
      'Preference On, Device Disconnected',
      'subscription.unsubscribe()',
      'Challenge Ledger Unavailable',
      'firstRerollButton',
      'document.documentElement.scrollWidth',
      "dailyTab.press('ArrowRight')",
    ]) {
      expect(spec).toContain(contract);
    }
    expect(spec).toContain('cleanupTemporaryCustomizationAccount(environment, account)');
    expect(spec).toContain('blockRevisionFrames = true');
    expect(spec).toContain('interceptedRealtimeSockets');
    expect(spec).toContain('isDailyMissionRevisionFrame');
    expect(spec).toContain('observedRevisionFrames');
    expect(spec).toContain('never mints chips');
    expect(spec).toContain("'diamond_transactions'");
    expect(spec).toContain('challenge_claim_batch:${requestBody.p_request_id}:diamonds');
    expect(spec).not.toContain("'wallet_credit_idempotency',\n          account!.id");
    expect(spec).toMatch(
      /expect\(\s*advanced\.length,\s*'the catch-all mission event must advance at least one contract'\s*\)\.toBeGreaterThan\(0\)/
    );
    expect(spec).not.toContain('expect(advanced.length).toBeGreaterThanOrEqual(10)');
    expect(spec.indexOf('expect(completed.every((row) => row.completed)).toBe(true)')).toBeLessThan(
      spec.indexOf('No Daily Mission revision frame crossed the routed socket')
    );
    // The page owns no repair timer. The missed-frame step must prove that a
    // healthy socket with suppressed frames issues no revision cursor read,
    // then interrupt the socket itself so the reconnect lifecycle owns the
    // catch-up. A step that waits for a timer-driven repair is forbidden.
    expect(spec).toContain('const NO_POLL_QUIET_WINDOW_MS = 20_000;');
    expect(spec).toContain(
      "const REVISION_CURSOR_PATH = '/rest/v1/daily_challenge_dashboard_revisions';"
    );
    expect(spec).toContain('routedRealtimeServers.push(server)');
    expect(spec).toContain('routedRealtimeServers.splice(0)');
    expect(spec).toContain(
      "await server.close({ code: 1012, reason: 'Certification Realtime Interruption' })"
    );
    expect(spec.indexOf('await page.waitForTimeout(NO_POLL_QUIET_WINDOW_MS)')).toBeLessThan(
      spec.indexOf('routedRealtimeServers.splice(0)')
    );
    expect(spec.indexOf('routedRealtimeServers.splice(0)')).toBeLessThan(
      spec.indexOf('name: /^Claim (?:All|Next) / })')
    );
    expect(spec).not.toMatch(/revision cursor watchdog/);
    // dashboard_loaded is intentionally sampled at 20%; certification proves
    // the actual receipt and only requires unsampled mutation operations.
    const operationGate = spec.slice(
      spec.indexOf('const requiredOperationEvents ='),
      spec.indexOf('report.operationEvents')
    );
    expect(operationGate).not.toContain("'dashboard_loaded'");
    expect(operationGate).toContain("'reroll_succeeded'");
    expect(spec).toContain('descendantOffenders: Array.from');
    expect(spec).toContain('if (nodeBounds.width === 0 && nodeBounds.height === 0) return false;');
    expect(spec).toContain('descendantOffenders: []');
  });

  it('certifies authentic seven-day settlement, legacy multiplier history, and two-tab calm', () => {
    const spec = source('tests/e2e/daily-missions-database-settlement.spec.ts');
    expect(spec).toContain("is_active: 'eq.true'");
    expect(spec).toContain('installHistoricalBoostedMilestone');
    expect(spec).toContain('HISTORICAL_MILESTONE_ACTUAL_DIAMONDS');
    expect(spec).toContain('for (const [index, assignedDate]');
    expect(spec).toContain('milestoneDiamonds: 0');
    expect(spec).toContain('exact_value: true');
    expect(spec).toContain('secondTabClient');
    expect(spec).toContain('settledRevision');
    expect(spec).toContain('cleanupTemporaryCustomizationAccount(environment, account)');
  });

  it('hard-deletes all Daily Missions and reward-ledger fixture residue', () => {
    const helper = source('tests/e2e/support/temporaryCustomizationAccount.ts');
    const spec = source('tests/e2e/production-daily-missions.spec.ts');
    for (const table of [
      'daily_mission_operations',
      'daily_challenge_progress_events',
      'daily_challenge_event_outbox',
      'daily_challenge_milestone_claims',
      'daily_challenge_claim_batches',
      'daily_challenge_reroll_receipts',
      'daily_challenge_freeze_entitlements',
      'daily_challenge_dashboard_revisions',
      'user_daily_challenges',
      'challenge_streak_state',
      'club_members',
      'user_notification_preferences',
      'notifications',
      'push_outbox',
      'wallet_credit_idempotency',
      'wallets',
      'chip_transactions',
      'audit_trail',
      'table_waitlist',
      'rate_limits',
    ]) {
      expect(helper).toContain(`'${table}'`);
    }
    expect(helper).toContain("{ table: 'notifications', column: 'actor_id' as const }");
    expect(helper).toContain("{ table: 'profiles', column: 'id' as const }");
    expect(helper).toContain("{ table: 'users', column: 'id' as const }");
    expect(spec).toContain('hand history: exact fixture row remains');
    expect(helper).toContain('reserved fixture residue remains after cleanup');
    // Certification owns and removes the exact UUID it creates. Listing the
    // entire Auth tenant first makes an unrelated damaged account capable of
    // blocking every post-deploy verdict before a fixture even exists.
    expect(helper).not.toContain('/auth/v1/admin/users?page=');
  });

  it('keeps decorative card chrome out of every mission control hit target', () => {
    const css = readDailyChallengesStylesheet();
    const before = css.slice(
      css.indexOf('.challengeCard::before'),
      css.indexOf('.challengeCard::after')
    );
    const after = css.slice(css.indexOf('.challengeCard::after'), css.indexOf('.cardCompleted'));
    expect(before).toContain('pointer-events: none');
    expect(after).toContain('pointer-events: none');
    const page = source('src/pages/DailyChallengesPage.tsx');
    expect(page).toContain("import { createPortal } from 'react-dom'");
    expect(page).toContain('document.body');
    const pageObject = source('tests/e2e/support/DailyMissionsPage.ts');
    const spec = source('tests/e2e/production-daily-missions.spec.ts');
    expect(pageObject).toContain('placeControlInSafeViewport');
    expect(pageObject).toContain("block: 'center'");
    expect(pageObject).toContain("getByRole('navigation', { name: 'Poker Arena' })");
    expect(pageObject).toContain('sp_firstrun_notif_v2_${userId}');
    expect(pageObject).toContain('authenticatedUserId !== account.id');
    expect(pageObject).toContain("for (const tier of ['Daily', 'Weekly', 'Monthly'] as const)");
    expect(pageObject).toContain('/^Reroll 1 Diamond For .+$/');
    expect(spec).toContain('/^Confirm Reroll For /');
  });

  it('targets the enforced title-case reroll accessibility contract', () => {
    const page = source('src/pages/DailyChallengesPage.tsx');
    const pageObject = source('tests/e2e/support/DailyMissionsPage.ts');
    const certification = source('tests/e2e/production-daily-missions.spec.ts');
    expect(page).toContain('? `Reroll ${DAILY_MISSION_REROLL_COST} Diamond For ${c.name}`');
    expect(page).toContain(': `Need ${DAILY_MISSION_REROLL_COST} Diamond To Reroll ${c.name}`');
    expect(pageObject).toContain('name: /^Reroll 1 Diamond For .+$/');
    expect(certification).toContain('name: /^Confirm Reroll For /');
  });

  it('keeps a disconnected saved alert preference ahead of browser capability status', () => {
    const alertsPanel = readDailyChallengesUnit('MissionAlertsPanel.tsx');
    const disconnectedStatus = alertsPanel.indexOf(
      ": deviceNeedsConnection\n        ? 'Preference On, Device Disconnected'"
    );
    const deniedStatus = alertsPanel.indexOf(": permission === 'denied'", disconnectedStatus);
    expect(disconnectedStatus).toBeGreaterThan(-1);
    expect(deniedStatus).toBeGreaterThan(disconnectedStatus);
    expect(alertsPanel).toContain(
      'Allow Notifications For Smarter Poker In Your Browser Settings, Then Reload.'
    );
  });

  it('keeps every mission control above the fixed Club Arena footer', () => {
    const css = readDailyChallengesStylesheet();
    expect(css).toContain('padding: 24px 18px calc(var(--bottom-nav-clearance, 74px) + 24px)');
    expect(css).toContain('padding: 0 0 max(84px, calc(var(--bottom-nav-clearance, 74px) + 12px))');
  });

  it('keeps modal dialogs above inert toasts and contains backdrop scrolling', () => {
    const pageCss = readDailyChallengesStylesheet();
    const toastCss = source('src/components/common/Toast.css');
    const overlay = pageCss.slice(
      pageCss.indexOf('.celebrateOverlay {'),
      pageCss.indexOf('.celebrateCard {')
    );
    const toastContainer = toastCss.slice(
      toastCss.indexOf('.toast-container {'),
      toastCss.indexOf('.toast {')
    );
    expect(overlay).toContain('z-index: 10020');
    expect(overlay).toContain('overscroll-behavior: contain');
    expect(toastContainer).toContain('z-index: 10000');
    expect(source('tests/e2e/production-daily-missions.spec.ts')).toContain(
      'backgroundScrollPosition'
    );
  });

  it('bounds player-scoped wallet receipt cleanup with an online index', () => {
    const migration = source(
      'supabase/migrations/20260901010000_daily_missions_certification_cleanup_index.sql'
    );
    expect(migration).toContain(
      'CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_wallet_credit_idempotency_user_id'
    );
    expect(migration).toContain('SET statement_timeout = 0');
    expect(migration).toContain('ON public.wallet_credit_idempotency (user_id)');
  });

  it('hard-deletes only reserved certification identities through service_role', () => {
    const migration = source(
      'supabase/migrations/20260901020000_reserved_certification_account_cleanup.sql'
    );
    expect(migration).toContain("v_email NOT LIKE 'ca-customization-cert-%@example.invalid'");
    expect(migration).toContain("SET statement_timeout = '10min'");
    expect(migration).toContain(
      'GRANT EXECUTE ON FUNCTION public.cleanup_reserved_certification_account(uuid) TO service_role'
    );
    expect(migration).toContain(
      'REVOKE ALL ON FUNCTION public.cleanup_reserved_certification_account(uuid) FROM authenticated'
    );
    const orderFix = source(
      'supabase/migrations/20260901020100_reserved_certification_cleanup_order_fix.sql'
    );
    expect(orderFix.indexOf('DELETE FROM public.user_daily_challenges')).toBeLessThan(
      orderFix.indexOf('DELETE FROM public.daily_challenge_dashboard_revisions')
    );
    expect(orderFix.indexOf('DELETE FROM public.daily_challenge_dashboard_revisions')).toBeLessThan(
      orderFix.indexOf('DELETE FROM auth.users')
    );
    const auditFix = source(
      'supabase/migrations/20260901020200_reserved_certification_cleanup_audit_trail.sql'
    );
    expect(auditFix).toContain("v_email NOT LIKE 'ca-customization-cert-%@example.invalid'");
    expect(auditFix.indexOf('DELETE FROM public.audit_trail')).toBeLessThan(
      auditFix.indexOf('DELETE FROM auth.users')
    );
    expect(auditFix).toContain(
      'REVOKE ALL ON FUNCTION public.cleanup_reserved_certification_account(uuid) FROM authenticated'
    );
  });

  it('reads the signed-in account THROUGH the navigation, not into a dead context', () => {
    /* 2026-09-02. This spec failed on EVERY post-deploy run with

         Error: page.evaluate: Execution context was destroyed, most likely
         because of a navigation
           at support/DailyMissionsPage.ts:123

       `signIn` navigates with waitUntil: 'domcontentloaded', which returns
       while the SPA is still settling its own auth redirect, and then read
       localStorage - so the context the read was issued against was torn down
       under it. A harness bug wearing a production failure's clothes, and the
       one failure common to all three runs that night.

       The read itself must stay: it is the check that the certification is
       signed in as the RESERVED account, which is the only thing standing
       between this suite and it mutating a real player. So it retries through
       the navigation instead of being deleted. */
    const helper = source('tests/e2e/support/DailyMissionsPage.ts');
    expect(helper).toContain('async function evaluateThroughNavigation');
    expect(helper).toMatch(/authenticatedUserId = await evaluateThroughNavigation\(/);

    expect(helper).toContain('await account.client.auth.getSession()');
    expect(helper).toContain("localStorage.setItem('smarter-poker-auth', JSON.stringify(session))");
    expect(helper).not.toContain('const localBundle =');

    // ...and ONLY for that family of errors. A wrong account or bad JSON must
    // still throw on the first attempt rather than being retried into silence.
    expect(helper).toMatch(
      /if \(!NAVIGATION_ATE_THE_CONTEXT\.test\(String\(error\)\)\) throw error;/
    );
  });
});
