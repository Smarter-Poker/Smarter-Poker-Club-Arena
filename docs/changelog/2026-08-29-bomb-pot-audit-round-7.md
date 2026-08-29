# Bomb pots, read line by line

2026-08-29, round 7. Continues the ledger-durability work in #1724.

Two full audits of the feature — every server engine file, every client
surface, every migration and every RPC. Twenty-one defects, none of which was
visible from a failing test. Every one is fixed here and pinned, and the
pins carry the evidence so nobody has to rediscover any of it.

---

## Critical — wrong money, or a table that stops behaving like a table

### A bomb pot on every hand, forever, and a button frozen on one seat

`BombPotScheduler.buttonCrossedAnchor` returned `true` when the button had not
moved, reasoning that "a single seat dealt around" completes an orbit every
hand. That case cannot occur: a hand needs two players, and
`ServerTableEngineDealing` forces the button across whenever
`players.length > 2` precisely so it can never stand still. The branch never
fired for the reason it was written.

What does produce `from === to` is the **separate bomb button**. On a bomb hand
that policy rewinds the regular rotation by design, so the next hand recomputes
the same dealer seat — and the scheduler read that as a completed orbit, armed
the token, and dealt another bomb. Steady state: a forced ante on every hand,
blinds that never post, and a regular button parked on one seat for the life of
the table.

Both settings are host-selectable and **`once_per_orbit` is what the first host
preset, "Classic Double Board", selects.**

A button that has not moved has not passed anything. It now returns `false`.

### The bomb ante was the one forced bet the engine never rounded

`bigBlind * bombPot.anteMultiplier`, raw. Every sibling rounds — `postBlinds`,
the BBJ fee, `returnUncalledBet`. The ante multiplier slider steps by 0.5, so at
micro stakes the product is a fraction of a cent (0.05 BB × 1.5 = 0.075).
`snapChips` then rounds each player's stack and `totalInvested` independently of
`state.pot`, and the table stops conserving chips.

Even at cent-legal multiples the raw float escaped: `0.1 * 3` is
`0.30000000000000004`, and `anteAmount` is emitted verbatim in
`BOMB_POT_TRIGGERED` and `FORCED_BETS_POSTED` — so that dust landed in the
persisted actions log and in `hand_history.bomb_pot.ante_amount`.

`verifyStreetIntegrity` would have raised the conservation break as a critical
alert, which is presumably why it has not been seen. Loud is not the same as
fixed.

### Insurance priced a bomb hand as the wrong game

Insurance is suppressed only on **multi-board** bombs. A **single-board** bomb
carrying a variant override — an NLH table dealing one PLO board, a supported
and host-selectable configuration — is fully eligible, and the leader election
ran `evaluateHand` on four-card holdings while `insuranceEquity` was handed
`'nlh'`. Premiums and payouts are real money, so this was the wrong player being
offered the wrong price.

`activeHandVariant()` is the one seam for "what game is this hand", and
`broadcastAllInEquity` two hundred lines away already used it. Four sites in
`ServerTableEngineRunout` were missed when the rest were converted: the
insurance leader election, its short-deck flag, the RIT chooser election, and
the horse's pineapple discard. A fifth — the deck size behind the outs
percentage in the insurance popup — was found by the guard pin written for the
first four.

### The whole Table Info tab was unreachable, and with it the manual bomb

```tsx
onClick={() => setActiveTab('rules')}   // on the button labelled "Table Info"
```

Nothing anywhere set `'info'`, so `{activeTab === 'info' && ...}` never
rendered. Dead in production behind that one token: the financials, the feature
chips, the entire bomb-pot disclosure block — and the **only control that
reaches the manual-bomb path**. `fn_request_manual_bomb_pot`, the
`bomb_pot_manual_requests` audit trail, the `bomb_pot_manual_pending` column,
the engine's per-hand read of it, the staff role check and the toast are all
built, all correct, and were all unreachable. A club owner could not fire a
manual bomb pot at all.

---

## High — a feature that silently did not work

**`once_per_orbit` gave the player no warning at all.** `handsUntilDue` returned
`null` for every mode but `every_n_hands`, and the token is set and consumed
inside one `noteHandStart` call — so the felt pill never rendered and a forced
ante arrived unannounced on the recommended preset. It now counts down: an
orbit is one hand per player dealt in, both terms measured rather than inferred
from seat numbering, and persisted with the rest of the scheduler so a deploy
does not blank the pill for a whole orbit.

