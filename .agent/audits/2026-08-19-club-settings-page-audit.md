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
