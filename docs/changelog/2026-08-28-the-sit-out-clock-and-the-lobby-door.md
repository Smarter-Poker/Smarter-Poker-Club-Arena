# The sit-out clock never ran, and the corner opened the wrong screen

2026-08-28 — agent/cowork-claude/fix/sitout-and-tourney-lobby

Two requests from Dan, one commit, because the sit-out half touches four layers
and splitting it would have left the database ahead of the engine.

---

## 1. The five-minute cash boot never fired

> "IT WAS SUPPOSED TO BE FIXED THAT A USER CAN ONLY SIT OUT FOR 5 MINUTES,
> BEFORE GETTING BOOTED IN A CASH GAME ... BUT FOR SOME REASON THIS NEVER KICKS
> THE USER OFF THE CASH GAME AFTER THE 5 MIN."

The rule itself was correct and had been since 2026-08-21.
`DisconnectEngine.SITOUT_MAX_MS` is five minutes, `tickSitOutsAndCollectEvictions`
compares against it properly, `evictExpiredSitOuts` is wired into both the
start-up wait loop and the dealing loop, and `cash_tables_needing_engine` gives
an engine to any occupied cash table so even a lone sat-out player is swept.

It never fired because of **three separate holes, each of which hid the others**.

### 1a. The clock lived in process memory

`sitOutSince` was a field on an in-memory `Map`. `is_sitting_out` was persisted;
the clock behind it never was. So `restoreSitOutsFromSeats()` — which runs on
_every pass_ of both loops — called `sitOut()`, and `sitOut()` stamped
`sitOutSince = Date.now()`.

**Every engine restart handed every sat-out seat a fresh five minutes.** A table
whose engine recycled more often than that (a deploy, a lease change,
`killForRestart`, the watchdog) could never evict anybody.

Fixed by `supabase/migrations/20260828210000_sit_out_clock_survives_a_restart.sql`:
a `table_seats.sit_out_at` column, stamped and cleared by a **trigger**
(`trg_stamp_sit_out_at`) on the transition in and out of sitting out. A trigger
rather than eleven callers, because eleven callers is how the in-memory copy
drifted in the first place — the engine, waitlist promotion, late-reg seating and
four spin-lifecycle RPCs all write `is_sitting_out`. The trigger's middle branch
is the load-bearing one: an _unrelated_ UPDATE to the row (a stack change, a
time-bank decrement) must hold the original stamp, or the countdown restarts
every few seconds without a restart being involved at all.

Applied to production and asserted in-migration, including a behavioural probe
(run against a **departed** seat, rolled back in its own subtransaction —
CLAUDE.md 11.5, never spend real chips or touch a live seat to test a rule).

### 1b. `sitOut()` silently refused anyone it had not seen

```ts
const state = this.playerStates.get(key);
if (!state) return; // ← this
```

`playerStates` is populated by `registerPlayer`, which had exactly two callers:
inside `dealHand()`, and inside `restoreSitOutsFromSeats()` — which itself only
runs for a seat _already_ flagged `is_sitting_out` in the database.

A chicken-and-egg deadlock. A player who tapped Sit Out at a table that had not
dealt since the engine booted fell straight out of that guard: no state, no
`PLAYER_SAT_OUT` event, therefore no `is_sitting_out` write, therefore nothing
for the restore to bootstrap from on any later pass, therefore the eviction sweep
skipped them forever. **The HTTP handler still answered `{ success: true }`** and
the client rendered them as sitting out. The seat was held indefinitely.

It bit hardest on a quiet table, which is exactly where a seat held forever
matters most.

`sitOut()` now registers on demand. That is correct rather than merely
convenient: being asked to sit a player out _is_ the proof they are at the table.

The 2026-08-25 work had already found this trap and worked around it in
`restoreSitOutsFromSeats` — but left the _live_ caller (`POST /sitout`) alone,
and pinned "refuses" as correct behaviour in
`RestartFidelity.behaviour.test.ts`. That spec's own comment asked whoever
changed it to say so; this is that note, and the spec is inverted here.

### 1c. A deferred sit-out was dropped when a hand never settled

Sitting out _during_ a hand is deferred into `pendingSitOut`, and that set had
exactly one drain — settlement step 5.9. A hand killed by `HAND_SAFETY_TIMEOUT`
resolves **without running settlement**, and a hand abandoned when the table
drops below the minimum never settles either. The request was silently dropped.

