# One owner per setting, and a sit-out clock a player can see

2026-08-29, second pass. The first pass closed the four items section 6 of the
2026-08-28 handoff had already identified. This one is what a line-by-line audit
of the whole settings surface and the whole sit-out lifecycle turned up
underneath them.

Almost everything below is one shape, repeated: **a preference with two
persisted copies, free to disagree, with the winner decided by whichever code
path happened to run last.** Every one of them reads to a player as the app
ignoring them.

---

## A. Settings

### A1. Hydration was guessing which settings the account had chosen

`src/hooks/useTableSettings.ts` · migration `20260829125943`

Every column on `user_table_settings` is `NOT NULL` with a default, so a stored
value equal to the default is indistinguishable from a value nobody ever set.
Hydration had to guess, and guessed:

```ts
const serverChose = serverValue !== DEFAULT_SETTINGS[key];
```

Correct exactly half the time. Worked example, all shipped behaviour:

1. On a laptop the player turns the ticker **off**. Row: `show_ticker = false`.
2. On their phone they turn it back **on**. `true` is also the column default.
3. They open the laptop. The row's `true` reads as "the account never had an
   opinion", so the laptop pushes its own stale `false` back **up** and the
   ticker turns off again — on both devices.

Nobody touched a control. It applies to every setting whose ON state is the
default: sound, bet-size presets, auto-post-blinds, confirm all-in, auto-muck,
four-colour deck. `auto_muck_explicit` exists because somebody hit this already
and solved it for exactly one column.

**Fixed by recording the fact of the choice.** New `settings_touched text[]`
column plus `fn_mark_table_setting_touched(text[])` — `SECURITY INVOKER`,
scoped to `auth.uid()`, whitelisted against the table's own catalog. Both hooks
call it after a successful write; hydration reads it instead of comparing.
Backfilled from divergence-from-default, which is precisely what the old code
inferred, so no existing user's behaviour changes on the day it lands.

Applied to production, self-assertions passed, both existing rows backfilled.

### A2. PostgREST returns `numeric` as a string, so animation speed reset itself on every sign-in

`animation_speed` is a `numeric` column (verified against the live schema), and
PostgREST serialises `numeric` as a string — this repo already documents that
for `tables.small_blind` ("384000.00", never 384000). So `"1" !== 1` was
**always** true and:

- the carry-up branch could never run for it;
- `merged.animationSpeed` was set to the **string** on every hydrate, so a
  player who had chosen Slow on this browser had it reset to normal at the login
  screen;
- the string was then written to localStorage and re-merged forever, violating
  the declared `animationSpeed: number` at runtime.

Now coerced on the way in, against the **type of the default** rather than a
list of column names, so a column that becomes numeric later cannot reintroduce
it.

### A3. Sound, haptics and volume had four, three and two owners

| Preference       | Copies before                                                                                                         | Owner now                                            |
| ---------------- | --------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| Sound on/off     | `ca_sound_enabled`, `club_arena_sounds`, `TableUserSettings.isSoundEnabled` + column, `useSettingsStore.soundEnabled` | `utils/soundGate` (two keys, fails closed on either) |
| Haptics          | the gate's two keys + `useTableSettings.isHapticEnabled`                                                              | `utils/vibrationGate`                                |
| Master volume    | `useTableSettings.soundVolume` + `SoundService.restoreStoredConfig`                                                   | `useTableSettings.soundVolume`                       |
| Four-colour deck | `useTableSettings.fourColorDeck` + `useSettingsStore.fourColorDeck`                                                   | `useTableSettings`                                   |

The consequences, each verified in the source:

- **The in-table Sounds switch could read ON while the app was muted, and the
  first press did nothing.** React state seeded from `ca_sound_enabled` alone
  while the engine seeded from the two-key gate. A player muted in Settings has
  `club_arena_sounds='false'` and often no `ca_sound_enabled`, so state said
  `true`. Effects run in declaration order, so the persist effect wrote
  `'true'` from that stale state _before_ the mount effect wrote it back to
  `'false'`. First press computed `!true = false` and muted something already
  muted: **two presses to get sound back**, with the badge lying throughout.
  The 2026-08-27 fix had corrected the engine seed and left the state seed.
- **Turning vibration ON at the table could not un-mute it.** The setter wrote
  only `ca_vibration_enabled`; the gate fails closed on `vibrationsEnabled` too,
  and nothing here ever cleared it. The identical bug on the sound side was
  fixed on 2026-08-27 and the haptic twin was left. Now persists through
  `setVibrationAllowed`, which writes both.
