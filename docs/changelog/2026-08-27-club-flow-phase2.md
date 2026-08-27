# 2026-08-27 — club flow phase 2: true counts, a real limit, honest cards

Session: Cowork (Claude), continuation of the 2026-08-26 club-flow audit.
Shipped as **PR #1398** (main `286cce4a29`) plus a manifest-regen commit.
Verified in production: `/api/health` served WH sync `a78f54bb` (CA
`1650592d6f`, which contains `286cce4a29`) at 2026-08-27T05:36Z.

## Shipped

1. **member_count tells the truth.** InvitePage was the only join path that
   called `increment_member_count(+1)` — on top of
   `trg_sync_club_member_count`, which already RECOUNTS `clubs.member_count`
   on every membership change. Every invite-page join inflated the club's
   count by one until the next membership change. The manual bump is gone.
2. **The 4-club limit is server-side now.** Migration
   `20260827050347_four_club_limit_enforced_server_side` (applied to
   production): BEFORE INSERT and BEFORE UPDATE OF status triggers on
   `club_members` refuse a fifth active/approved membership (errcode 23514,
   house message). The pending→active approval transition is gated too.
   Horses are exempt — the fleet seats them wherever it needs them.
   Probed against production inside a rolled-back subtransaction: 4th
   membership allowed, 5th refused; a horse seated in 6 clubs unhindered;
   zero residue.
3. **Discovery cards stop inventing data.** `clubs` has no
   min_stakes/max_stakes columns, so every card rendered the fallback
   "1/2 - 5/10" as real stakes and the stake filter filtered that
   fabrication. Both removed. The grid also fetched `*, club_members(count)`
   (70+ columns plus an unread embed) for nine rendered fields — explicit
   column list now.
4. **The focus trap traps.** HomePage built a `useFocusTrap` ref for the
   join modal and attached it to nothing. JoinClubModal owns its trap now
   (`role="dialog"`, `aria-modal`), so every caller gets it.

All pinned in `tests/the-lobby-action-bar-actually-works.test.ts`.

## Notes for the next agent

- The phantom-ref CI gate (`check-migrations-applied`) compares migration
  files against `scripts/ci/supabase-schema-manifest.json`. If you apply a
  migration via the Supabase MCP, regenerate the manifest IN THE SAME PR
  (`node scripts/ci/gen-schema-manifest.mjs`, creds in the canonical clone's
  `.env`) or CI fails exactly the way #1398's first run did.
- `fn_join_club`'s owner branch still skips the count on purpose — the
  triggers are the enforcement now; do not add a second copy there.
