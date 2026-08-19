# Club Settings page audit — 2026-08-19

Scope: `/hub/club-arena/clubs/<id>/settings` (ClubSettingsPage.tsx and every
control on it). Trigger: report that the page "has no real functionality".

## What was already real (verified on origin/main + prod DB, do not re-fix)

- Rake % / Rake Cap: wired end-to-end since #109 — persists the -1
  "house schedule" sentinel, server clamps in getFullRakeConfig.
- Privacy toggles: read by ClubDiscovery / join flows / InvitePage.
- Straddle / RIT / Rabbit Hunt: read by ServerTableEngineBase.
- Buy-in limits: validated client-side (BUYIN_BB_FLOOR/CEILING), read by
  CreateTableModal / TableService.
- Save path: client UPDATE on `clubs`, RLS "Owners can update clubs" enforces
  owner-only. Unsaved-changes bar, Ctrl+S, conflict banner all live.
- Delete Club: ClubsService.deleteClub + owner-only RLS delete policy.

## What was dead, and the fix

1. **Admin Activity Log rendered empty forever.** `audit_trail` had the
   owner SELECT policy (20260428000001) but ZERO writers for club admin
   actions: the settings save is a direct client UPDATE, the masterBus
   'ADMIN_ACTION' emit has no persistence listener, and the planned ops-API
   never materialized for this surface. Prod counts at audit time: 1 row
   total, 0 with a club_id.
   **Fix (applied to prod via Supabase MCP, version 20260819160430):**
   `supabase/migrations/20260819_audit_trail_club_settings_triggers.sql` —
   SECURITY DEFINER triggers write the log from the database itself:
   - clubs AFTER UPDATE -> 'update_club_settings' with before/after diff of
     exactly the 11 settings-page columns; early-exit when auth.uid() IS NULL
     (engine/service writes) or when no watched column moved.
   - club_members AFTER UPDATE OF role,status / AFTER DELETE ->
     'role_change' / 'banned' / 'unban_member' / 'member_status_change' /
     'kick_member' / 'member_left'.
   Verified with an in-transaction test as the Midway Union owner
   (47965354-…): row inserted with actor_role 'owner' and clean diff; test
   rolled back, prod data untouched.

