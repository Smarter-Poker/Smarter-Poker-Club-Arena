# The countdown was this tab's, not the engine's

2026-08-29, third pass. The second pass shipped a sit-out countdown and a
settings clean-up. This one is what an adversarial audit **of that work** found:
a class with no CSS, a comment describing a feature that did not exist, and one
genuinely dangerous bug in the countdown itself.

Everything here is a defect in code that shipped earlier today.

---

## A. The countdown restarted at 5:00 on every reload

`src/pages/TablePage.tsx`

`sitOutSince` was stamped from the **client's** `Date.now()`, at the moment
_this tab_ first noticed the sit-out. Nothing read the server's clock.

So a cash player who sat out, then reloaded, reconnected, or opened the table in
a second tab at 4:30 elapsed was shown a fresh:

> Your Seat Is Held For Up To **5:00**

and evicted thirty seconds later.

That is the same defect as the hardcoded `300` deleted on 2026-08-16, **with
the sign reversed**: it under-warns instead of over-warning, on the one screen
that exists to tell a player their stack is about to be cashed out. And
`table_seats.sit_out_at` — stamped by a database trigger, built precisely so the
clock survives an engine restart — was already one column away from the poll
that paints the badge.

**Fixed.** The `table_seats` poll (which already runs every ten seconds and on
every realtime change) now selects `sit_out_at`, parses it into a per-user map,
and the hero adopts it. The local `Date.now()` survives only as a provisional
value covering the seconds between the tap and the trigger firing — a sit-out
deferred to the end of the current hand is not stamped until settlement drains
it — so the countdown is never blank. The server value replaces it and can only
ever move the deadline **earlier**, which is the safe direction on a seat about
to be reclaimed.

## B. The badge countdown did not exist, and a comment said it did

The second pass deleted the badge's `pulseSitOut` animation and justified it in
the CSS with:

> "A player sitting out is told so by the badge and, on cash, by the countdown
> in it; it does not also need to blink."

`SeatSlot` rendered a hardcoded `SITTING OUT` string. There was no countdown in
the badge. `sitOutBadgeLabel` had exactly two call sites: its definition, and
the spectator footer.

**Built now**, as new `src/components/table/SitOutBadge.tsx`. It matters beyond
tidying a comment: whether the seat you are waiting on is thirty seconds from
opening, or belongs to a tournament player who is not going anywhere, is the
difference between waiting and finding another table.

Two constraints shaped it:

- **It owns its own interval.** `SeatSlot` is memoised behind a hand-written
  comparator because it renders up to ten times per table and up to six tables
  at once. Passing a number that changes every second would defeat that
  comparator sixty times a minute per sat-out seat, re-rendering avatars, cards
  and chips to move two digits. The parent passes the **stamp**, which is stable
  for the whole sit-out; only the text node re-renders.
- **It takes no `isTournament` prop.** `SeatSlot` carries a standing rule that
  nothing inside it may branch a visual on tournament-ness — the incident behind
  it gave a Spin an inert empty seat and a stack that would not warn at 8bb. The
  parent withholds the stamp instead, so this component has one input and one
  meaning: a stamp is a deadline.

## C. Two classes shipped with no CSS rule at all

`.sitout-modal__deadline` and `.sitout-modal__deadline--urgent` existed only in
the JSX. The line inherited nothing — no size, no colour, no wrapping — and
wedged itself between a green pill and a red one in a `display:flex` bar with
12px of gap to give, on a 375px phone.

Worse, `--urgent` having no rule meant **`isSitOutUrgent` was computed, applied
and invisible**: the entire "shout in the last minute" design shipped as a
no-op. A class with no rule is the quietest possible way to ship half a feature,
so the new test asserts the rules exist for every class these surfaces render,
and that neither urgent rule uses gold, amber or orange.

That last check is written as a **property of the colours** rather than a
blocklist: a first attempt used a hex prefix pattern and failed on `#ffb3ae`,
which is a salmon and entirely correct. Amber and gold are the family where
green sits well above blue; red keeps green and blue close and below it.

## D. Three more holes in the countdown

- **The footer could show the state with no clock.** It renders on
  `seat.status === 'sitting_out' || sittingOutIdsRef.has(userId)`, but
  `heroIsSittingOut` — the only thing that set `sitOutSince` — checked the first
  condition only. In the window the ref exists to cover (the engine's per-hand
  flag is deliberately false for a sat-out tournament player, so the next
  snapshot would otherwise repaint the seat active) the deadline silently
  disappeared. The player under the clock was the one who could not see it.
- **The tick never stopped.** `sitOutMsRemaining` floors at 0 rather than
  returning null, so `sitOutDeadlineIsLive` stayed true forever once expired and
  the 1 Hz `setState` kept re-rendering the whole of TablePage for as long as
  the eviction sweep took to land. Both intervals now clear themselves at 0:00,
  where the label cannot get more urgent and there is nothing to tick towards.
- **The perf comment was inverted.** It claimed storing a timestamp instead of
  the derived number avoided re-rendering the page. `setState` is `setState`
  whatever you put in it. What the timestamp actually buys is correctness under
  a throttled background tab. Corrected, and the renders are bounded by the two
  fixes above instead.

## E. The settings boot hole