**Multi-board equity reverted to board 1 after the first street.**
`dealNextStreet` fills boards 2 and 3 in lockstep but returns board 1 alone, so
the three later broadcasts had nothing to pass. A double or triple board bomb
showed correct averaged percentages at the moment of the all-in and then wrong
ones for the flop, the turn and the river — drifting further from the truth
exactly as the hand got more dramatic. `liveExtraBoards()` reads them from the
controller, and all four broadcasts now use it.

**Disabling bomb pots left the pending token in the database.**
`noteHandStart` resets the in-memory scheduler when the schedule is off, but the
persistence write was gated on `enabled` — so `{p: true}` stayed in the row.
Re-enable, restart, and `restoreState` detonated that stale token on the first
valid hand: exactly what "re-enabling starts a fresh schedule" exists to
prevent.

**The announce window was enforced only by the browser.** A host asking for the
clock to stay quiet until the bomb is close was asking for the detonation time
to be secret. The engine published the exact timestamp in every snapshot to
every player and the client's render declined to draw it — so anyone reading
the websocket had a number the players looking at the felt did not, on a table
with a forced ante. It is withheld at the snapshot now; the client check
remains as presentation.

**The rules panel quoted an ante nobody is charged.** `TableConfigPage` writes
`bomb_pot_ante_multiplier` in both modes and the engine prefers
`bomb_pot_ante_fixed`, which the table never fetched — so a "Fixed Ante 25"
table was described as "2x BB" while the lobby, which does read the fixed
column, said 25. Two surfaces disagreeing about the price of a hand.

**The scoop banner covered the boards it celebrates.** Pinned at `top: 21%` of
the felt, and it renders only on a multi-board hand — the one case where the
stack is tall enough to reach it. At 375px the three-board stack spans roughly
17.5%..69% and the banner occupied 21%..33%: squarely over board 1. It is now a
child of `.community-area` hung off that element's own bottom edge, so the
collision is impossible rather than unlikely, for one, two or three boards at
any width, with no percentage left to go stale.

**The analytics were readable by anyone, signed in or not.** The three
`v_bomb_pot_*` views shipped without `security_invoker`, so they run as
`postgres` and bypass RLS on their base tables, and Supabase's default grant to
`anon` and `authenticated` was never revoked — verified against the live
catalog. `v_bomb_pot_vs_normal` selects **all of `hand_history` for seven days
with no bomb filter**, so an unauthenticated caller could read aggregate hand
data for the whole platform. `bomb_pot_award_units` had a narrower version:
`FOR SELECT TO authenticated USING (true)`, justified as "the same public
information the table broadcast at showdown" — but a showdown is public to the
players at that table, not to every account on the platform, and that table
carries user ids and amounts for private clubs, VIP-only clubs and anonymous
games.

---

## Medium and low

- **The manual claim was a race.** SELECT-then-UPDATE with no predicate on the
  write: two engines overlapping during a shard handoff could both read `true`
  and both fire — the double bomb the fail-closed comment said it prevented. It
  is one conditional `UPDATE ... WHERE bomb_pot_manual_pending = true` now:
  atomic, and one round trip instead of two on the hand-start critical path.
- **The bomb button bypassed Dan's new-player rule.** It rotated over the raw
  seat list rather than `buttonRoster`, so a player on their first hand at the
  table could take the button — which sets postflop action order and odd-chip
  allocation. The rule is about the button, not about which kind of hand it is.
- **The variant override obeyed the deck but not the seat law.**
  `maxSeatsFor('plo5')` is 9 by deck arithmetic, but PLO5 is 7-max and PLO6 is
  6-max by Dan's ruling — so nine players were dealt nine-handed PLO5, and 45
  hole cards then left no room for the three boards the host asked for, silently
  downgrading the whole feature on a hand that should not have used the override
  at all.
- **The bomb button was persisted one hand late** — the write ran before the
  decision, so on a bomb hand it stored the previous bomb's button seat.
- **A voided bomb hand never dismissed the overlay.** `BOMB_POT_COMPLETED`
  follows every `HAND_COMPLETE`, four paths, all covered. The 10-minute safety
  timer is the fifth exit and the only one that tears the hand down from
  outside the controller.