- **`applySideEffects` stamped `vibrationsEnabled` on every table mount.** It
  runs on the _first_ `getSnapshot()` — the first render of any TablePage,
  SettingsPage or TournamentStartingTicker. Mute haptics in the hamburger menu
  while no consumer of the store is mounted, and the next table mount wrote
  `'true'` straight over it. Removed; the store now writes gate keys only on a
  real user change, via `applyGateChanges` in `commit`.
- **Cross-device sound sync was a no-op.** `isSoundEnabled` was persisted,
  mirrored to a column and relayed by PostgresSyncHooks with **nothing** reading
  it back to the audio engine. Muting on a phone updated a database column and
  left the laptop playing. `applyGateChanges` runs from `commit`, so it covers
  every route: local toggle, `updateSettings`, reset, cross-tab echo,
  cross-device relay.
- **`SoundService.restoreStoredConfig` read a key nothing has ever written.**
  `sp_sound_settings` appeared exactly once in the entire repository — in that
  read. The component its doc-comment names as the shape owner does not exist.
  So it was a no-op that read as working code, _and_ a second writer of master
  volume at boot, racing `TablePage`'s effect. Removed; volume follows the store.

### A4. Two controls that could not do anything

- **"Auto-Muck My Winning Hand" on /settings.** The show-or-muck prompt it
  governs has been behind `const ASK_TO_SHOW_ON_UNCONTESTED_WIN = false` since
  2026-08-23, on Dan's ruling. Flipping the switch wrote localStorage, the table
  blob **and** the `auto_muck_winners` column, said "Settings saved!", and
  changed nothing that exists. Control and column write removed; the column
  itself stays, because removing a control must not drop a stored value.
- **The tab-bar Vibrations item emitted `setting: 'vibrations'`** — not a key of
  `DEFAULT_SETTINGS`, not a column in `COLUMN_FOR_KEY`, not a key of
  `DEFAULT_USER_TABLE_SETTINGS` — so every store dropped it. The phone did stop
  buzzing, but no store learned about it and the /settings switch kept showing
  the old value. The identical bug on `TOGGLE_SOUNDS` was fixed the day before
  and this branch was left carrying it. Routed through `updateSetting`.

### A5. Smaller, all certain

- `pushKeyToServer` used `.then(onFulfilled)` with one argument. A PostgREST
  builder **rejects** on transport failure, so every settings change made
  offline was an unhandled rejection and reached telemetry through neither
  branch — `reportError` sat on the path never taken.
- `useUserTableSettings` had no equivalent of the sister hook's `locallyTouched`
  guard, so a row read in flight could undo a toggle made while it was in
  flight — writing the old value to the cache and to `ca_ws_mux` too. The
  in-flight de-duplication _widens_ that window rather than closing it.
- Both of that hook's read failures were `console.warn` only. An RLS regression
  or a dropped column would have produced zero telemetry and a UI quietly
  serving defaults.
- `rawSetting in DEFAULT_SETTINGS` walks the prototype chain, so
  `'constructor'` passed the whitelist. Now `hasOwnProperty`.
- `setVibrationAllowed` was the one function in either gate file with no
  `try/catch`, and its only caller runs inside a MasterBus subscriber — in
  private mode the throw escaped into a bus dispatch.
- `settingsBridge.DEFAULT_SETTINGS.soundVolume` was **80**; the store, the panel
  and the column all say 70, and that column's `COMMENT` says the client and DB
  "MUST agree". Masked on the normal path, but `validateSettings` falls back to
  it for any stored blob that fails validation, at which point Save raised the
  player's volume by 14%.
- `fromTableSettings` → `toTableSettings` was lossy for `animationSpeed: 2`
  (three labels, four values), so opening /settings and pressing Save changed a
  2 into a 1.5 without the user touching the control. `toTableSettings` now
  takes the current settings and preserves an unchanged selection.
- `useSettingsStore` lost `soundEnabled`, `fourColorDeck`, `notificationsEnabled`
  and their three toggles: zero call sites, zero readers, and a fourth/third
  persisted copy of preferences owned elsewhere.

---

## B. Sit-out lifecycle

### B1. The five-minute deadline was invisible

The rule has been enforced since `table_seats.sit_out_at` shipped, and **no
client surface showed it**. The seat badge, the spectator footer and SitOutModal
all rendered static text. A cash player had no way to know they were thirty
seconds from losing their seat and being cashed out.

