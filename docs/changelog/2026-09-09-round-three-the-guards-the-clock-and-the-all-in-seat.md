# 2026-09-09 — Round three: the all-in seat, the clock, and the money on screen

Dan: "KEEP GOING UNTIL YOU ARE BUG FREE."

The first two sweeps fixed defects on the table; the third took the four bug
classes repo-wide. This one went at the areas none of them had reached — the
tournament lifecycle end to end, the engine's non-settlement layers, and the
club money surfaces — with four independent adversarial reads, each required to
quote the line and name the consequence rather than report a suspicion.
Everything below was read, not inferred.

---

## The ones that cost a player their stack

**A Crazy Pineapple all-in seat was folded out of a pot it was already all in
for.** `getActivePlayers()` is `!is_folded && !is_sitting_out` — it includes
all-in seats — and the discard round was opened for every seat it returned.
`foldForMissedDiscard` guarded only `is_folded`, and `calculatePots` excludes a
folded player from every pot. The runout park only fires when fewer than two
players can still act, so one player all-in against two live stacks deals the
flop and opens the discard round for the seat that cannot act. A player who
shoved and stepped away lost the whole shove. Fixed by defaulting that seat's
discard rather than by removing it from the round — removing it would leave it
holding three cards at the river on the same path. The comment claiming "the
round never opens for it" was true only on the runout, and now says so.

**A reconnect force-folded a live seat with a deadline granted for an earlier
absence.** `reconnectDeadlineMs` is absolute and was cleared only by a
voluntary action, so a player who dropped and returned while folded, all-in or
sitting out carried a spent deadline across hands. The next time they were the
acting seat, the turn engine read `protection <= Date.now()` and folded them the
instant the socket came back, full clock unspent. Cleared at the hand boundary
now.

**Any authenticated account could kill a Run It Twice offer.** Confirmed already
fixed on this base — the decline path now carries the membership check the
accept path three lines away always had. No edit needed; recorded because the
audit found it and the answer is "someone got there first."

**A mid-hand rebuy could be zeroed and eliminated.** The busted-seat vacate
carried a race guard (`.lte('stack', 0)`); the `tournament_players` `chips: 0`
write beside it and the `seat_left` emit did not, and a PostgREST update
matching zero rows returns no error. A rebuy landing in the ~2.6-5s window had
its purchased chips overwritten with 0 — and the elimination sweep detects busts
by `chips <= 0`. Both now run off the ids the vacate actually returned.

## The clock, and who it counts against

- **The AFK cap could never be reached.** Every reconnect edge zeroed
  `consecutiveTimeouts` and both away-blind flags, so a backgrounded phone
  produced one edge per orbit and the three-strike sit-out never fired: the seat
  auto-folded every hand for ever, kept posting blinds, and made every other
  seat wait the full clock. A heartbeat is not proof of presence; a voluntary
  action is, and that is what resets the budget now.
- **The manual time-bank expiry was the one timeout path recording no strike**,
  so a player who pressed the button and walked away could never be sat out.
- **The horse time-bank gate re-derived the bank's rules and missed the
  per-street cap**, so a third bank draw on one street auto-folded a horse whose
  real decision then landed after the turn had passed. Both sides now ask
  `TimeBankEngine` the same question, so they cannot drift again.
- **`handCount--` on a global sequence.** The per-table counter became
  `fn_next_hand_number`, shared by every table; un-allocating a sequence value
  set `handCount` to a number another table had already written history against,
  and the horse rebuy ledger stamped it. The capacity guard now runs before the
  allocation, so a refused deal takes no number at all.

## 10.5, 10.6, 13

- **A busted horse's seat cleared about ten seconds before a busted human's** —
  the throttle map defaulted to 0, so the first idle tick released it, while a
  human waited out a 10s grace and a 12s rebuy hold. The two run on the same
  tick at the same table, so the rhythm named the horses. The comment above it
  claimed they cleared at the same moment. Same clock now.
- **A horse's insurance dialog took 5-12s where a human gets 25**, drawn from
  `Math.random()` in a decision path this file's own rule says must be
  deterministic by hand number. It samples the full human window now, from the
  same config the deadline reads, off the same hash the RIT verdict uses.
