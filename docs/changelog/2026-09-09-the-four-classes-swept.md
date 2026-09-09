# 2026-09-09 — The four bug classes, swept out of the whole repo

Dan: "FIND ANY AND ALL SIMILAR BUGS, GAPS, STUBS, ERRORS, REGRESSIONS OR
WIRING ISSUES ANYWHERE AND EVERYWHERE. AND GET THEM ALL FIXED."

The two sweeps before this one fixed four defects on the table. This one took
each of those as a CLASS and hunted every other instance in the codebase, with
four independent adversarial reads and production queried read-only for
evidence. What follows is what was found and what was done about it.

The four classes:

1. **An unrounded float reaches a stored money column.**
2. **A message is emitted before the state that gives it meaning.**
3. **A feature is wired only on a branch production does not take.**
4. **A non-idempotent correction is applied more than once.**

---

## 1. Unrounded money

The 2026-09-08 incident was one line. `Math.min(amount, maxBuyIn - stack)` is
a float subtraction — `50 - 33.33` is `16.670000000000002` — and
`atomic_table_addon` stores what it is given. Measured on production:

| column                               | non-cent rows | of        | last one                 |
| ------------------------------------ | ------------- | --------- | ------------------------ |
| `session_history.profit_loss`        | 60            | 261 (23%) | **the day of the sweep** |
| `club_member_daily_stats.profit`     | 1,328         | 675,085   | 2026-09-06               |
| `club_member_table_state.last_stack` | 720           | 577,276   | 2026-08-20               |
| `wallet_credit_idempotency.amount`   | 633           | 344,829   | 2026-08-31               |
| `table_addon_idempotency.amount`     | 62            | 16,421    | 2026-09-07               |
| `table_pending_addons.amount`        | 49            | 13,028    | 2026-09-07               |

**48 of those 49 add-on rows fail the post-commit obligation predicate**
(`applied + refunded IS DISTINCT FROM amount`), across ten tables. All are
resolved, so nothing is wedged — but any hand envelope naming one raises
deterministically, settlement retries every few seconds until the lease dies,
and that table never deals again.

Fixed at every layer, because the class survived precisely by being fixed at
one:

- **The doors.** `atomic_table_addon` and `atomic_table_buyin` refuse a
  non-cent amount _before_ claiming an idempotency receipt (so a refusal does
  not burn a key). The guard already existed in 30+ money RPCs;
  `atomic_table_rebuy` got it on 2026-09-08 and its two siblings did not.
  `/addchips` refuses one at the wire.
- **The split.** `resolve_pending_addon` derived `refunded` from an
  **unrounded** `applied`, so the receipt could only ever sum back to a
  2-dp amount — that is _why_ a dusty row is unresolvable rather than merely
  untidy. It now rounds `applied` first and derives the refund from the
  stored amount, so the receipt reconciles for every input.
- **The columns.** `NOT VALID` cent CHECKs on the four unscaled columns. Not
  backfilled: settled history is not rewritten to look tidy (10.9).
- **And who may open the doors at all.** `check-definer-authorization` blocked
  this migration, correctly, for a hole that is not open on the live database:
  `CREATE OR REPLACE` keeps a function's ACL, so replacing `atomic_table_addon`
  changes nothing about who can call it today (production carries
  `postgres, service_role` and nothing else, which is why it has never needed
  the `auth.uid()` check its two siblings carry). Replay the set onto a fresh
  database, though, and every one is CREATED — Postgres grants EXECUTE to
  PUBLIC on creation, and a SECURITY DEFINER chip writer that asks nobody who
  is calling becomes callable by `anon`. The migration now states the three
  ACLs it depends on, reproducing production exactly, so it is a no-op here
  and self-sufficient anywhere else.