- **Straddles were computed and discarded on every bomb hand** — no money moved,
  but a `HandConfig` asserting straddles nobody posted is a trap for the next
  reader of either branch that consumes them.
- **A screen-reader player was charged a forced ante in silence.** The overlay
  is `aria-hidden` and should be — a bomb, a wick and a blast are decoration —
  but every word of the event lived inside it. §10.6 says reduced motion
  collapses the motion and never the meaning; the same applies when the motion
  is hidden. There is a live region now.
- **`animation: none` under reduced motion**, against the house rule in
  `reducedMotion.css` ("those elements would be stranded mid-thought"). Harmless
  today by luck, a trap the moment the keyframes gain an opacity.
- **The ETA pill was 8.8px** — the smallest text on the felt, carrying its
  longest strings, warning about a forced ante. Now 0.62rem, matching its
  neighbours.
- **The urgency pulse ran forever on a bomb-only table**, where "the next hand
  is a bomb" is ordinary rather than urgent.
- **The replay printed raw DB enums** at the player: `EVERY N HANDS`,
  `ONCE PER ORBIT`. The lobby already maps the same four values to English.
- **`bomb_pot_min_players` and `bomb_pot_button_policy` had no UI at all.** The
  first is why a promised bomb sometimes never arrives — the engine holds the
  token below the floor and says nothing. Both are disclosed now.
- **The scoop banner was the one felt banner outside `formatPopupText`.**

## New: a report a club owner can actually use

`fn_club_bomb_pot_report(club_id, days)`. None of the three views carries
`club_id` or `table_id` — they group across the entire platform, `v_bomb_pot_outcomes`
has no time filter at all, and nothing in either repo reads any of them. They
are operator views wearing a club-analytics label.

The new function is scoped to one club the caller owns or administers, broken
down per table, per trigger mode and per board count, and carries the three
numbers the views omit entirely: **players per bomb**, **forced money moved**,
and **scoop rate** — plus `unrecorded_hands`, which ties back to
`fn_bomb_pot_ledger_gaps` from #1724.

## Not done, deliberately

**There is no edit form for a running table** — `TableConfigPage` takes a
`gameType`, never a table id, and has no hydration path. A host who ships a
table with the wrong bomb frequency cannot change it without killing the table
and losing the seated players. That is true of **every** setting on the table,
not only the fourteen `bomb_pot_*` columns, so it is a table-configuration
feature rather than a bomb-pot fix and does not belong in this PR.

**`once_per_orbit`, `bomb_pot_only`, the PLO5/PLO6 overrides and the
board-count downgrade have still never run in production.** The runaway fixed
above is the reason to be glad of that, and the reason to prove them
deliberately rather than wait. The permanent E2E table
(`d2e23e79-…`, horse-only) is the technique.

## Migrations

`20260829_bomb_pot_analytics_stop_being_public.sql` — applied and verified:
the three views carry `security_invoker=true` and no `anon`/`authenticated`
grant, `bomb_pot_manual_requests` is fully closed, `bomb_pot_award_units` has no
write grants and no `anon` read, and its read policy is scoped to the club the
hand was dealt in.

---

## CORRECTION (2026-08-29, same day)

The ante-rounding entry above overstates one of its two cases, and the record
should say so rather than quietly stand.

**What I wrote:** "The multiplier slider steps by 0.5, so at micro stakes the
product is a fraction of a cent (0.05 BB x 1.5 = 0.075) and the table stops
conserving chips."

**What is true:** `tables.bomb_pot_ante_multiplier` is an **integer** column —
verified against the live schema while probing the new settings RPC. A
multiplier of 1.5 can never be stored, so that sub-cent path was not reachable
through this column. The slider offering a half-step was a defect in the FORM,
not evidence of a live conservation break.

**What stands unchanged:** the second case, which is real at every stake.
`bigBlind * anteMultiplier` on binary floats produces dust — `0.1 * 3` is
`0.30000000000000004` — and that value escaped raw into `BOMB_POT_TRIGGERED`,
`FORCED_BETS_POSTED`, the persisted actions log and
`hand_history.bomb_pot.ante_amount`. Rounding before anybody is charged fixes
that, and it also closes the sub-cent case for good the day someone widens the
column.

The half-step slider is fixed in round 8, in both forms, along with the RPC
that had been letting Postgres round on assignment and returning `ok: true`
with no indication the ante had changed.
