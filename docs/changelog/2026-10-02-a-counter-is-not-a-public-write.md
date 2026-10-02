# A counter is not a public write (2026-10-02)

Phase 3 of 9 (security sweep): the reel functions, and the functions and tables any logged-in
player could write. Every item below was read from production on 2026-10-02. Each one is closed at
the line that caused it.

## How the sweep was done

- **Definer audit.** `fn_definer_exposure_audit()` lists SECURITY DEFINER functions that a browser
  can execute, that write, and that never consult `auth.uid()`, `auth.role()` or `auth.jwt()`. It
  found three:
  - the two reel counters (issue #5762);
  - `recalculate_leaderboard_ranks`, which is already reviewed in the baseline.
- **Identity-parameter writers.** The 61 SECURITY DEFINER writers that take a caller-supplied
  identity parameter were spot-checked. All of them tie that parameter to `auth.uid()` or a staff
  role.
- **Policy scan.** Every INSERT, UPDATE, DELETE and ALL policy for anon, authenticated or PUBLIC
  whose condition is not bound to the caller was listed. So was every open SELECT policy on a
  table with contact, token or code columns, checked against column privileges.
- **Rolled-back probe.** As an ordinary player, the probe tried to change each money, standing and
  verification column of their own `profiles`, `club_members` and `wallets` rows, one column at a
  time. It was one Supabase MCP call ending in `RAISE`, so nothing committed (CLAUDE.md 11.5).
- **Function calls by the writer's role.** Every CHECK constraint, column default and policy that
  calls a function was checked for whether the role that writes the table can execute that
  function.

## What was open, and what closed it

Migration `20261002223109_a_counter_is_not_a_public_write`, one transaction:

- **Reel counters.** `increment_reel_count` / `decrement_reel_count` were SECURITY DEFINER and
  executable by every player, over any field, in either direction, with no caller check. A browser
  loop could add a million views or remove a rival's likes. Now they are service role only. The
  browser calls `fn_count_content_engagement(content, 'view' or 'share')`, which counts the caller
  (`auth.uid()`, never a parameter) at most once a day per content.
- **Post counters.** `increment_post_count` / `decrement_post_count` were SECURITY INVOKER, and
  even anon could execute them. Now service role only.
- **Venue claims.** `venue_claims_read USING (true)` let anyone read `verification_code`, the code
  `/api/public/venue/verify` compares, along with the claimant's email and phone. Reading the code
  is passing the check. The policy is dropped and the browser grants are revoked; only the API
  routes and the admin RPCs read the table.
- **Page claims.** Anyone could read the contact email and phone. A claimant now sees only their
  own claim, which is exactly the lookup the `page_notifications` policy makes.
- **Venue schedules.** The INSERT and UPDATE policies only required "signed in", so any account
  could rewrite any venue's posted games. The write policies are dropped;
  `/api/poker/venue-schedules`, on the service role, is the writer.
- **`poker_tables`.** Any account could INSERT. The policy is dropped.
- **Profile trust columns.** A player could set their own `email_verified`, `phone_verified`,
  `access_tier`, `tier`, `skill_tier` and `level`. `phone_verified` is what the duplicate-phone
  guard in `/api/sms/verify-otp` matches on. `trg_guard_profile_trust_columns` now refuses a
  browser change. The diamond guard is md5-pinned by the diamond concurrency harness, so this is a
  second trigger.
- **Log rows.** `commander_home_group_share_log`, `commander_home_group_view_log` and
  `qr_code_scans` accepted a direct insert that named another user. WITH CHECK now pins the row to
  the caller. The real writers are SECURITY DEFINER RPCs and a service-role route, so they are
  unaffected.
- **`club_members` writes.** Every browser UPDATE and INSERT failed with "permission denied for
  function `fn_ca_house_board_allows_automation`". The CHECK `club_members_bot_house_only` calls
  it, and Postgres checks the privilege before `NOT is_bot` can short-circuit. Fixed with
  `GRANT EXECUTE ... TO authenticated`; the function is a stable read of `clubs.is_platform`. This
  was the only expression of its kind on the database.

## World Hub

Branch `p3-reel-counts-through-one-door`:

- **Reels pages.** `pages/hub/reels.js`, `Reels.jsx` and `ReelsFeedCarousel.jsx` now count through
  `src/lib/contentEngagement.mjs`, which can only ask for a view or a share.
- **Comment deletes.** The two browser comment-delete handlers no longer call
  `decrement_post_count`. `trig_update_post_comment_count` already counts the delete, so every
  delete was counted twice.
- **HorseSocialEngine.** It no longer bumps `comment_count` or `like_count` after inserting the
  comment or like. The insert's trigger already counted it, so every horse comment and reaction
  was counted twice. Horses and humans now take the same single path.

Law: `__tests__/a-counter-is-not-a-public-write.law.test.mjs`.

## Proof

`scripts/ci/test-a-counter-is-not-a-public-write.py` runs on a disposable PostgreSQL cluster with
the production shape of every object touched: the live counter bodies and grants, the open
policies as they stood, and the CHECK. It acts as the real browser role, using `SET ROLE
authenticated` plus `request.jwt.claims`. All 49 cases pass:

- **Before the migration**, each finding reproduces: 50 views added by one player, the
  verification code read, a schedule rewritten, a phone self-verified, and a `club_members` write
  refused.
- **The shipped migration is then run verbatim.** Afterwards:
  - the raw counters refuse a player and anon, and the server keeps them;
  - fifty views from one player count once, a second player counts once more, an alias counts as
    the same view, a share has its own receipt, and a day later the same player counts again;
  - claims, schedules, profile flags and log rows are closed, while the claimant's own
    notifications, the player's own name edit and the server's writes still work;
  - the player's own `club_members` row is writable again, and the house-board CHECK still
    refuses a bot.

Law: `tests/a-counter-is-not-a-public-write.law.test.ts`.

## Reviewed and left as they are

- **`recalculate_leaderboard_ranks`.** It recomputes `dense_rank()` over scores that only the
  service role can write (`promotion_leaderboards` has no browser write policy). It stays in the
  baseline.
- **19 "mutable search_path" functions.** All are SECURITY INVOKER, and neither browser role can
  create objects in `public` or `extensions`, so there is no hijack path. Several are md5-pinned
  by other harnesses.
- **24 anon-executable SECURITY DEFINER functions.** These are read-only public lookups; the audit
  finds 0 anon writers. Those that take a viewer or caller id
  (`get_home_group_public_detail`, `get_venue_public_detail`) check it against `auth.uid()`.
- **Extensions in `public`** (pg_trgm, vector, plpgsql_check, dblink). Moving them would break the
  functions and indexes that use them. They are not a privilege path.
- **`rls_enabled_no_policy`** (624 tables). RLS with no policy denies every browser role, which is
  the safe state.
- **`engine_maintenance_break.ownership_token`.** It is readable, but every function that accepts
  it is service-role only.
- **`commander_tournament_entries.player_phone`.** It is readable but holds no value today. The
  Commander tablet reads that table with `select('*')` and realtime, so the column needs a
  Commander client change before its grant can go. That is housekeeping for phase 9.

## Not done

Nothing was backfilled and nothing was repaired (CLAUDE.md 10.12). The comment and like counts
that the double-counting already inflated stay as they are. They are display counts, not money.