- **The callers.** `SessionStatsService` (the only writer still producing bad
  rows), `BuyInModal` (its 33%/66% presets produced a non-cent intent that
  `CashBuyInRecovery` refuses — the player was told "Unable To Start Your
  Buy-In" and **could not sit down**), `CashierModal`'s MAX preset, the auto
  top-up, `confirmBustRebuy`, `HorseOrchestrator`, `HorseRebuyPolicy` (its
  fail-closed guard meant the horse silently never rebought where a human
  did — 10.5), `getMaxBuyIn`, and four stack assignments in settlement,
  including one that was float _cancellation_ (`before - (before - wonAmt)`).
- **Every jackpot share.** A BBJ payout is 50/25/25 of the pool and the last
  quarter is split again per dealt-in player; the mini jackpot's table share is
  `reserve / players`. All four landed on the seat array with a bare `+=` — the
  same array `persistStacks` writes to `table_seats.stack` — while the ordinary
  payout twelve hundred lines above had been snapping since 2026-09-04.
  `ServerTableEngineSeating`'s between-hands add-on was the one add-on branch
  of three that did not round, and `AtomicStackService`'s version map (which
  `amount > sv.stack` compares an exact all-in against, and which is the
  baseline the next hand's delta is measured from) accumulated raw.
- **A real wager.** `MultiTablePage`'s pot-sized raise rounded to a whole
  chip: at 0.05/0.10 an exact 0.65 pot raise was sent as `1`, and a 0.375
  half-pot as `0`, which made the button vanish. The single-table definition
  is exact and its comment claims to be the only one.

Display truthfulness of the same class: the mystery-bounty chest opened a
750-cent bounty as "8" while the ranking card said 7.50; the advertised
tournament payout table floored each place (98 against the 98.72 paid); the
winner banner, the lobby's average pot, the BBJ aria-label and the seat's
bounty badge all rounded or dropped cents the surface beside them kept.

## 2. Emitted before the state that gives it meaning

- **The hero's cards raced the hand.** Hole cards arrive as a private frame
  the client dispatches on arrival, _ahead_ of the queued snapshot carrying
  the new hand's empty board — so `heroCardsAreForThisHand` judged a fresh
  holding against the PREVIOUS board and refused it whenever they shared a
  card (about one hold'em deal in five, one PLO deal in three), reporting to
  Sentry and falling back to the recovery poll. A hand that has not been dealt
  cannot collide with a board that is finished; the hand check beside it
  already fails open on exactly that comparison.
- **The showdown hold was always the two-hand value.** It counted `showCards`
  from a snapshot the engine deliberately sends _after_ the event, so the
  filter returned 0 and `Math.max(2, 0)` was permanent. The engine derives its
  own hold from the real count, so every three-way-plus showdown reset the
  felt 350–800ms early — a truncated announcement (10.6). It counts from the
  event now.
- **TURN_CHANGE had no fence.** `heroActedFence` exists so a frame generated
  before the engine saw the hero's action cannot hand the turn back; it was
  consulted only in the snapshot mapper, and TURN*CHANGE is the frame that
  lands \_last*. Both comments justifying that were inverted (10.8: a wrong
  sentence in the repo produces the defect underneath it).
- **The snapshot effect depended on a field it writes.** Any change to
  `maxPlayers` re-applied the last snapshot in full — and the reachable path
  is a reconnect, where GAME_START widens it 6→9 and its own recovery is then
  overwritten by the stale pre-gap snapshot.
- **The insurance payout moved a stack nobody was told about.** No broadcast
  after `applyStackDeltas`, so the chips flew to a seat whose number did not
  change until the next hand. The 7-2 bounty 130 lines below already learned
  this and left the comment; insurance never got the line.
- **Deferred chip flights** (the bomb ante at 3.2s, the pot ship through a
  run-it-twice hold) closed over the seat ring as it stood at the event —
  before the hero's seat was known, when the ring is unrotated.
- **`heroSeat` is 0 for the first events after mount, reconnect or a mid-hand
  join**, and 0 was not read as "unknown": the hero's own action echoed as
  someone else's (doubled sound), all-in dramatic mode lit over a live hero
  decision, the turn bell and haptic were dropped on the first turn after a
  reconnect, and `players[-1]` reported a hero stack of 0.
- **Out-of-order fences read client state instead of the event's own hand
  number**, so on a mid-hand join the SCOOP banner and its big-win cue were
  silently dropped and a stale rabbit-hunt offer failed open.

## 3. Wired only on a branch production does not take

- **The metrics.** `ENGINE_METRICS` is set **nowhere** in the estate — it
  appears once, in a comment — and `/metrics` appends the gated registry only
  when it is `on`. So the entire Bad Beat Jackpot observability shipped
  2026-09-06 (detected / paid / queued / parked / drills), the showdown-muck
  pair and the RPC error counter have been incremented on every hand and
  rendered to nobody. Worse: `SLOHandsAreNotBeingDealt` — severity critical,
  `page: sms`, the alarm for "the platform stopped dealing" — reads
  `poker_hands_total`, and `rate()` over a series with no samples is an empty
  vector, which cannot cross a threshold. Those counters move to the always-on
  registry (losing `table_id`, whose contract is bounded cardinality) and
  register at zero, so "no jackpot" and "no instrument" stop reading alike;
  the SLO reads `poker_hands_dealt_total`, which the engine has always
  published; the Grafana panel and the README follow.
- **And the check that should have caught it.** `check-alert-rules-match.mjs`
  reconciled rule _names_ between the repo and the box and never asked whether
  a rule could fire. It now collects every metric an expression reads and
  refuses any that Prometheus has never seen. `alert-rules.QUARANTINED.yml`
  already records what a directory of unfirable rules costs; nothing was
  checking.
- **`TABLE_META_UPDATE` is constructed nowhere**, and `ChannelHub` has no
  table subscription to deliver it on — so the 2026-05-18 migration off
  `postgres_changes` made live blind-level changes and table renames silent
  for every seated player. The engine now emits `table_meta_update` on the
  table's own socket, which the felt is already drawn from.
- **`HorseLifecycleManager` swallowed cash-out failures.** `atomicCashout`
  throws without an `onFailed`, straight into a bare `catch {}`, so a stale
  seat whose chips could not be returned produced no error, no metric and no
  alert — and still counted as cleaned. Its boot cycle also ran without the
  maintenance-freeze gate its interval has carried since 2026-09-01, and the
  engine boots inside the break more often than not.

## 4. Applied more than once

- **Hands played and won were counted twice**, by two writers on one ref: the
  dealtIn-gated `HAND_COMPLETED` subscriber and a second, ungated increment.
  Net 2 per dealt-in hand and 1 per sat-out hand — so Hands Played and
  Hands/Hour read double, and **VPIP read half of truth**, because its
  numerator is latched once per hand and its denominator was not. The two
  surfaces printed different hand counts for one session, which is how it was
  caught.
- **The hero's pot accumulator sat one line outside its own fence**, with no
  per-pot identity, feeding an achievement increment that is not idempotent.
- **Four money keys identified the ATTEMPT, not the purchase**: VIP (lifetime
  is 19,999 diamonds) minted one per claim and destroyed it in `finally`; the
  store rotated its key in a `catch` that fires identically for a transport
  failure and a terminal refusal; the agent dashboard sent none at all for
  cashout approve/deny (its own panel does this correctly, and warns that a
  key shared between the two _collides_ rather than replays); spin activation
  minted one inside the transport. All three transports now say which
  refusals are terminal, with the same 400/401/403/404/405/422 list
  `UnionApiService` already had and nobody read.
- **The auto top-up's key was discriminated by a recomputed float** — and
  committing the debit is _what changes the balance_, so the exact
  lost-response case a key exists for recomputed, re-minted and charged twice.
  It is keyed on the hand now; the law and its registry entry moved with it.
- **Cues fired twice**: the jackpot fanfare on every reconnect inside the 60s
  replay window (the one BBJ arm that skipped the identity gate — the server
  comment asserting the gate covers it is true of every other arm), and the
  deal swish on every hole-card re-push, which happens on every connect, mux
  join and RESYNC.
- **Toasts fired twice** for one add-on and one balancer move; a reduced bust
  rebuy was called an "Add-On", contradicting the "Rebought For N" the player
  had just been shown.

---

## Left as-is, deliberately

- `BBJ_RULES.splitIfMultipleQualify` is published to players and implemented
  nowhere. Whether the copy or the behaviour changes is a rule about what
  players are owed, which is Dan's (10.9).
- `server/src/scale/**` (78 KB) and `MonteCarloEquity` are unreachable from
  every entry point. Deleting a tier is not a bug fix; it is a decision.
- The `chipRaceEngine` / `tableBalancer` / `tableBreakEngine` instances
  constructed on the wrong class. `TABLE_BALANCE_EXECUTED` therefore cannot
  reach a client, and MultiTablePage already announces the move from the
  authoritative source (the hero's own seat row). The duplicate-in-waiting is
  gated so that correcting the wiring later cannot produce two popups.
- The 15 alert rules reading `poker_cron_*` / `poker_settlement_*` /
  `poker_financial_alerts_*`: the new CI check will name every one of them
  against the live series list, which is the honest way to decide whether each
  wants a producer or a deletion — rather than removing coverage on a guess
  about which exporter feeds it.

## Verified

- `npx tsc --noEmit` clean, client and `server/`.
- `npx eslint` on every changed source file: 0 errors.
- Full client suite and full server suite green (see the commit).
- New pins: `tests/a-chip-is-two-decimals-on-every-money-path.test.ts` (17),
  `tests/one-event-one-application.test.ts` (21). Three existing pins moved
  with their mechanism in the same commit and say why:
  `a-top-up-is-charged-once.law` (and its `docs/laws.d` entry),
  `TheFeltKeepsWhatLandedOnIt.law`, `spinOwnerMenu`.
- The production figures above are SELECTs run read-only against the live
  database; no probe wrote anything (11.5).