`SitOutModal` even _received_ `sitOutSince` and dropped it — an earlier fix had
rightly removed a countdown that was a lie (hard-wired to 300, never updated,
against a deadline that genuinely did not exist at the time), and nothing
replaced it once the deadline became real.

New `src/lib/sitOutDeadline.ts`, mirroring `DisconnectEngine.SITOUT_MAX_MS` and
pinned by `sitOutDeadlineMirror.test.ts` — the same arrangement as
`cashBuyInMirror.test.ts`, and for a sharper reason: this number is shown to a
player whose seat and stack are on the line, so a client copy that drifts from
the engine's is the same lie the deleted component told, with a different value.

Wired into the SitOutModal and the spectator footer bar. Both say **"up to"**,
because the real rule is "2 orbits or 5 minutes, whichever comes first" and the
orbit half is engine state no client can see — a player evicted early must not
be able to point at a countdown that promised them longer. Tournaments, spins
and heads-up get no clock at all rather than one that never fires. The 1 Hz
interval runs only while a deadline is genuinely live, and re-reads `Date.now()`
each tick so a throttled background tab shows the truth when it comes back.

### B2. The SITTING OUT badge overflowed on mobile, and its test could not see it

`SeatSlot.css` carried **two** `.seat__sitout-badge` rules at identical
specificity, ~2600 lines apart. The later one won, and it dropped `max-width`
and added `white-space: nowrap` — so on a 375px phone, where a seat is 58-66px
wide, the badge overflowed onto its neighbours. The documented mobile-first rule
never applied.

The guard could not see it: `sliceCssRule` is `css.indexOf(selector)` — **first
match** — so `sittingOutTagIsVisible.test.tsx` asserted `max-width: 100%` and
`pointer-events: none` against the rule the browser was ignoring, and passed for
as long as the bug shipped. It now pins that the selector is declared exactly
once, which is the property that actually protects it.

Gone with the duplicate: `animation: pulseSitOut 2s infinite alternate` on an
element carrying no `data-motion="keep"`, which `reducedMotion.css` collapses to
1ms — an infinite 1ms alternate between two opacities is a flicker, not a
reduced-motion fallback.

### B3. Dead code, dead emits, silent refusals

- **`SitOutToggle.tsx` + `.css` deleted.** Confirmed unreferenced repo-wide: no
  import, no JSX use, no barrel export, no test, no route. It rendered a fake
  "Auto-Remove In" countdown from a hardcoded `autoFoldAt = 300` with no link to
  the engine constant — exactly the lie B1 exists to avoid.
- **`masterBus.emit('SEAT_LEFT', …)` removed.** Repo-wide, `'SEAT_LEFT'`
  appeared in three places: that emit, the event-name union and the payload
  type. Nothing subscribed. A no-op that read as a fan-out.
- **The SITTING OUT badge now clears for everyone when a seat is released.** The
  handler was gated on `d.user_id === userId`, so every _other_ client kept
  rendering the badge over an empty seat until something re-read the roster.
- **The SitOutModal's "I'm Back" refusal was silent.** It called `reportError`
  and stopped: the modal stayed open, the player stayed sitting out, nothing on
  screen changed and nothing was said — on the one surface a sitting-out player
  is looking at, with a deadline running. Every other sit-out entry point in the
  app toasts. This one now does too.
- **Two `.catch(() => {})` on `markSeatAsLeft`** — the fallback after
  `atomicCashout` throws, on both the eviction and busted paths. `seat_left` has
  already been broadcast by then, so a silent failure means every client has
  cleared a seat whose row is still occupied: a ghost seat blocking a paying
  player, with nothing anywhere to say so.

### B4. The client's one-hand gate refused players the engine would have allowed

`TablePage.handleSitOut` carried its own copy of "you must play one hand first",
and it diverged from the server's in two ways — both refusing legitimate players
_before the request ever left the browser_:

1. **No tournament exemption.** The engine deliberately exempts tournaments (a
   late-registered entrant has not been dealt in yet and has an obvious reason
   to sit out). This gate was unconditional.
2. **The wrong oracle.** `handsPlayedRef` is a `useRef(0)` incremented on
   `HAND_COMPLETED` and not persisted across a page load. Reload the tab and a
   player who had been at the table all night was told to play a hand first.

It was also the only entry point with a local copy — MultiTablePage and the
settings-panel toggle went straight to the engine, so the same player could sit
out from the tab bar and not from the table menu.

Removed. The gate is the server's alone: its refusal is already exact, already
Title Case, and already surfaced verbatim. A narrower local copy was considered
and rejected — any version that lives here can be wrong in a way the engine is
not, and it fails **closed**, so being wrong means silently refusing a real
player.

