/**
 * LAW: horses can publish to the video library.
 * ===========================================================================
 * Dan, 2026-10-19, verbatim: "HORSES CAN PUBLISH VIDEOS."
 *
 * And CLAUDE.md 10.5, Dan 2026-08-27: "HORSES ARE NEVER EVER DISCLUDED BY
 * DESIGN ON ANYTHING! THEY MUST ALWAYS BE TREATED LIKE REAL LIVE PLAYERS!"
 *
 * public.fn_video_library_publisher_is_eligible(uuid) is the single test
 * behind every door into the Video Library (publish_video_library_reel and the
 * row guards fn_guard_video_library_row_author and
 * fn_guard_video_library_publisher_config). It required `p.is_horse IS FALSE`,
 * so no horse could ever publish there. Removed in
 * 20261019093704_horses_can_publish_to_the_video_library: a horse is eligible
 * under exactly the rules a human is - the profile exists and is not a
 * content_authors row.
 *
 * Reading is_horse as DATA stays legal (10.5): publish_horse_video_reel and
 * the post-contract trigger that tags a horse upload's origin_type identify
 * horses; they deny them nothing. What this refuses is the eligibility rule,
 * or the messages that describe it, treating a horse differently again.
 */
import { describe, expect, it } from 'vitest';
import { functionBody, latestDeclaring } from './helpers/migrations';

function current(fn: string): string {
  return functionBody(latestDeclaring(fn).sql, fn);
}

describe('horses can publish to the video library (Dan, 2026-10-19)', () => {
  it('the publisher eligibility rule does not read is_horse at all', () => {
    const body = current('fn_video_library_publisher_is_eligible');
    expect(body).not.toMatch(/is_horse/i);
    expect(body).toContain('FROM public.profiles p');
    expect(body).toContain('WHERE p.id = p_profile_id');
    expect(body).toContain('FROM public.content_authors ca');
  });

  it('the guards say what the rule is, which no longer mentions horses', () => {
    for (const fn of [
      'fn_guard_video_library_row_author',
      'fn_guard_video_library_publisher_config',
    ]) {
      const body = current(fn);
      expect(body).toContain('NOT public.fn_video_library_publisher_is_eligible(');
      expect(body).not.toMatch(/non-horse|is_horse/i);
      expect(body).toContain('existing profile with no content_authors row');
    }
  });
});
