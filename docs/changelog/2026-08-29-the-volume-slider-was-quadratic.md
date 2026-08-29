# The volume slider was quadratic, and the deadline was invisible in multi-table

2026-08-29, fourth pass. Three rounds of sit-out and settings fixes have
shipped and are live. This is what a fourth adversarial sweep found — including
one bug that has nothing to do with sit-out and affects every sound in the
product.

---

## A. Every sound was quieter than the number on the slider

`src/services/SoundService.ts`

`createGain` did this:

```ts
gain.gain.value = volume * this.masterVolume * this.effectsVolume;
gain.connect(this.out); // this.out IS masterGain…
```

…and `masterGain`'s own gain is already `masterVolume * effectsVolume`. So
every voice built through that helper was attenuated by **master squared**:

| slider               | what the player heard |
| -------------------- | --------------------- |
| 100                  | 1.00                  |
| **70** (the default) | **0.49**              |
| 50                   | 0.25                  |
| 20                   | 0.04                  |

The control was quadratic — halving the slider quartered the sound — and the
whole app was materially quieter than every value it displayed.

It hid for as long as it did because the other **forty** gain nodes in that file
are hand-rolled and connect to `out` with a raw value, so they were correct.
Sounds made through the helper were quieter than sounds that were not, which
reads as "some sounds are too quiet", not "the slider is wrong".

`createGain` now carries the per-voice amount only. Master and effects are
applied once, by `masterGain`, which is also what `setMasterVolume` writes — so
the live slider still works, in the one place it belongs.

## B. Three of the four sound toggles never reached the store

`TablePage` had four places that called `setIsSoundEnabled` and stopped: the bus
`TOGGLE_SOUNDS` branch, the quick-actions bar, the table menu and the side menu.
Only the settings panel also called `updateSetting`. So muting from anywhere
else left `/settings` and the table panel showing **Sound ON**, and never wrote
`user_table_settings.sound_enabled` — the mute did not follow the account to
another device. The side-menu vibration toggle had the same shape.

Fixed at the source rather than at four call sites: `useTableSound`'s setters
now reach the engine, the gate **and** the store, so every caller is correct by
construction and a fifth cannot get it half-right. That required hoisting
`useTableSettings`' own writer out of the hook as `setTableSetting` — it only
ever touched module-level state, and being trapped inside a hook is precisely
why four surfaces wrote their own half-version instead.

Two raw `localStorage.setItem` calls in the side menu are gone with it. Each
wrote **one** of its gate's two keys, which is the exact failure the gates exist
to prevent.

## C. The hamburger menu was a fourth copy of the gate rule, and a second database owner

Two problems in one component:

- It seeded both switches with its own `readStoredBool` against a **single**
  key each. Both gates fail closed on **either** of their two keys, so a player
  who had muted in-table opened this menu to a Sounds switch reading ON over a
  silent app. `useTableSound` was converted to `isSoundAllowed()` earlier today
  for exactly this reason; this component was not.