### B5. Horses are players: a busted horse's seat cleared silently

`recoverBustedSeatedHorses`, at stop-loss, called `markSeatAsLeft` with **no
`seat_left` event**, where the human path immediately above emits one. Both
stand a busted player up for the same reason. But a busted human's seat cleared
on every client the instant the event arrived, and a busted horse's seat cleared
only when a client next happened to diff a snapshot.

That is a tell, and it is the one this file's own comment warns about in the
other direction: _"a felt that clears a busted horse's seat promptly and leaves
a busted human's sitting there is a tell either way round."_ Timing is part of
the treatment (CLAUDE.md 10.5). Same event, same reason, same moment.

---

## Tests

New: `settingsHaveOneOwner.test.ts` (21), `sitOutDeadlineMirror.test.ts` (12).
Extended: `sittingOutTagIsVisible.test.tsx` (the declared-once assertion).

**Updated in this commit, per the house rule** — each pinned behaviour that is
deliberately replaced here, and the old wording is quoted in each file so the
change cannot be read as a weakening:

- `useSettingsStore.test.ts` — four cases pinned that dead code _existed_. What
  replaces them is the assertion that it stays gone, because the risk was never
  that it broke; it was that somebody would wire a switch to `toggleSound`.
- `SettingsPageBridge.test.ts` — `autoMuckWinners` moves from `TABLE_CONSUMES`
  to `TABLE_IGNORES`, where this file's own words say it belonged. One ordering
  assertion was anchored on a whole call's text and became `indexOf(...) === -1`
  when the argument list changed; re-anchored on the call name.
- `rewards-marketplace-honest-redemption.test.tsx` — separate commit, not my
  change: the suite waited on a name the bundled fallback also has, so it
  asserted against the fallback rather than the catalog. It passed on a laptop
  and failed on the 2-core runner.

---

## Still open

- **§6.2 / §6.3 need two real devices.** A1 and A2 are the correctness fixes
  under them; the live soak is not done.
- **The orbit rule needs a product decision, not a code change.**
  `SITOUT_MAX_ORBITS = 2` is compared with `>`, so eviction fires on the third
  increment, and the counter is incremented once per **hand dealt** rather than
  once per button rotation. At a 6-max table a real orbit is ~6 hands, so "2
  orbits" is being enforced as "3 hands" — a sitting-out player at a busy table
  is booted roughly four times sooner than the rule reads. Left alone
  deliberately; put to Dan.
- **The per-seat countdown for OTHER players** would need `sit_out_at` added to
  the engine's seat broadcast. The hero surfaces are done; this is the follow-up.
- **§6.9 still not seen live:** a human evicted at the five-minute mark on a
  cash table, and the 60s buy-in expiry end to end in a browser.

---

## C. The orbit rule now counts orbits (Dan's call, 2026-08-29)

This was listed above as "needs a product decision, not a code change". Put to
Dan, who chose to make the rule mean what it says.

`SITOUT_MAX_ORBITS = 2` was wrong in two independent ways that added up in the
same direction, each fix moving it closer without arriving:

1. **The counter counted hands, not orbits.** Originally it was bumped by the
   dealing loop's own tick — once per hand while dealing and once per 3-second
   idle tick while not — so on a quiet table "two orbits" became about nine
   seconds. The 2026-08-28 fix moved it to the deal and its comment said "an
   orbit is a hand". It is not: at a 6-max table an orbit is about six hands.
2. **The comparison was `>`, against a constant named MAX.** So eviction fired
   on the **third** increment, not the second.

Together: "removed after the button passes them twice" was being enforced as
three hands — a player removed roughly **four times sooner** than the rule they
were told, on a busy table.

The correct signal was already being computed one line away, for time-bank
refills: `prevButtonSeat > 0 && dealerSeat <= prevButtonSeat` is a genuine
button wrap. The counter now rides it, and the comparison is `>=`. Two orbits
means two orbits, which at 6-max is roughly twelve hands — so the five-minute
half is usually the one that fires, which is the rule as Dan states it, and the
half a player can now see counting down.

`LeaveAndSitOutEviction.test.ts` updated in the same commit. Its own title —
"evicts once the button has genuinely passed twice" — already disagreed with its
body, which asserted three; and the source pin that said "counts the orbit at
the DEAL" is re-aimed at the orbit-complete condition, anchored on the condition
itself rather than a byte offset so the block cannot be quietly re-pointed at
the deal again.
