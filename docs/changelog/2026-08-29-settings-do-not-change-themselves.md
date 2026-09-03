# Settings do not change themselves

2026-08-29. Four ways a Club Arena setting could change without the user
touching it. All four come out of section 6 of the 2026-08-28 sit-out handoff,
and all four are the same rule:

> Dan, 2026-08-28, binding: "WHEN YOU DO TURN THINGS ON OR OFF IN THE TABLE
> SETTINGS, THEY NEED TO SAVE GLOBALLY IN REAL TIME ON ALL TABLES, AND ALL
> PAGES. AND NEVER REGRESS OR AUTO CHANGE BACK UNLESS THE USER CHANGES THEM
> MANUALLY."

Each was invisible in use — no error, no console entry — which is why they
survived. A setting that flips back looks like the app disagreeing with you.

---

## 1. A failed write flipped the control back (was §6.1, HIGH)

`src/hooks/useUserTableSettings.ts`

A refused or timed-out upsert ran a rollback block that rebuilt the OLD value
into React state, into `localStorage`, and onto the bus — so one dropped
request undid the switch on the panel the user was looking at **and on every
other open table**. `toggleSetting` did it with no toast at all: just a
`reportError` the user never sees.

The sister hook `useTableSettings`, which writes the same `user_table_settings`
row, had already been fixed the other way on 2026-08-28 — its `pushKeyToServer`
is fire-and-forget and its comment says it "deliberately does NOT roll the
switch back". So the two hooks disagreed about the same table, and which
behaviour you got depended on which surface you happened to open.

**Now:** retry, then hold, then say so.

1. **Retry.** Up to three attempts (400 ms, 1500 ms backoff) before anyone is
   told anything. Most lost writes never reach the user.
2. **Hold.** If all three fail, the optimistic value stays — on screen, in
   `localStorage`, on the bus. What is lost is the cross-device copy, not the
   setting.
3. **Say so.** One toast through the Toast layer, so the user knows the choice
   is device-local rather than believing it synced. Identical toasts dedupe, so
   a burst of failed writes cannot stack popups (CLAUDE.md §5.7).

**A superseded write stops retrying.** If the user taps again while attempt two
is in flight, the newer revision owns the column and the older one abandons
without a word — re-writing the older value is the auto-change-back this whole
change removes, just arriving late. `persistSettingColumn` checks
`stillCurrent()` before each retry and returns `superseded`, which emits no
terminal state because the newer mutation emits its own.

`CUSTOMIZATION_MUTATION_STATE` gains `save-failed`, which is terminal but is
**not** a rollback. Both existing subscribers (`useUserTableSettings`,
`useHeaderDataStore`) clear pending state on any non-`pending` state, so both
were already correct for it.

`durableValueRef` and `pendingWriteCountRef` are deleted. Their only purpose
was reconstructing the value a failed write would be reverted TO; with no
rollback they had become write-only — dead code that reads like live code.

## 2. Two callbacks raced the BB switch (was §6.6)

`src/components/navigation/HamburgerMenu.tsx`

The menu read the preference twice: `profiles.show_stack_bb` (legacy) inside
the profile query, and `user_table_settings.show_stack_in_bb` (canonical) in a
second query added on 2026-08-25 to make the canonical one win. Both wrote
`setShowBBEnabled` and both wrote the same `localStorage` key, from unordered
`.then()` callbacks. Whichever answered last won, so the legacy value could
still land on top — the exact disagreement the 2026-08-25 fix was written to
end, now decided by network timing instead of by a rule.

Both queries are gone. `useUserTableSettings` is already mounted in this
component and already reads that column on a request de-duplicated across every
consumer in the tab; the effect beside it is now the only writer of the state
and of the `localStorage` seed. It waits for `tableSettingsLoading` to clear
first — writing the hook's defaults over the seed would show a cold-open user
chips for a moment and then persist that as their answer.

The legacy column is still **written** by `handleShowBBToggle` for older
surfaces. A mirror is fine; a second opinion is not.

## 3. Reset To Defaults un-sat-out the player (was §6.7)

`src/components/table/SettingsPanel.tsx`