- **A hidden browser tab paused every animation and killed every transition.**
  The game keeps running while hidden — `useTabKeepAlive` exists for that — so a
  whole hand played out under a frozen felt, and anything that mounted and
  unmounted while hidden never animated at all. That is a dropped cue, and
  "battery savings" is not one of the sanctioned controls (10.6). Deleted.
- **`releaseDeadTournamentSeats` moved seats through the hourly freeze** while
  both its siblings in the same file were gated. Gated (13 rule 5).

## Emitted before the state that gives it meaning

- **`replayRetained` marked an event delivered before it sent it**, and bypassed
  the backpressure checks entirely — so the likeliest failure was the one it
  mishandled, and because the subscriber object is reused for every later
  RESYNC, the loss was permanent. `broadcast` fifty lines below states and
  follows the opposite rule.
- **The RIT auto-decline forwarder read `this.handCount` at fire time** while
  the event carried its own `handId`, so a late timeout announced "Running It
  Once" on the _next_ hand and suppressed that hand's own notice.
- **Ten `hub?.emitEvent` calls in HandEvents were unwrapped** where every
  equivalent in Turns is guarded. `emitEvent` does real work before any
  per-socket try/catch, so a throw aborted the rest of the case: for
  `antes_posted` that loses every blind, ante and straddle row from the hand
  history; for `showdown_cards_revealed` it means no `pot_win` and no
  `pot_distributed` — no winner highlight, no pot ship.
- **The break bridge invented the end time the engine deliberately stopped
  sending.** The last-hand event carries `breakEndsAt: null` on purpose (the
  clock used to reach 0:00 up to two minutes before play resumed); the bridge
  reconstructed it from `durationMinutes`, so the countdown started early and
  jumped backwards when the real one arrived. The clock's comment claimed it
  "shows BREAK with no clock rather than inventing one" — now true, and the
  overlay says `Last Hand` instead of nothing.

## Money on screen that disagreed with money in the wallet

- **`TournamentPage` was the last copy of the payout expression `payoutMath.ts`
  was written to delete** — `Math.trunc` on a binary float, no residual rule, and
  the raw pool instead of the effective one. Measured on production: 13 of 78
  (pool, structure) pairs showed a player a different number from the one that
  reached their wallet. Both surfaces now price through `placePrize`.
- **`TournamentResultsPage` rounded one player's money two ways in one row** —
  `Math.trunc(n*100)/100` for the Bounty column beside an exact `formatCents`
  for the Mystery sub-line it contains, so 22.05 and 22.04 sat next to each
  other. All of it formats from integer cents now.
- **Blinds past the end of a structure were unrounded floats.** `Math.min` is
  not a round, and neither chip cap bites on a healthy ladder — so a 1000 small
  blind became 1316.0740129524924, went into `DECIMAL(10,2)` columns as a
  fractional-chip blind and ante, and into `tables.stakes` as the raw float
  string the masthead, the lobby rows and every BB-depth badge render. Both
  sibling ladder generators round and say why.