Now swept on the idle tick too, alongside the `processPendingAddOns` and
`processLeavePending` sweeps that exist for precisely this class of orphan.

### What did NOT change

Tournaments. Dan, same message: sitting out is allowed _"AS LONG AS THEY WANT IN
A MTT, SPIN OR HEADS UP (BUT THEY WILL BE BLINDED OFF)"_. `evictExpiredSitOuts`
still returns early on `isTournamentTable()`, which is one predicate covering
MTT, Spin, SNG and heads-up alike. Pinned by a test so it stays that way.

---

## 2. A busted cash seat is now released

> "MAKE SURE THAT THE USER GETS REMOVED FROM THE TABLE AS SOON AS THEY HAVE NO
> CHIPS, AND IF THEY MADE THE MONEY CHIPS GET CREDITED TO THERE ACCOUNT."

There was **no path at all** that removed a busted human from a cash table.
`stack > 0` filtered them out of the deal and that was the end of it — the seat
stayed occupied, counted toward the table's player count and blocked a paying
player, indefinitely, unless the human hit Leave Table themselves. Horses had had
this since 2026-08-15 (`recoverBustedSeatedHorses`); humans never did.

Dan's rule, asked and answered:

> "IN A CASH GAME, CHECK IF THEY HAVE ENOUGH CHIPS TO REBUY, (40 BB MINIMUM). IF
> THEY DO, YOU GIVE THEM THE 5 SECOND PERIOD TO REBUY OR DECLINE ... IN A
> TOURNAMENT, YOU GIVE THEM THE SAME CURTIOUSY ONLY IF THE TOURNAMENT IS STILL
> IN THE REBUY PERIOD."

- **The pause is now earned.** `needsRebuyPause` was an unconditional `true` for
  cash, so the felt stopped five seconds on every bust including the ones where
  the player had nothing to buy in with. It now asks
  `anyBustedPlayerCanAffordARebuy()`. The 40BB floor comes from
  `server/src/config/cashBuyIn.ts`, a mirror of `src/lib/cashBuyIn.ts` pinned by
  `tests/unit/cashBuyInMirror.test.ts` — deliberately not a fifth local answer to
  a number four layers had already disagreed about.
- **`standUpBustedCashPlayers()`** releases the seat through `atomicCashout`, so
  the exit stays off `fn_unaccounted_seat_exits`.
- The tournament branch was already correct (it consults the real rebuy window
  and fails open on an unreadable read) and is untouched.

**Placement is load-bearing, and I got it wrong first.** The obvious home is
beside the rebuy pause at the end of the hand. That is wrong: settlement fires
`postHandTasks` _without awaiting it_ and `postHandTasks` runs `syncStacks`, so
at the end of a hand the busted stack may not have reached the database yet. A
check there reads a stale non-zero stack, skips — and never gets another chance,
because next pass the player is no longer in `activePlayers` to be noticed. It
runs at the top of the loop instead, after `await postHandTasksPromise` and
`loadSeatedPlayers`, immediately beside the horse recovery it mirrors. Same tick,
per CLAUDE.md 10.5: timing is part of the treatment.

**A 0-chip seat is not always a busted seat.** A player who has just sat down and
whose buy-in is still in `table_pending_addons` is legally at zero and has
already been debited. Such a seat is skipped outright, and every other seat must
be seen at zero for `BUSTED_GRACE_MS` (10s) before it is released.

### Tournaments keep one authority

A busted tournament player is **not** ours to remove: they are owed a finishing
place and possibly a prize, both computed by `TournamentManager.eliminatePlayer`
against the set of places still free, which then credits via `fn_credit_and_log`
under an idempotency key. That is the "if they made the money" half, and it
already works. An engine that released the seat first would strand it — the shape
of the 2026-08-20 incident where a tournament disbursed 107% of its pool because
two paths disagreed about who owned a place. `standUpBustedCashPlayers` refuses
tournament tables in its first line, and a test pins that.

---

## 3. "SITTING OUT" is visible to everyone

> "YOU ALSO NEED TO ADD A SITTING OUT TAG THAT OTHER USERS CAN SEE AT THE TABLE
> WHEN A PLAYER IS SITTING OUT, OR IS FORCED TO SIT OUT FROM CONNECTION ISSUES."

Three independent reasons it could not have shown:

1. **The tag did not exist.** What existed was a CSS `::after` printing `AWAY`,
   scoped to _both_ `.seat--away` and `.seat--sitting_out`, so the two states were
   one word — and, being a pseudo-element, invisible to any test. There is now a
   real `.seat__sitout-badge` element; `AWAY` still means away.
2. **The broadcast lied.** The live payload published
   `is_sitting_out: p.is_sitting_out ?? false` — the _hand roster's_ copy, which
   `ServerTableEngineDealing` builds hardcoded `false` on purpose so
   `HandController` deals a sat-out tournament player in and blinds them off. So
   every snapshot told every client that nobody was ever sitting out. Both the
   live broadcast and the resync now read the engine, as `publishIdleState`
   always had.
3. **Nothing kept the client current.** `sittingOutIdsRef` was written in exactly
   two places — the mount-time seat read and the hero's own tap — and the only
   `table_seats` subscription in `TablePage` bails on `playHasBegun`, i.e. it
   unsubscribes the moment the game starts, and rebuilds seats with
   `status: 'active'` unconditionally. **Once play began, no client ever learned
   that another player had sat out.** A new, ungated subscription now keeps it
   live and repaints the seat (a ref alone cannot re-render).

Connection loss is covered twice: `sp.is_disconnected` now actually maps to the
`'disconnected'` status — `SeatSlot` has rendered a DISCONNECTED label since FIX
186, but the mapping collapsed straight to `'active'`, so that branch was
unreachable — and after three consecutive timeouts the engine formally sits the
player out, at which point the seat reads SITTING OUT.

---

## 4. The upper-right corner opens the tournament lobby

> "ALL TOURNAMENTS NEED THE STATS ICON IN THE UPPER RIGHT HAND CORNER. IT
> SHOULDN'T SHOW THE STATS, BUT OPEN TO THE TOURNAMENT LOBBY PAGE AS A IN GAME
> 3/4 POP UP" — and, on what the button is: "STATS SHOULD LIVE INSIDE THE HERO
> AVATAR ... STATS ICON IS NOT THE TOURNAMENT LOBBY BUTTON. USE THE EXACT BUTTON
> AS IT IS."

- The corner is now **one button, existing artwork untouched**, on every
  tournament, seated or watching. The four-figure Stack/Hands/VPIP/Won bar added
  on 2026-08-25 is gone: those are stats, and stats live behind the hero's own
  avatar (`HeroHubPanel`, built earlier the same day).
- It opens **`TournamentLobbyModal`** — the real lobby
  (`pages/tournament/TournamentDetails`, all eight tabs) rendered via the
  `tournamentIdOverride` prop that already exists for exactly this. Not a
  table-flavoured copy: two renderings of one prize pool is how two screens start
  disagreeing.
- It no longer opens `TournamentInfoPanel`. That four-tab summary is a subset of
  the lobby and is still reachable from the hero hub's Stats tab.

**Geometry is cloned from `HandDetailModal`, and the clone is not cosmetic.**
`TournamentDetails` measures its own distance from the top of the viewport and
writes the remainder into `--details-h`, so it only sizes correctly inside a
container that reaches the viewport bottom. 75vw side panel on desktop, 75dvh
bottom sheet on a phone (three quarters of 375px sideways is unreadable for an
eight-tab page), tappable backdrop on the remaining quarter.

`suppressAutoOpenTable` is new and necessary: the page auto-navigates to
`/table/<id>` when a RUNNING tournament seats you, which from inside an overlay
_at that table_ is at best a redundant route change and at worst pulls a
multi-tabling player off the table they were watching.

---

## Tests

Updated in this commit, per rule 8 — never left for someone else:

- `RestartFidelity.behaviour.test.ts` — pinned "sitOut refuses an unregistered
  player" as correct. Inverted, with the reasoning above.
- `tournamentTableFixes.test.tsx` — pinned the four-figure bar. Now pins the
  single lobby button and asserts the figures are _absent_.
- `tournament-watch.spec.ts` (e2e) — pinned "the bar contains Stack". Now opens
  the lobby, checks the 3/4 panel and click-off-to-close. Runs on the two-hourly
  schedule, not on pull requests, so it will first execute after this deploys.

New: `SitOutClockAndEviction.test.ts` (20), `sittingOutTagIsVisible.test.tsx`
(10), `cashBuyInMirror.test.ts` (5).

All source windows are bounded by structure via `tests/helpers/sourceWindow.ts`
— `noFixedSizeSourceWindows` caught three of mine, correctly.