`handleReset` sent the whole `DEFAULT_TABLE_SETTINGS` object, and TablePage's
`onSettingsChange` acts on any key that is `!== undefined`. Three keys came
along that nobody asked to reset:

- `confirmAllIn` and `autoMuckWinners` — no control on this panel. Their
  toggles were deliberately removed; the values were still written, so the one
  button that promises to restore what you can see silently rewrote two things
  you cannot.
- `sitOutNextHand` — the serious one. It is not a display preference. Sending
  `false` fires a real `setSitOut(tableId, false)` round trip, so **a player
  who was sitting out and tapped Reset To Defaults to tidy up their card
  colours was put back in the game, blinds and all.**

The payload is now built from an explicit `RESETTABLE_KEYS` list via the
exported `resetPayload()`. A new toggle must be added there to be resettable,
which is the right way round: a control you can see is what Reset promises to
restore. `sitOutNextHand` has a control and is still excluded on purpose —
sitting out is a live table action with a server round trip, and restoring
appearance defaults must never seat or unseat anybody.

Same shape as `tests/settings-only-write-what-they-offer.test.ts`, which caught
the equivalent bug in the /settings notifications upsert.

## 4. One browser's preferences were written into another person's account (was §6.4)

`src/hooks/useTableSettings.ts`

`hydrateFromServer` pushes a local value UP when the account row has no opinion
on it. That is the migration path that carries a returning player's existing
`localStorage` preferences onto their account the first time they sign in after
these columns shipped, and on a personal device it is exactly right.

On a **shared** device it was account contamination. Person A mutes sound and
signs out; sound settings deliberately survive a sign-out (`clearUserCaches`
keeps device preferences — "a sign-out is not a factory reset", pinned by
`tests/unit/clearUserCaches.test.ts`). Person B signs in, their row is all
defaults, so every one of A's choices was written into B's **account** and
followed B to their phone. Not a stale local copy: a permanent, cross-device
edit to someone else's settings, made by nobody.

**Dan's call (asked directly, because the obvious fix contradicts a pinned
decision):** keep device preferences on the device across a sign-out; stop the
upward push only.

So the browser now records who owns its settings (`ca_table_settings_owner`).
The upward push is allowed when the browser is **unclaimed** — the pre-existing
blob the migration exists to rescue — or already claimed by the user signing
in, and refused when the values belong to somebody else. The claim is written
on the first hydrate of any user, so the unclaimed window is one sign-in per
browser, which is the smallest it can be while still letting the migration
happen at all.

The key is deliberately **not** in the sign-out purge. `clearUserCaches` is the
obvious home for it and would be wrong: clearing the claim re-opens the window
on every sign-out, which is precisely the case it guards.

---

## Tests

`tests/unit/settingsDoNotChangeThemselves.test.ts` — new, 14 cases, one
describe block per fault above.

`tests/unit/useUserTableSettings.realtime.test.tsx` — **two specs inverted in
this commit**, per the house rule that behaviour you replace gets its test
updated beside it:

- "a rejected optimistic toggle rolls back every mounted table" → "a save that
  fails every attempt holds the value on every mounted table"
- "two rejected rapid toggles return to the last durable value" → "two rapid
  failed toggles keep the SECOND tap, and the first stops retrying"

Both described real behaviour and both described a bug. The old wording is
quoted in the file so the change cannot be read as a weakening. A third case is
added — "a write that succeeds on retry never bothers the user" — because a
recovered blip producing a toast would be its own regression.

Nothing weakened: `tests/unit/tableSettingsFollowTheUser.test.ts` still pins
that `pushKeyToServer` never reverts and that the migration push still exists,
and `tests/unit/settingsEchoOrigin.test.ts` still pins that every
`SETTINGS_CHANGED` carries its origin.

## Still open from the handoff

- §6.2 cross-device soak and §6.3 first-sign-in merge still need two real
  devices. §6.4 above is the merge direction's correctness fix, not its live
  verification.
- §6.5 volume has two competing persisted sources
  (`SoundService.restoreStoredConfig` vs `TablePage` applying
  `userSettings.soundVolume`); whichever effect runs later wins.
- §6.9 the five-minute human sit-out eviction has still not been seen fire
  against a human on a live cash table.
