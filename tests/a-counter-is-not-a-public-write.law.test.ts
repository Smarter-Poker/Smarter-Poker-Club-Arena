/**
 * A COUNTER IS NOT A PUBLIC WRITE.
 *
 * Phase 3 of 9 (security sweep), measured on production 2026-10-02:
 *
 *   - increment_reel_count / decrement_reel_count were SECURITY DEFINER,
 *     executable by every logged-in player, and never asked who was calling,
 *     so any browser could add a million views to a reel or take a rival's
 *     likes away (issue #5762). The post counters were the same body as
 *     SECURITY INVOKER, executable even by anon.
 *   - venue_claims was readable by anyone, verification_code included - and
 *     reading the code is passing the venue-ownership check.
 *   - any account could rewrite any venue's posted game schedule.
 *   - a player could set their own phone_verified, which the duplicate-phone
 *     guard and the phone-verified VIP path trust.
 *   - every browser write to club_members failed, because its CHECK calls a
 *     function authenticated could not execute.
 *
 * scripts/ci/test-a-counter-is-not-a-public-write.py reproduces each one on a
 * disposable cluster as the real browser role, runs this migration verbatim,
 * and proves each closed (49 cases).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';

const MIGRATIONS = join(__dirname, '..', 'supabase', 'migrations');
const NAME = readdirSync(MIGRATIONS)
  .filter((f) => f.endsWith('_a_counter_is_not_a_public_write.sql'))
  .sort()
  .at(-1);
if (!NAME) throw new Error('the a-counter-is-not-a-public-write migration is missing');
const SQL = readFileSync(join(MIGRATIONS, NAME), 'utf8');
const CODE = SQL.split('\n')
  .filter((l) => !l.trimStart().startsWith('--'))
  .join('\n');
const HARNESS = readFileSync(
  join(__dirname, '..', 'scripts', 'ci', 'test-a-counter-is-not-a-public-write.py'),
  'utf8'
);
const COUNTER = CODE.slice(
  CODE.indexOf('CREATE FUNCTION public.fn_count_content_engagement'),
  CODE.indexOf('$fn$;', CODE.indexOf('CREATE FUNCTION public.fn_count_content_engagement'))
);

describe('a counter is not a public write', () => {
  it('takes the four raw counters away from every browser role, PUBLIC named with them', () => {
    for (const fn of [
      'increment_reel_count',
      'decrement_reel_count',
      'increment_post_count',
      'decrement_post_count',
    ]) {
      expect(CODE).toContain(
        `REVOKE ALL ON FUNCTION public.${fn}(uuid, text) FROM PUBLIC, anon, authenticated;`
      );
      expect(CODE).toContain(`GRANT EXECUTE ON FUNCTION public.${fn}(uuid, text) TO service_role;`);
    }
  });

  it('gives the browser one door, whose subject is the caller and never a parameter', () => {
    expect(COUNTER).toMatch(/SECURITY DEFINER/);
    expect(COUNTER).toMatch(/SET search_path = public, pg_temp/);
    expect(COUNTER).toMatch(/v_viewer\s+uuid := auth\.uid\(\);/);
    // Nothing the caller passes names whose view it is.
    expect(COUNTER).not.toMatch(/p_(user|viewer|actor|caller)_?id/);
    // It can only add one view or one share. Never a like, a comment, a decrement.
    expect(COUNTER).toMatch(/p_kind NOT IN \('view', 'share'\)/);
    expect(COUNTER).not.toMatch(/like_count|comment_count/);
    expect(COUNTER).not.toMatch(/-\s*1/);
    expect(CODE).toContain(
      'REVOKE ALL ON FUNCTION public.fn_count_content_engagement(uuid, text, text) FROM PUBLIC, anon;'
    );
  });

  it('counts a player once a day per content, by primary key, not by a client-side Set', () => {
    expect(CODE).toMatch(/PRIMARY KEY \(content_id, viewer_id, kind\)/);
    expect(COUNTER).toMatch(
      /ON CONFLICT \(content_id, viewer_id, kind\) DO UPDATE[\s\S]*WHERE r\.counted_at < now\(\) - interval '24 hours'/
    );
    expect(COUNTER).toMatch(/IF v_counted IS NOT TRUE THEN\s+RETURN false;/);
  });

  it('keeps the receipts a closed statistic with no foreign key to a hot table', () => {
    const table = CODE.slice(
      CODE.indexOf('CREATE TABLE public.content_engagement_receipts'),
      CODE.indexOf(');', CODE.indexOf('CREATE TABLE public.content_engagement_receipts'))
    );
    expect(table).not.toMatch(/REFERENCES/i);
    expect(CODE).toContain(
      'ALTER TABLE public.content_engagement_receipts ENABLE ROW LEVEL SECURITY;'
    );
    expect(CODE).toContain(
      'REVOKE ALL ON TABLE public.content_engagement_receipts FROM PUBLIC, anon, authenticated;'
    );
  });

  it('closes the claim, schedule and legacy-table writes', () => {
    expect(CODE).toContain(
      'ALTER POLICY venue_claims_read ON public.venue_claims TO service_role;'
    );
    expect(CODE).toContain(
      'REVOKE ALL ON TABLE public.venue_claims FROM PUBLIC, anon, authenticated;'
    );
    expect(CODE).toMatch(
      /ALTER POLICY page_claims_select ON public\.page_claims\s+TO authenticated\s+USING \(user_id = \(SELECT auth\.uid\(\)\)\);/
    );
    expect(CODE).toContain(
      'ALTER POLICY vgs_insert_policy ON public.venue_game_schedules TO service_role;'
    );
    expect(CODE).toContain(
      'ALTER POLICY vgs_update_policy ON public.venue_game_schedules TO service_role;'
    );
    expect(CODE).toContain(
      'ALTER POLICY "Authenticated users can create tables" ON public.poker_tables TO service_role;'
    );
    // Narrowed, never dropped: an unattended apply cannot answer the MCP's
    // confirmation prompt for a DROP, and it never reached the database.
    expect(CODE).not.toMatch(/\bDROP\b/);
  });

  it('refuses a browser change to the verification and standing columns', () => {
    expect(CODE).toMatch(
      /BEFORE UPDATE OF email_verified, phone_verified, access_tier, tier, skill_tier, level\s+ON public\.profiles/
    );
    expect(CODE).toMatch(/IF public\.fn_is_service_context\(\) THEN\s+RETURN NEW;/);
    // The diamond guard is md5-pinned by the diamond concurrency harness; this
    // is a second trigger, never an edit of that one.
    expect(CODE).not.toMatch(/fn_guard_profile_privileged_columns/);
  });

  it('pins every log row to its caller', () => {
    expect(CODE).toMatch(
      /ALTER POLICY share_log_insert_authenticated[\s\S]*?WITH CHECK \(caller_uid = \(SELECT auth\.uid\(\)\)\);/
    );
    expect(CODE).toMatch(
      /ALTER POLICY view_log_insert_authenticated[\s\S]*?WITH CHECK \(caller_uid = \(SELECT auth\.uid\(\)\)\);/
    );
    expect(CODE).toMatch(
      /ALTER POLICY "Authenticated users can record scans"[\s\S]*?WITH CHECK \(scanned_by = \(SELECT auth\.uid\(\)\)\);/
    );
  });

  it("lets club_members' own CHECK be evaluated by the people who write the table", () => {
    expect(CODE).toContain(
      'GRANT EXECUTE ON FUNCTION public.fn_ca_house_board_allows_automation(uuid) TO authenticated;'
    );
  });

  it('is one transaction with a lock timeout, and repairs nothing (10.12)', () => {
    expect(CODE.match(/^BEGIN;$/gm)).toHaveLength(1);
    expect(CODE.match(/^COMMIT;$/gm)).toHaveLength(1);
    expect(CODE).toMatch(/BEGIN;\nSET LOCAL lock_timeout = '2s';/);
    expect(CODE).not.toMatch(/cron\.schedule/i);
    expect(CODE).not.toMatch(/\b(backfill|back_pay|backpay|redrive|catchup|resweep)\b/i);
    expect(SQL).toMatch(/@live-proof: \(SELECT NOT has_function_privilege\('authenticated'/);
  });

  it('is proved before and after on the browser role by the harness', () => {
    for (const name of [
      'before-any-player-adds-fifty-views-to-any-reel',
      'before-any-player-reads-a-venue-claims-verification-code',
      'before-any-player-rewrites-any-venues-schedule',
      'before-a-player-verifies-their-own-phone',
      'before-every-browser-write-to-club-members-is-refused',
      'the-raw-reel-counter-refuses-a-player',
      'fifty-views-from-one-player-count-once',
      'a-day-later-the-same-player-counts-again',
      'a-venue-claim-is-not-readable-by-a-player',
      'and-still-sees-their-pages-notifications',
      'a-player-cannot-rewrite-a-venues-schedule',
      'a-player-still-edits-their-own-name',
      'a-player-can-write-their-own-club-row-again',
    ]) {
      expect(HARNESS).toContain(name);
    }
    // It runs the shipped file, not a copy of it.
    expect(HARNESS).toContain("run('shipped-migration', SHIPPED)");
  });
});
