# Table settings follow the user, not the browser

2026-08-28 — agent/cowork-claude/feat/settings-follow-the-user

The second half of Dan's rule. The first half — one shared store, so every table
and page in a browser agrees — shipped in #1686.

> "WHEN YOU DO TURN THINGS ON OR OFF IN THE TABLE SETTINGS, THEY NEED TO SAVE
> GLOBALLY IN REAL TIME ON ALL TABLES, AND ALL PAGES. AND NEVER REGRESS OR AUTO
> CHANGE BACK UNLESS THE USER CHANGES THEM MANUALLY."

---

## What was still wrong

Every setting on the Table Settings panel lived in one **unscoped localStorage
key**, `club-arena-table-settings`. Per browser, not per user:

- sign in on a phone and none of your settings are there;
- two accounts on one machine share one blob, so signing in as somebody else
  inherits their table;
- clearing site data loses the lot.

Two of the panel's controls (`show_stack_in_bb` and the nested V8 toggles)
already lived on `user_table_settings`. The other fifteen did not.

## The move

`supabase/migrations/20260828230000_table_settings_follow_the_user.sql` adds
fourteen columns to `user_table_settings` — already per-user (PK `user_id`, RLS
`auth.uid() = user_id`) and, checked against the live system rather than the
migration history, **already in the `supabase_realtime` publication**. So
`PostgresSyncHooks`'s existing subscription carries a change to a second device
with no new transport; the columns only had to be added to its relay list.

`showTicker` is the fifteenth and needed no column: `show_ticker` was already
there. **Until today that column and the localStorage blob were two owners of
one setting** — its own quiet way for a value to change back. There is one owner
again.

Deliberately NOT moved: `showHUD` and `autoRebuy` (no control renders them), and
`showStackInBB`, which `useUserTableSettings` already owns. A second writer is
the bug, not the fix.

localStorage is kept as the offline cache and the signed-out store, which is
what makes a cold load and a never-signed-in player behave exactly as before.

## The hazard, and why every default is asserted twice

The save path is a **per-key upsert**, matching how `useUserTableSettings`
writes the same table:

```ts
upsert({ user_id, [column]: value }, { onConflict: 'user_id' });
```

For a user with **no row**, changing any ONE setting inserts the row and every
OTHER column takes its SQL default. That is not hypothetical — it is documented
at length in `tests/user-table-settings-defaults.test.ts`, where `card_slide`
and `enhanced_view` were "on since forever, off the moment you touched anything
else".

So each column default is set to the matching value in `DEFAULT_SETTINGS`, and
the pairing is asserted **twice**: once inside the migration at apply time (it
reads `information_schema` and raises if any default disagrees), and once from
the client in the defaults test, which is the half that gets edited.

## Hydration is the dangerous part

It runs while the player may already be using the panel, so a naive "server
wins" would show every setting snapping back a second after login — the
complaint, recreated by the fix for it. Four rules:

1. **A key the user has touched this session is never overwritten.** A switch
   flipped during the second the row is in flight outranks an answer that was
   already stale when it was asked for.
2. **The row wins only where it differs from the column default** — that is the
   signal a value was _chosen_. Anything still at its default leaves the local
   value alone.
3. **A local value the server has never seen is pushed UP.** A returning player
   has real preferences in localStorage and a row full of defaults; overwriting
   the former with the latter _is_ every setting resetting itself on login. This
   is what carries their current settings onto their account the first time they
   sign in after this ships.
4. **An unreadable row is UNKNOWN, never "defaults".** A panel that empties
   itself because one read timed out is worse than one that is briefly
   device-local.

## A failed save never reverts the control

`pushKeyToServer` is fire-and-forget and deliberately does **not** roll the
switch back. The local store and localStorage are already updated, so a lost
write costs the cross-device copy, not the setting. Reverting a control the user
just set because a network call failed is precisely what Dan ruled out.
`useUserTableSettings` still rolls back on failure — that is its existing
behaviour and out of scope here, but it is the shape to watch.

## One more translation

A `SETTINGS_CHANGED` event can name the setting two ways: another **tab** emits
the camelCase key, while `PostgresSyncHooks` relays a row change from another
**device** and names the **column**. Both are the same setting, so the store
translates before matching — without it, cross-device changes would arrive and
be silently discarded.

---

## Verification

- `tsc --noEmit`: client **0**, server **0**
- client vitest: **552 files / 8486 tests** pass
- Migration applied to production; its own default-parity assertions passed at
  apply time.

New: `tests/unit/tableSettingsFollowTheUser.test.ts` (11), plus fifteen
column-pairing cases added to `tests/user-table-settings-defaults.test.ts`.

Three of those specs failed on their first run, all for reasons worth recording:
two asserted a **column name** against `blankNonCode` output, and a column name
is a string literal, which that helper blanks; the third used
`slice(indexOf(...))` with no end, so a negative assertion read the whole rest
of the module and matched somebody else's `commit(`. Both are now bounded by
structure, per `tests/helpers/sourceWindow.ts`.