- Its profile load wrote `club_arena_sounds` and `vibrationsEnabled`
  **directly** from `profiles.sounds_enabled` / `vibrations_enabled`, bypassing
  `persistSoundPreference` and `setVibrationAllowed` (which write both of each
  gate's keys as a pair) and never calling `soundService.setEnabled`. That made
  `profiles` a second database owner of "is sound on" alongside
  `user_table_settings.sound_enabled`, with nothing reconciling them — so muting
  at the table and opening this menu re-asserted the stale profile value on
  every open. Only the gate's fail-closed rule stopped it actually un-muting
  anyone.

Both switches now read the gates. The columns are still **written** (the
existing mirror for older surfaces); they are simply no longer an input. And
`handleVibrationsToggle` now writes through `setVibrationAllowed`, which its
sound sibling has done since 2026-08-27.

## D. A sit-out deadline was invisible everywhere in multi-table

The whole feature existed only inside a table you were looking at. A player
could tap **Sit Out At All Tables**, start six five-minute eviction clocks, and
no surface outside those hidden tables reported one of them:

- the tab bar's only sit-out UI was a long-press label;
- the dock's urgency — countdown, document title, favicon badge, tick-tock —
  was gated solely on `isMyTurn`;
- and the 1 Hz clock that drives all of it only ran while a turn, a decision or
  a time bank was live. A sat-out player has none of those, so **the most
  important clock on the page was the one that stopped.**

Now: the owning table reports `sitOutDeadlineMs` upward, the tab renders
`SEAT / 0:47` in the same slot TIME BANK uses (precomputed by the parent, like
every other countdown on that bar — it has no clock of its own and should not
grow one), the last minute turns red, the dock treats an imminent eviction as
urgent once it is inside that minute, and the tick keeps running while a
sit-out is live. The toasts say what was actually started: _"Your Seat Is Held
For Up To 5 Minutes"_ on cash, _"You Will Be Blinded Off"_ on a tournament.

The turn still outranks the seat when both are running — it is the shorter fuse
by an order of magnitude — and the seat only competes inside the last minute, or
a sat-out player would sit in a permanently urgent dock for five minutes.

## E. The two "I'm Back" buttons undid different amounts

The footer cleared the ref, the next-hand flag and the seat status; the modal
cleared two of six things. And **neither** cleared `heroSitsOutPerRow`, which
only the ten-second poll writes. So for up to ten seconds after tapping I'm
Back:

- the Settings panel's "Sit Out Next Hand" switch still read ON;
- after the _modal's_ button specifically, the footer still rendered
  _"You Are Sitting Out. Up To 3:42"_ with a live clock.

One `clearLocalSitOutState`, used by both.

## F. A screen reader was never told the seat was about to be taken

`TablePage` gives `aria-live` to the bomb-pot scoop banner, the run-it-twice
strip and the insurance bar. The sit-out countdown had none, on any of its three
surfaces. One live region now, on the hero's own footer label — not on the seat
badges too, or a table with three sat-out players would read the same sentence
three times a second.

## G. The clock edge cases

- **A device clock behind real time silently deleted the countdown.**
  `sit_out_at` is `now()` on the _database_, so a slow device makes every server
  stamp look future-dated, and the previous rule returned `null` for any
  negative elapsed. That device lost the badge clock, the modal line and the
  footer clock — completely silently — while a real eviction timer ran against
  them. A small negative is now treated as "just started" (the deadline is then
  at worst a few seconds late, which under-promises: the safe direction);
  `null` is kept for a stamp far enough ahead that the clock is genuinely
  unusable.
- **No in-flight guard on sit-out / sit-in.** Rapid out → in → out issued three
  independent `POST /sitout` with no ordering guarantee while every one updated
  the UI optimistically, so the client could settle showing "sitting out" over a
  server that had the player in the game, being dealt in and blinded.
- **The read that owns the eviction clock was the only read in the file with no
  telemetry.** Its two neighbours report; this one — which drives the countdown,
  the SITTING OUT tags and the boot notice — swallowed everything.

## H. Dead code, and comments describing code that is not there

- `masterBus.emit('SEAT_TAKEN', …)` — no subscriber, anywhere. The identical
  shape was condemned one `case` below for `SEAT_LEFT`, whose emit was removed
  this morning while this one was left.
- `FLASH_SIT_OUT` — declared in the bus union and the payload map, never emitted
  and never subscribed. Kept, now labelled.
- `@keyframes slideUp` in `SitOutModal.css` — unused there, and CSS keyframe
  names are a **global** namespace: `slideUp` is separately defined in six other
  files. A dead copy is not just dead weight, it is a silent participant in
  whichever of those actually renders.
- `showLeaveConfirm` in `SitOutModal` — never set true, never read, guarded by a
  ten-line comment describing a two-step Leave confirmation that is not in the
  component, reset by an `onClose` whose only route in is an overlay click that
  cannot fire (`pointer-events: none`).
- `tableName` — accepted, destructured, passed in, rendered by nothing.
- Two comments asserted that an explicit Sit Out tap "adds the hero to this set
  directly and is unaffected" by the 15-second fresh-join grace. `handleSitOut`
  does not write that set at all, so a tap **is** covered by the grace. The
  comments are the load-bearing part: they are what a future reader trusts.
- `heroTabSittingOut` used one of the two conditions the footer uses, so the
  multi-table long-press menu could offer "Sit Out" on a table where you were
  already sitting out.
- The footer built its wording with `.replace('Sitting Out', 'You Are Sitting
Out')` — string surgery on the output of the one function that exists so two
  surfaces cannot word the same rule differently. It takes a `subject` parameter
  now.
- `SoundService`'s category API (`setCategoryEnabled` / `setCategoryStates`) has
  no callers, so `categoryEnabled` is permanently all-true and the ~40 category
  arguments threaded through that file feed an unreachable branch. **Kept** —
  the gate is correct and a per-category control is plausible — but labelled, so
  nobody assumes it is wired.
- Master volume had **four** writers behind a comment claiming it had one. Three
  removed; the comment is now true.

---

## Tests

New: `tests/unit/soundIsAsLoudAsItSays.test.ts` (9).
Extended: `sitOutClockIsTheServers.test.tsx` (+10, now 25).
Updated: `sitOutDeadlineMirror.test.ts` — the "a future stamp is unknown" case
becomes "a stamp slightly in the future is clock skew, and still counts down",
with the old wording quoted in place and a second case pinning that a stamp far
enough ahead still yields nothing.

## Still open

- **§6.2 / §6.3 remain the two-device items.** Unchanged.
- **A human evicted at the five-minute mark on a live cash table has still not
  been observed.** Every clock the player sees is now the engine's, on every
  surface; the observation is the last step and it needs a human on a cash seat.

---

## Round 4b: ten findings from auditing round 4 before it merged

Every round today has shipped a defect the next round found. This one was
audited before merging instead, and the audit earned its keep.

**The one that mattered.** The HamburgerMenu gate-seeding fix in §C was **undone
five lines later**. The lazy `useState` seeds from `isSoundAllowed()`; the mount
effect below it read `STORAGE_KEYS.SOUNDS` — one of the gate's two keys — raw
and unconditionally, overwriting the correct seed on mount. So in the exact case
the new comment describes (`ca_sound_enabled='false'`,
`club_arena_sounds='true'`) the switch survived one render and went back to
reading ON over a silent app. A fix undone by the code immediately after it is
indistinguishable from no fix. The effect re-reads both gates now.

**The dock would have pinned itself urgent forever.** `isSitOutUrgent` is
`ms <= 60_000` with no lower bound, so once a deadline passed the value only got
more negative and stayed "urgent" — favicon badge and tick-tock included —
contradicting the note directly above it claiming the design avoided exactly
that. The fix is _not_ to bound the helper: it is the **styling** predicate, and
a badge must stay red at 0:00 when the seat is at its most at-risk. The `> 0`
belongs at the dock, which renders a countdown and cannot count towards a
deadline that has passed. It is there, with the reason.

**The in-flight guard covered two of the four entry points its comment claimed.**
`TableModalsLayer` issued its own `setSitOut(tableId, false)` — a second
implementation of "sit back in", unguarded — so the race was still reachable by
alternating the modal's I'm Back with the table menu's Sit Out, and the two
buttons' cleanup and failure toasts were free to drift apart. There is one
`handleSitBackIn` now; the modal reports the intent and no longer imports
`GameServerAPI`.

**The tab report omitted two of its own inputs.** The effect sent
`sitOutDeadlineMs` and `isTournament` but listed neither as a dependency.
`heroTabSittingOut` covers the true/false edges — but not the case the report
exists for: a quiet table where the deadline arrives, or the poll corrects it,
_after_ the flag has flipped. The multi-table countdown would never have learned
it, and a stale deadline could persist.

Also fixed: an unused `sitOutBadgeLabel` import; a dead `sitOutTick` dependency
on a memo whose value is algebraically constant; two dependencies left behind by
the one-hand gate deleted in an earlier round; a comment claiming
`.sitout-overlay`'s dead `onClick` was `onClose`'s "only route in" when
`handleReturn` and `handleLeave` both call it, and that the reset fired from
`onClose` when it fired from an `isOpen` effect; a "the effect below" that was
above; and `setTableSetting` not calling `attachBusOnce()`, which left two doors
into one store behaving differently.

**And the test guard caught me.** My new assertion used
`deps.slice(0, 400)` — the magic-number source window that
`tests/unit/noFixedSizeSourceWindows.test.ts` exists to forbid. It went red on
the first full run. Re-bounded on the dependency array's own closing bracket.

Verified clean by the same audit: the `createGain` fix and the entire signal
graph (all 53 nodes route through `masterGain`; `ThrowableSoundService`,
`PremiumSFX` and `ThrowableVoice` each apply master exactly once on their own
graphs), the `setTableSetting` hoist with no import cycle, every
`SETTINGS_CHANGED` subscriber checked for loops, `handleSitOutAll`'s index
alignment, and all TablePage declaration ordering.