- **`per_winner_share`, `net_pot` and `currentHandPotSize`** shipped unrounded
  floats in broadcast money fields — the last one into the rake record and the
  Session Complete card's Biggest Pot tile. `per_winner_share` was also
  pro-rated by the wrong denominator (a winner's total across all pots against a
  single pot's amount), and its `|| 1` folded "nothing eligible" into a silent
  zero; the field is now summed from the exact post-rake shares and omitted
  rather than fabricated.

## Things that read as coverage and were not

- **`TableBalancer.breakTable` mutated the caller's own tables.** `[...otherTables]`
  copies the array, not the elements, and three paths in the caller `continue`
  after a deferred break — so the surviving tables carried phantom players while
  nobody had moved, and a second legitimate break in the same pass was
  suppressed. `calculateMoves`, in the same file, fixed exactly this and left
  the method beside it out.
- **`executePlayerMoves` left two columns stale on every break** — the roster's
  `seat_number` (so the ghost-seat cleanup in the same function could null a
  genuinely seated player's pointer) and `tables.current_players` on both
  tables, which operators read as a seat count.
- **`TournamentLobbyPage` tore down a refcounted channel on every broadcast.**
  It called `channel.unsubscribe()` directly on channels MasterBus hands out by
  refcount — the exact failure MasterBus's own comment describes, where closing
  the lobby stops a table receiving break countdowns and bounty reveals — and
  because its effect keyed on an array the broadcast handler always
  reallocates, it ran on every event rather than on unmount.
- **`TournamentDetails` subscribed to break events it never joined the channel
  for**, so both toasts were unreachable on the page a registered player watches
  from, while the bridge's header claimed "every consumer of the channel calls
  it."
- **`StateVerifier`'s recovery FSM had no exit edge and no production callers** —
  one chip-conservation violation pinned a table at `resync_required` for ever,
  `MAX_RESYNC_RETRIES` was unreachable, and a gap-analysis doc recorded the
  circuit breaker as compliant. The dead breaker is gone and the missing edge is
  in, so nothing reads as coverage.
- **A settlement that threw was swallowed with `console.error`** — no Sentry, no
  financial alert — on the one path that destroys a real pot, in a file that
  reports twelve lesser conditions properly.
- **The stale-eligibility alarm was wired only on the single-board branch**, so a
  multi-board bomb pot could pay a side pot to players who were not eligible for
  it, silently.
- **Two unimported copies of the rebuy and add-on money path** carried a comment
  stating the rebuy RPC takes no idempotency key. It does. Deleted — a second
  implementation of a money path is how a player pays twice.
- **A dead `level_up` hub emit** whose comment claimed the popup, sound and
  haptic depended on it; all four handlers read the tournament broadcast.
- **The chip-race write-back**, dead behind a `false` flag, still scoped its
  stack update by `user_id` with no `table_id` — the corruption the flag was set
  for. Fixed now rather than left armed for whoever re-enables it.

## Guards that answered when they could not tell (10.86)

- **`isRestrictedObserver` failed CLOSED on an unreadable seat row**, refusing a
  seated player their own table, eleven lines under a doc saying it fails open;
  and one failed settings read left a private game watchable for the whole TTL.
- **`isBannedFromTable` cached answers it could not read** — the scope cache is
  deliberately TTL-free, which is true of the value and false of a failure to
  read it, so one transient error dropped the union clause from the blacklist
  query for the life of the process.
- **`useMaintenanceBreak` folded "could not ask" into "no break is running"** and
  cached it, in the source that exists for a browser loading DURING the outage —
  the moment that RPC is most likely to fail. Three verdicts now.
- **`resumeEveryEngine` counted a table that threw as resumed**, in the one
  number an operator reads at :00:05 to decide whether the fleet came back.

## Two more, from the club money surfaces

- **Achievement chip rewards called a function that was retired on 2026-09-03
  and now raises** — and the notification and the milestone toast fired anyway,
  telling the player they had earned chips that never moved, once ever, on a
  reward that cannot be re-granted.
- **`UnionWalletModal` marked every RPC error "definitive"** and deleted the
  durable operation id on it. A 5xx, a timeout or a dropped connection after
  commit is not a refusal; the operator's retry then minted a fresh id and sent
  union money twice. The correct classifier — the 400/401/403/404/405/422 list —
  was already in `UnionApiService` beside it, and four of its own money legs
  minted their key inside the transport with a comment claiming the opposite.

## Verified

- `npx tsc --noEmit` clean, client and `server/`.
- Full client and full server suites green.
- Existing pins moved with their mechanisms, never weakened — `AwayBlindCap`
  (the old test pinned the defect: a heartbeat refunding the budget), plus
  `settingsHaveOneOwner`, `ritConsentIntegrity`, `ritSingleRunIsAnnounced`,
  `showdownSystem`, `blindEscalation`, `tournamentEventBridge`,
  `union-wallet-modal`, `AchievementService`. Several were strengthened in the
  same edit with `not.toMatch` pins forbidding the old shape's return.
