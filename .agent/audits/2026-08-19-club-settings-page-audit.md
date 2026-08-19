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

## Pass 5 — validation, accessibility, mobile

1. **A club could be saved with an EMPTY name.** `clubs.name` is NOT NULL but
   has no CHECK against `''`, and the page had no name validation at all.
   Worse, the delete confirmation compares typed text against the saved name,
   so a blank name made `'' !== ''` false and **armed the Delete Club button
   with an empty input box**. Added `validateClubName` (checks the SANITIZED
   value, so `<b></b>` is caught too), gated every save affordance on it, and
   made the delete button refuse a blank saved name regardless.
2. **Silent text mangling.** Saving strips HTML; the owner watched their text
   change with a plain "Settings saved!". The toast now says when formatting
   characters were removed.
3. **Labels were not associated with inputs** — 9 `<label>` elements, 0
   `htmlFor`. Clicking a label did not focus its field and screen readers
   announced nothing. All fields now have id/htmlFor, plus `aria-invalid` and
   `aria-describedby` on the name.
4. **Toggles were unlabelled buttons** — no `role="switch"`, no
   `aria-checked`, no `type="button"`. A screen reader could not tell on from
   off. All five now expose switch semantics.
5. **The unsaved-changes bar overflowed at 375px** (Working Rule 7 is
   mobile-first): four fixed children, no wrapping, and the field list alone
   reserved 200px. Moved to a real class with wrapping, a viewport-bounded
   max-width, and the field list dropping out below 420px.
6. **`slideUpFade` was never defined.** The bar has always referenced that
   animation; no `@keyframes slideUpFade` exists anywhere in the codebase, so
   it silently did nothing. Defined it — preserving the translateX(-50%)
   centring the element relies on — and disabled it under
   `prefers-reduced-motion`.
7. Character counters on name (50) and description (500), which had hard
   maxLengths and no feedback, so typing simply stopped.

Rake bounds cross-checked against the database: `MAX_RAKE_PERCENT` and
`MAX_RAKE_CAP_BB` are both 10, matching the `clubs_default_rake_percent_range`
and `clubs_rake_cap_range` CHECK constraints (which also allow the -1
inherit sentinel). No UI value can be rejected by the constraint.

Suite: 165 files / 2038 tests passing (baseline 2032 + 6 new).

## Pass 6 — stubs, encoding, disclosure

1. **`CSV_BOM` was a live stub of my own making.** Pass 5 declared it in
   `clubSettingsRules.ts` and never imported it anywhere, so exports still
   carried no byte order mark and Excel rendered every accented player name
   as mojibake. Now wired into the CSV download, with `charset=utf-8` on both
   the CSV and JSON blob types, and pinned by tests.
2. **The download could be cancelled by its own cleanup.** `downloadFile`
   revoked the object URL synchronously after `a.click()` and never attached
   the anchor to the document — both are known to abort the save in some
   browsers. The anchor is now appended and the URL released on the next tick.
3. **`AUDIT_ROW_CAP` was declared after the callback that used it.** The query
   read a `const` defined further down the component body; it worked only
   because the callback happens to run after the render completes. Moved to
   module scope (tsc TDZ error confirmed the same class of mistake in my
   `canSeeAuditLog` edit, which is now declared after `userRole`).
4. **The audit log never disclosed its 200-row cap** and said "No log entries
   found" whether the club had no history at all or the active filter simply
   matched nothing. It now distinguishes the two and shows a
   "Showing N of M entries (newest 200)" summary.
5. **Staff who *can* read the audit log were never shown it.** Pass 3 added an
   `is_club_admin()` SELECT policy on `audit_trail`, but the panel stayed
   `isOwner`-only. Gate now mirrors the policy.
6. Two headings still carried the leading space left by the emoji purge
   (`<h3> Danger Zone>`, `<h3> Delete Club>`).
7. The Data Export blurb promised "club analytics" the modal does not
   produce; it now describes what actually downloads.
8. The Rake Cap hint had no "Currently:" line while Default Rake did.

Slug URLs were considered and deliberately left alone: `resolveClubIdFilter`
maps a non-UUID param through `Number()`, so a hand-typed `/clubs/<slug>/settings`
fails the lookup and lands on the "Failed to load" retry state rather than
anything silent. Every in-app link navigates by UUID (`club.id`), so the path
is unreachable in practice, and widening the shared resolver would touch every
caller across the app for no real-world gain.

Suite: 166 files / 2050 tests passing. eslint: 0 errors.

## Pass 7 — the destructive gaps

1. **Delete Club could cascade-destroy live tables.** `tables.club_id` and
   `club_wallets.club_id` are both `ON DELETE CASCADE` from `clubs`. The
   confirmation said only "all club data, members, and tables will be
   permanently removed" and showed no numbers. Measured on production at the
   time of writing, Midway Union alone would have taken **56 running tables
   and 327 members** with it, plus every club wallet, on one click.
   The modal now loads a real impact snapshot (members, running tables,
   wallet chips) before it arms, lists exactly what dies, and **refuses**
   while any table is running or any wallet still holds chips. If the impact
   check fails, deletion stays disabled — unknown must not read as safe.
   `handleDeleteClub` re-checks before firing, so the guard is not
   button-state-only.
2. **"Private" clubs were not private.** `fn_join_club` reads only
   `requires_approval`; `is_public` merely hides the club from discovery. A
   club switched to private with approval off still admitted anyone holding
   the club code, instantly. Club creation already couples the two
   (`requires_approval = !isPublic`); the settings page did not. Turning
   Public off now also turns Require Approval on, and existing rows already
   in the leaky state get an explicit warning rather than silence.
3. **A logo could be replaced but never removed.** Added a Remove action
   (owner-only, asserts the affected row like every other write here).

Also verified this pass: the Vercel deploy target. The token authenticates as
admin@smarter.poker whose only scope is the **smarter-poker** team
(`team_SVD8r7AOPH065G3usBxVvrBc`), `hub-vanguard`
(`prj_op66GkZyZcygXQKm76iyycfVFAQx`) sits under that team and is linked to
`Smarter-Poker/Smarter-Poker-World-Hub`, and it is the **only** project in the
team bound to that repo — i.e. no recurrence of the duplicate-project
regression in section 1.1 of CLAUDE.md.

### Suite flakiness (pre-existing, NOT introduced here)
`npm test` intermittently fails ~33 files with `TypeError: React.act is not a
function` across unrelated component tests. Same tree, same node_modules: one
run 33 failed / 209 tests failing, the very next run 166 files / 2058 tests
passing. The identical pattern appeared and vanished in pass 5. It is a
test-infrastructure flake under parallel load, not a product defect, but it
will randomly redden CI and is worth pinning separately.

Suite (clean run): 166 files / 2058 tests. eslint: 0 errors.