2. **"Export Club Stats" did not export club stats.** It exported the
   caller's own hand rows platform-wide (hand_history RLS caps reads at
   own hands; no club scoping), and the "Include hand histories" checkbox
   was read by nothing. Fix: StatsExport.tsx now offers "Member stats"
   (club_members roster + lifetime aggregates, staff-readable via RLS) and
   "My hands" (own hands scoped to the club's tables), removes the dead
   checkbox, and neutralizes CSV formula injection.

3. **AuditLog rendered the wrong detail line for settings rows** (it fell
   through to meta.description — i.e. printed the club's new description
   text) and rendered a bare uuid fragment for club-target rows. Fixed in
   AuditLog.tsx.

4. **Non-owners saw a page of silently disabled controls** with no
   explanation — indistinguishable from a broken page (likely the source of
   the "no functionality" report when viewed from a non-owner account; the
   club owner is daniel@… / 47965354, not smarterpoker45@…). The page now
   says it is a read-only view.

## Deferred / follow-ups

- Save currently navigates away to the club page; consider staying put.
- audit_trail read policy is owner-only; extend to club admins if/when the
  admin role ships in club_members.

## Pass 2 (same day) — line-by-line re-audit findings

Bugs found and fixed in this pass:

1. ClubSettingsPage load effect depended on [clubId] only; useAuthUser
   hydrates async on a cold load, so the owner check could run with
   user=null and the OWNER got a fully read-only page until a background
   refresh. Deps now include user?.id.
2. The masterBus subscribeDebounced handlers receive the BusEvent envelope,
   not the payload — the per-club scoping filter read .clubId off the
   envelope and was a no-op (page refetched on every club's events).
3. Own-save race: the debounced CLUB_UPDATED refresh could land between the
   DB commit and the baseline reset, raising the "settings changed
   elsewhere" banner for your own save — and nothing ever cleared it. Save
   now clears it, re-baselines with the SANITIZED copy it actually wrote
   (baseline previously kept the raw text -> permanent phantom conflict when
   name/description contained stripped characters), and stays on the page
   so the audit log entry it just produced is visible.
4. changedFields memo read originalSettings.current (a ref) — a silent
   rebaseline did not recompute it; added a baselineVersion counter.
5. Save button did no-op writes when nothing changed; now disabled.
6. AuditLog filtered audit_trail.club_id (uuid) with the raw route param —
   integer club-code URLs got 22P02 and an empty log. Now resolves the UUID.
7. StatsExport safeCell (introduced in pass 1) quoted every negative NUMBER
   as a formula-injection risk, corrupting chips_lost etc. Guard now applies
   to strings only. Club-scoped hand export no longer silently widens to
   platform-wide when the club has no tables; exports are capped at 5000
   rows and filenames carry the date.
8. .form-hint was referenced by the page but never defined in CSS.

Enhancements: AuditLog shows old → new diffs (settings, role, status rows)
and subscribes to realtime INSERTs on audit_trail; delete-confirm compares
trimmed names; migration 20260819b (applied, version present in prod) moves
the settings comparison into the trigger WHEN clause so chip_pool /
member_count churn never invokes the function, and lets club admins
(is_club_admin) read their club's audit rows — table stays append-only.

## Pass 3 (same day) — upgrade build-out

- **club-assets bucket did not exist.** CreateClubModal has uploaded to
  storage.from('club-assets') since club creation shipped; every upload
  failed silently and fell back to a data URL. Migration (applied to prod
  as club_assets_bucket_and_policies) creates the bucket: public read,
  2 MB cap, image mime types only, INSERT scoped to club-logos/ for
  authenticated users, UPDATE scoped to the uploader.
- **Club Logo upload on the settings page.** Picked file participates in
  the normal unsaved-changes/discard flow; uploaded on Save to
  club-logos/<club-uuid>-<ts>.<ext>; logo_url saved with the row and now a
  WATCHED audit column (verified with a rolled-back trigger test).
- **Club Code row** in Basic Information with copy-to-clipboard — the
  6-digit clubs.club_id was displayed nowhere on the admin surface.
- **delete_club is now audited** (BEFORE DELETE trigger, applied to prod as
  club_delete_audit_and_logo_watch). club_id written NULL deliberately —
  the FK is ON DELETE SET NULL so it would be nulled in the same statement;
  target_id preserves the club uuid.
- **Dynamic rake hint**: the Default Rake field states what the club
  currently does ('Currently: house schedule.' / 'Currently: 3.5%').
- **gps_restricted toggle deliberately NOT added**: the column is read by
  no join gate and no engine code — adding a switch for it would recreate
  exactly the lying-control class the Time Bank removal fixed. Wire
  enforcement first, then surface the toggle.
- Note: prod migration history records pass-3 as two entries
  (club_assets_bucket_and_policies + club_delete_audit_and_logo_watch)
  because the single-transaction version deadlocked against live engine
  traffic on clubs; the repo file 20260819c contains the combined content.

## Pass 4 — deep re-audit of the shipped code

Bugs found in the code shipped by passes 1-3 and in surviving legacy paths:

1. **Silent save failure.** `.update(...).eq(...)` with no `.select()` returns
   NO error when it matches zero rows. Verified against production: a
   non-owner UPDATE on `clubs` is rejected by RLS with 0 rows and no error —
   so if `isOwner` was ever stale (ownership transferred, club deleted, user
   switched) the page reported "Settings saved!" while nothing was written.
   The save now `.select('id')` and throws when no row comes back, and the
   real message reaches the toast instead of a generic string.
2. **A nonexistent club rendered a blank, editable settings form.** When the
   lookup returned no row, the whole `if (data)` block was skipped: no error,
   no state, loading -> false. Added a `notFound` state and a real
   "Club not found" panel.
3. **No club id = skeleton forever.** The fetch effect is gated on `clubId`,
   so reaching the page without one left `loading` true permanently. Now
   renders a "No club selected" state.
4. **Delete confirmation quoted the UNSAVED name.** It compared and displayed
   `settings.name`, so editing the name without saving made the modal demand
   the unsaved text and advertise a name the club does not have. Now uses the
   saved baseline name.
5. **Buy-in fields could not be retyped.** Clamping on every keystroke turned
   a backspaced-empty field into 1000 (or 1) mid-edit. The value may now go
   transiently empty — `validateBuyinRange` already blocks the save and
   explains why — and clamps on blur.
6. **Realtime refetch storm.** The `clubs` UPDATE subscription fired on every
   write to the row, including `chip_pool` (rake waterfall) and `member_count`
   (membership trigger), refetching this page continuously on a busy club. It
   now compares the payload against WATCHED_COLUMNS and ignores churn.
7. **Audit log flashed a skeleton** on every realtime/bus refresh; refreshes
   are silent now.
8. **Audit filter categories missed real actions**: `delete_club` and
   `member_left` matched no category and appeared only under All.
9. **Empty export downloaded a 0-byte file** and claimed success. Now reports
   "No members/hands to export" and the success toast carries a row count.
10. **`.in('table_id', [...1000 uuids])`** builds a ~37 KB URL (414 risk);
    capped to the 200 newest tables, roster export capped at 5000.
11. Pending-logo blob URL leaked on unmount; a logo uploaded just before a
    failed row update was left orphaned in the bucket (now removed).

**Upgrade:** the pure rules (buy-in clamp/validation, watched columns, CSV
encoding incl. the formula-injection guard) moved out of the components into
`src/utils/clubSettingsRules.ts` and are covered by
`tests/unit/clubSettingsRules.test.ts` — 13 tests, each pinning a bug that
actually shipped. Full suite: 2011 passing.
