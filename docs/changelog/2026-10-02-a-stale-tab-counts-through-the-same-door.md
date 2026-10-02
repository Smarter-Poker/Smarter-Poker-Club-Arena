# A stale tab counts through the same door (2026-10-02)

Follow-up to `20261002223109_a_counter_is_not_a_public_write`, phase 3 of 9 (security sweep).

## What the first migration left

The first migration took the four raw counters away from every browser role and gave the
browser `fn_count_content_engagement`. That function counts one view or one share for
`auth.uid()`, at most once a day per piece of content.

But the World Hub reels pages (`pages/hub/reels.js`, `Reels.jsx`, `ReelsFeedCarousel.jsx`) still
called `increment_reel_count` / `increment_post_count` for a view and a share, and so did every tab
a player already had open. Those calls now failed with 42501 and were swallowed by the page's
`catch`. Measured on production after the apply, as a real player in a rolled-back probe: the raw
counter answered 42501, and that view was never counted.

That was not the outcome phase 3 wanted. The defect was that a browser could write any count, in
either direction, for anyone. It was never that a browser could report its own view.

## What changed

Migration `20261002232011_a_stale_tab_counts_through_the_same_door`, one transaction. The four
names keep their signatures and decide by who is calling, using
`COALESCE(auth.role(), 'service_role')`. Two rules apply here:

- The decision is never made on `current_user`, which SECURITY DEFINER rewrites to the owner.
- A session with no request is the server.

| caller                                 | `increment_*_count`                                      | `decrement_*_count` |
| -------------------------------------- | -------------------------------------------------------- | ------------------- |
| service role / no request              | unchanged body                                           | unchanged body      |
| browser, `view_count` or `share_count` | `fn_count_content_engagement` for the caller, once a day | refused, 42501      |
| browser, any other field               | refused, 42501                                           | refused, 42501      |
| anon                                   | no grant                                                 | no grant            |

Each replacement is pinned. A DO block asserts the md5 of `pg_get_functiondef` for all four
production functions before anything is replaced, and aborts with `COUNTER_MOVED_UNDERNEATH` if
any of them moved. The server half of each body is the live text, unchanged.

The migration has no DROP. The Supabase MCP holds a DROP for an interactive confirmation that an
unattended apply cannot give.

## What it also fixes

The two browser comment-delete handlers (`pages/hub/social-media/index.js` and
`pages/hub/user/[username].js`) called `decrement_post_count('comment_count')` after deleting a
comment. `trig_update_post_comment_count` had already counted that delete, so the post author's own
deletes were counted twice. That call is now refused, and the trigger counts the delete once. The
page swallows the error, as it always did.

## Proof

`scripts/ci/test-a-stale-tab-counts-through-the-same-door.py` (17 cases, all green). It runs
against both texts of the first migration: the one merged in #5876 and the one that ran.

It loads production's exact counter text; the md5 of all four is pinned in the case
`pre-image-is-production`. It then runs both shipped migrations verbatim and proves the following
as the browser role:

- **Before:** an old view call is refused.
- **After:**
  - five old view calls count once;
  - the new door then sees the same receipt;
  - a share counts once, and a second player counts once more;
  - a post's view counts on the post;
  - a like, a comment count, and either decrement are refused;
  - anon is refused.
- **The server** still increments and decrements every field.

Law: `tests/a-stale-tab-counts-through-the-same-door.law.test.ts`.

## Left for later

`src/content-engine/pipeline/HorseSocialEngine.js` (World Hub, service role) bumps
`comment_count` / `like_count` after inserting a horse's comment or like, which the insert's
trigger has already counted. So a horse's comment or reaction is counted twice. It runs on the
service role, so it is not a security path, and it moves no money. The fix is to delete those
three calls. It is listed for phase 9 (housekeeping) together with the World Hub reels pages
moving to the new door by name.

Nothing was backfilled and nothing was repaired (CLAUDE.md 10.12).