`applyGateChanges` runs only from `commit`, and deliberately **not** from
`applySideEffects` — writing the blob over the gate keys on every table mount is
the second-writer bug that silently un-muted people. But that left the opposite
hole: at boot, nothing reconciled the two at all.

Cold load, blob says sound ON (a value synced from another device last session),
gate keys say muted because the player muted from the hamburger menu. The blob
is what the switches _render_, so they read ON while the app is silent — and
`hydrateFromServer` only commits when something changed, so if the server agrees
with the blob nothing ever corrects it.

The gates win, because they are what `SoundService.shouldPlay` and every haptic
call site consult. The blob adopts them on first read — locally, with no push
and no bus emit, because this is not a change the user made, it is this copy
catching up. A genuine cross-device change still arrives the other way, through
`hydrateFromServer → commit → applyGateChanges`. The two directions do not
fight: one runs once at boot, the other only on a value the account chose.

Also here: `isVibrationPreferred()` is new in the gate, because
`isVibrationAllowed()` answers "should we buzz" and returns false on a desktop
with no vibrate API — correct for firing a buzz, wrong for painting a switch. It
replaces two hand-rolled `readBool` calls in `useTableSound` that were a **third
copy** of the gate's two-key rule, and a copy is exactly how the haptic switch
got left behind by the 2026-08-27 sound fix. `readBool` was also fail-OPEN
(`raw !== 'false'` treats `'0'` and `'off'` as ON) against both gates'
fail-closed convention.

## F. The touched-mark RPC could wedge the write queue

`useUserTableSettings` awaits `markSettingsTouched` **inside** its ordered write
queue, so the promise it returns is what the next tap of the same switch chains
behind. `supabase.rpc` on a hung connection never settles — without a ceiling,
one stalled call blocks that switch from ever reaching the server again.
Silently, because the optimistic UI has already flipped; the player sees nothing
until they reload. Now bounded at 8s. Losing the mark costs that one column the
old inference until the next write; losing the queue costs the setting.

## G. Dead code and comments that lied

- **`handleShowBBToggle` deleted.** It had never had a caller — `git log -S`
  puts that back to the commit that added it. The second pass left it in place
  beside a fresh comment claiming it "is still WRITTEN … for older surfaces",
  false in both halves: it wrote nothing because nothing called it, and the same
  commit had just deleted the two reads. `profiles.show_stack_bb` is dead in
  both directions and `user_table_settings.show_stack_in_bb` is the only copy.
- **`showBBEnabled` state deleted.** Written in three places, read in none.
- **`restoreStoredConfig` and its call deleted.** The body became an empty
  method with a 24-line comment; an empty private method invoked from a
  constructor reads as live boot logic. The note about `effectsVolume` above it
  also named a settings panel that does not exist, and is corrected: nothing
  varies it, so it is a constant and the comment now says so.
- **The dead `autoMuckWinners` branch in TablePage removed.** `settingsUpdate`
  comes only from SettingsPanel — three single-key controls plus
  `resetPayload()` — and there is no such control and the key is not in
  `RESETTABLE_KEYS`, so it could never run.
- **The orbit tick's discarded return is explained.** It advances the counter
  and must not act on it: a hand is being dealt, and standing a player up
  between the button moving and the cards going out is the mid-hand removal both
  `evictExpiredSitOuts` and `leaveTable` refuse. The eviction is collected on
  the next between-hands pass.

## H. "Heads-up" was asserted four times and implemented nowhere

Dan's rule names "a MTT, spin or heads up". MTTs are exempt; spins are exempt
because a spin **is** a tournament. But there is no heads-up table type in this
codebase — only a heads-up blind rule inside `HandController` — so a heads-up
**cash** table gets the ordinary five-minute clock on both client and server.

Client and server agree with each other, so nothing is broken; the gap was
between the product rule and both of them, and four fresh comments asserted the
rule as though it were wired.

**Dan's call: leave it on the five-minute clock.** At a two-handed cash table,
exempting sit-out means the other player is stuck at a dead table with their
chips committed and no way to get a hand dealt — worse for them than the
sitting-out player losing a seat. Every comment now states what is implemented.

---

## Tests

New: `tests/unit/sitOutClockIsTheServers.test.tsx` (12).
Extended: `settingsHaveOneOwner.test.ts` (+9, now 28).

**Updated in this commit**, each because it pinned behaviour deliberately
replaced here, with the old wording quoted in place:

- `settingsDoNotChangeThemselves.test.ts` — "does not read the legacy profiles
  column" asserted that `handleShowBBToggle` still _wrote_ the mirror. It
  contained the string, so it passed — for a function nobody called. Asserting a
  write exists inside dead code is the shape of test that keeps a corpse warm.
  Now: the column is untouched, and that is what is pinned.
- `tourneyUxSweep20260825.test.tsx` — same root, re-aimed from the unreachable
  function onto the property that must hold: the canonical column is the only
  one this component touches, the wrong-key bug stays pinned, and no second
  direct upsert may race the ordered hook.

## Still open

- **§6.2 / §6.3 need two real devices.** Unchanged.
- **A human evicted at the five-minute mark on a live cash table has still not
  been observed**, nor the 60s buy-in expiry end to end in a browser. The clock
  the player sees is now the engine's, which is the part that was worth fixing
  before watching it.
