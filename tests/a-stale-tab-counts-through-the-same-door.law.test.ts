/**
 * A STALE TAB COUNTS THROUGH THE SAME DOOR.
 *
 * 20261002223109_a_counter_is_not_a_public_write took the four raw counters
 * away from every browser and gave it fn_count_content_engagement. The reels
 * pages, and every tab already open, still call increment_reel_count /
 * increment_post_count for a view and a share, so a real player's view stopped
 * counting at all. The defect was that a browser could write ANY count in ANY
 * direction for ANYONE - not that it could report its own view.
 *
 * So the four names decide by who is calling: the service role keeps the
 * unchanged body; a browser's view or share goes through the same once-a-day
 * receipt for auth.uid(); anything else a browser asks for is refused.
 * scripts/ci/test-a-stale-tab-counts-through-the-same-door.py proves it on
 * production's exact pre-image (18 cases).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';

const MIGRATIONS = join(__dirname, '..', 'supabase', 'migrations');
const NAME = readdirSync(MIGRATIONS)
  .filter((f) => f.endsWith('_a_stale_tab_counts_through_the_same_door.sql'))
  .sort()
  .at(-1);
if (!NAME) throw new Error('the a-stale-tab-counts-through-the-same-door migration is missing');
const SQL = readFileSync(join(MIGRATIONS, NAME), 'utf8');
const CODE = SQL.split('\n')
  .filter((l) => !l.trimStart().startsWith('--'))
  .join('\n');
const HARNESS = readFileSync(
  join(__dirname, '..', 'scripts', 'ci', 'test-a-stale-tab-counts-through-the-same-door.py'),
  'utf8'
);
const body = (name: string): string => {
  const start = CODE.indexOf(`CREATE OR REPLACE FUNCTION public.${name}(`);
  return CODE.slice(start, CODE.indexOf('$function$;', start));
};
const BROWSER = /IF COALESCE\(auth\.role\(\), 'service_role'\) <> 'service_role' THEN/;

describe('a stale tab counts through the same door', () => {
  it('decides by the request role, never by current_user', () => {
    for (const fn of [
      'increment_reel_count',
      'decrement_reel_count',
      'increment_post_count',
      'decrement_post_count',
    ]) {
      expect(body(fn)).toMatch(BROWSER);
      expect(body(fn)).not.toMatch(/current_user/);
    }
  });

  it("routes a browser's view or share through the one receipt, and nothing else", () => {
    for (const [fn, source, id] of [
      ['increment_reel_count', 'reels', 'p_reel_id'],
      ['increment_post_count', 'posts', 'p_post_id'],
    ]) {
      const browser = body(fn).slice(0, body(fn).indexOf('RETURN;'));
      expect(browser).toContain(
        `PERFORM public.fn_count_content_engagement(${id}, 'view', '${source}');`
      );
      expect(browser).toContain(
        `PERFORM public.fn_count_content_engagement(${id}, 'share', '${source}');`
      );
      expect(browser).toMatch(/ELSE\s+RAISE EXCEPTION[^;]*USING ERRCODE = '42501';/);
      expect(browser).not.toMatch(/EXECUTE format/);
    }
  });

  it('refuses every browser decrement before it reaches the update', () => {
    for (const fn of ['decrement_reel_count', 'decrement_post_count']) {
      const text = body(fn);
      const refuse = text.search(BROWSER);
      expect(refuse).toBeGreaterThan(-1);
      expect(text.indexOf("USING ERRCODE = '42501'")).toBeLessThan(text.indexOf('EXECUTE format'));
    }
  });

  it('replaces only the pinned live text, and keeps anon out', () => {
    for (const md5 of [
      '23f843d6fb8c218559dfed7ad59f8421',
      '2f3f5d1cf59b0645aaee4951943dec6c',
      '4dab81e6b5c5eed82f71ab751a07a54e',
      '6e8206b74bc797839782a9017bb94570',
    ]) {
      expect(CODE).toContain(`'${md5}'`);
    }
    expect(CODE).toContain('COUNTER_MOVED_UNDERNEATH');
    for (const fn of [
      'increment_reel_count',
      'decrement_reel_count',
      'increment_post_count',
      'decrement_post_count',
    ]) {
      expect(CODE).toContain(`REVOKE ALL ON FUNCTION public.${fn}(uuid, text) FROM PUBLIC, anon;`);
      expect(CODE).toContain(
        `GRANT EXECUTE ON FUNCTION public.${fn}(uuid, text) TO authenticated, service_role;`
      );
    }
    expect(CODE).not.toMatch(/TO[^;]*\banon\b[^;]*;/);
  });

  it('is one transaction with a lock timeout, has no DROP, and repairs nothing', () => {
    expect(CODE.match(/^BEGIN;$/gm)).toHaveLength(1);
    expect(CODE.match(/^COMMIT;$/gm)).toHaveLength(1);
    expect(CODE).toMatch(/BEGIN;\nSET LOCAL lock_timeout = '2s';/);
    expect(CODE).not.toMatch(/\bDROP\b/);
    expect(CODE).not.toMatch(/\b(backfill|back_pay|backpay|redrive|catchup|resweep)\b/i);
    expect(SQL).toMatch(/@live-proof: \(SELECT has_function_privilege\('authenticated'/);
  });

  it('is proved on the exact production pre-image by the harness', () => {
    for (const name of [
      'pre-image-is-production',
      'before-a-stale-tab-view-is-refused',
      'a-stale-tab-view-counts-once',
      'it-is-the-same-receipt-as-the-new-door',
      'a-browser-cannot-add-a-like',
      'a-browser-cannot-take-a-reel-count-down',
      'a-browser-cannot-take-a-post-count-down',
      'anon-still-cannot-call-a-counter',
      'the-server-keeps-the-unchanged-body',
    ]) {
      expect(HARNESS).toContain(name);
    }
    expect(HARNESS).toContain("run('shipped-migration', SHIPPED)");
  });
});
