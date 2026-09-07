# BBJ phase 6 of 6 — the Mini jackpot

2026-09-07. Branch `agent/cowork-bbj-audit/phase-6-mini-bbj`.

The last phase of the Bad Beat Jackpot programme, and the only one Dan reserved
to design himself, because it sets what future hands are owed (CLAUDE.md 10.9).
A second jackpot tier: a flat amount out of the backup reserve for a hand that
came close to the main bar and did not meet it.

---

## The design, and where the numbers came from

The build plan required the design to be signed off before anything was built.
Three decisions were put to Dan with the measurement in front of him, and these
are his answers:

|                     |                                                                          |
| ------------------- | ------------------------------------------------------------------------ |
| **qualifying hand** | per game: hold'em **aces full or better** loses, PLO **any quads** loses |
| **payout**          | a **flat amount per stakes tier**                                        |
| **split**           | the main jackpot's — 50 loser / 25 winner / 25 table                     |

Seven days of live cash play, showdowns where the loser was beaten, pot at or
over the existing 10bb floor, at exactly that bar:

| tier              | hold'em/day | PLO/day | total    |
| ----------------- | ----------- | ------- | -------- |
| nano              | 1.00        | 0.14    | 1.14     |
| micro             | 1.29        | —       | 1.29     |
| small             | 1.00        | 0.43    | 1.43     |
| mid               | 0.43        | —       | 0.43     |
| high / nosebleeds | —           | —       | 0        |
|                   |             |         | **4.29** |

**The asymmetry is the reason the rule differs by game.** At the same bar the
two games are 3.4 a day and 0.6 a day apart; one rule for both would have been
a lottery in one and a shrug in the other.

**The budget is the reserve's growth, not its balance.** `backup_balance` holds
48,917.35 across the estate and takes **4,522.54 a day** in fresh contributions
— and until today nothing spent it. `fn_bbj_reseed_main_from_backup` is its only
consumer and fires only when a hit takes 100% of main, which no tier does
(nosebleeds is 85%). It was idle money, which is why Dan wanted the mini funded
from it.

The amounts take the shape of `bbj_stakes_tiers.payout_total_pct` (15 / 25 / 40
/ 55 / 70 / 85), so a mini scales with stakes the way the main jackpot already
does, scaled to spend about half the daily inflow:

```
nano 250 · micro 425 · small 700 · mid 950 · high 1,200 · nosebleeds 1,500
```

At the measured distribution that is **2,242.75 a day against 4,522.54** —
49.6%. The reserve still grows by ~2,280 a day and the 48,917 already banked is
never touched. The two tiers with no observed hits are priced on the same curve
rather than left out: "we have not seen one yet" is not "it cannot happen".

They live in `bbj_mini_tiers`, a **config table**. Changing what the next mini
owes is one `UPDATE`, no deploy, and `enabled` turns a tier off without deleting
the number.

---

## What was built

`20260907181202_the_mini_jackpot_is_a_flat_amount_out_of_the_reserve.sql`
`20260907181347_the_mini_names_a_player_the_way_the_rest_of_the_arena_does.sql`
`20260907183003_the_ticker_says_which_jackpot_it_was.sql`

**The money path.** `fn_bbj_mini_payout` does everything in one transaction, and
almost all of it by reusing what the main jackpot already proved:

- the **same kill switch** (`ca_payout_freeze` scope `bbj_payouts`) and the same
  `P0404` error class, so the engine's existing retry handling covers a frozen
  mini with no new code;
- the **same idempotency key** — `bbj_payouts_pool_table_hand_uidx` — so one
  hand can produce one payout of either kind and never both;
- the **same crediting path**, `bbj_credit_one_recipient`, so a mini inherits
  phase 2.3's parked-share behaviour for free: one recipient with no club wallet
  parks their share instead of rolling back everybody else's;
- **`total_paid_out` moves with it.** Phase 5.3 compares that counter against
  the `bbj_payouts` rows; a payout that wrote a row and left the counter behind
  would take `paid_without_a_payout_row_since` negative and the lifetime verdict
  false.

**What is new is the floor.** `bbj_pools.mini_reserve_floor` (5,000 by default)
is a line the mini may never spend below, so the main jackpot always has
something to reseed from. A mini that cannot be paid **in full** is refused
rather than shrunk — paying a partial would publish one number to the player and
pay another.

Conservation holds by construction: a mini takes X out of `backup_balance`
(inside `balances`) and adds X to `bbj_payouts` (inside `outflow`), so the
lifetime identity does not move at all. The migration asserts the phase-5 check
still passes.

**The engine.** `detectMiniBBJHit` in `RakeConfig.ts` applies Dan's per-game bar.
It keeps every floor the main has — read from `BBJ_RULES` rather than restated,
so they cannot drift — plus the winner-holds-quads gate, and drops exactly two
things: **the Ace-in-hand requirement and both-cards-must-play.** Those two are
what the main adds, and the hands they refuse are the ones a player would swear
was a bad beat. That is the whole feature.

Settlement calls it only from the `else` of the main's hit, so the mini is never
even asked about a hand the main accepted.

**The screen.** `bbj_hit` and `bbj_payout_complete` carry `kind: 'mini'` in
otherwise identical events, the celebration reads "MINI BAD BEAT JACKPOT!", and
`fn_bbj_recent_hits` gained a trailing `kind` column so the Previous Winners list
badges a mini instead of presenting 700 chips as a main jackpot that paid almost
nothing.

---

## Two defects caught before they reached a player

**A column that does not exist.** The first cut read `profiles.arena_name` for
the ticker's display names. There is no such column, so every mini payout would
have aborted at the last statement — after the reserve was debited and every
recipient credited — and rolled the whole thing back. The jackpot simply would
not have paid. A rolled-back probe found it (CLAUDE.md 11.5: one call, one
self-aborting `DO` block, and the error is the success case). The fix is
`fn_arena_name`, which the rest of the arena already uses.

**An event nobody could read.** The mini's `bbj_payout_complete` was emitted with
`total` / `amount` / `perPlayer`, and the celebration reads `totalPayout` /
`share` / `perPlayerShare`. Every number on the one screen the feature exists to
produce would have been zero. One event shape now, one reader; `kind` is the only
thing that differs, so an older client shows a celebration rather than nothing.

## Proof it works

The payout was probed against a live pool inside a transaction that was rolled
back, and zero residue confirmed afterwards:

```
applied true · kind mini · total 700.00 (the `small` tier)
loser 350.00 · winner 175.00 · table 175.00 · per player 87.50
backup_balance -700.00 · total_paid_out +700.00
4 recipient rows, 700.00 credited          -> CONSERVES true
second call: applied false, already_paid true   (idempotent on the hand)
bbj_winners row written, arena name resolved
```

`theMiniNeverOverrulesTheMain.law.test.ts` (14 tests) pins the bar in both
games, the gates it keeps, the two it drops, and the two structural promises:
settlement may ask the mini only where the main refused, and the mini's money
may come only from the reserve through its own RPC.

## Open

- No mini has fired in production yet — the first real one is the proof that
  remains. Every figure above is either measured from history or from a
  rolled-back probe.
- The high and nosebleed amounts are priced on the curve, not on observation.
  If traffic appears at those stakes they are worth re-deriving.
