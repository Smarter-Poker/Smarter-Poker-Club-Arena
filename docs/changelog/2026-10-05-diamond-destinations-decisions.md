# Diamond Destinations: the twenty answers, the table that holds them and the house earmark ledger

2026-10-05. Migrations `20261005151918_diamond_economics_records_the_owner_answers` and
`20261005152200_the_house_earmarks_what_it_has_promised`. Law
`tests/a-diamond-cap-stops-a-promise-being-made-never-one-being-kept.law.test.ts`,
registry `docs/laws.d/a-diamond-cap-stops-a-promise-being-made-never-one-being-kept.md`.

## Why the decisions are here and not in a question

`docs/DIAMOND-DESTINATIONS-DESIGN-2026-09-21.md` lists A1 to A20 under the heading "The
Decisions Dan Must Make" and says of itself "It proposes no value". Dan answered that
framing on 2026-10-05, verbatim: **"NOTHING IS MINE, EVER.... THEY ARE ALWAYS YOURS TO
DO."** He was replying to a list handed back to him as owner decisions, A1 to A20 among
them. Under CLAUDE.md 10.8 a later explicit owner instruction governs over a document's
framing, and 10.9 puts the money decisions with the agent when the path is clear. So the
twenty were decided, and each one is a row with its basis beside it.

The standard was **derive, then record**. Nothing was invented. Six answers are read off
the chip estate this arena clones or off a standing ruling; six are reasoned from the
Mint's existing limits and the arena's shape and **say so in the row**; three are
CLAUDE.md 10.5 applied; the rest follow from what exists.

## The twenty answers

|     | Question                             | Answer                      | Where the answer comes from                                                                                                                                                                                                                                                                                                                                                                           |
| --- | ------------------------------------ | --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A1  | Which account pays an overlay        | `ca_diamond_house`          | Rule R1 plus measurement: the house is the only platform-owned Diamond account there is. The budget lines hold no Diamonds and under ruling 21 are forecasts. Naming a second account would force the trial balance and the snapshot, which read only row 1, to learn it in the same migration.                                                                                                       |
| A2  | May the Mint issue into it           | Yes                         | The route already runs (`fn_ca_mint` to the house; the fee door writes a house mint row). The house holds 0, so without issuance ruling 16's "guarantees stay diamond-funded" is unsatisfiable. The Mint's own limits are unchanged.                                                                                                                                                                  |
| A3  | Monthly issuance ceiling             | 2,000,000 Diamonds          | **Reasoned, and said so.** The Mint already allows 2,000,000 per rolling 24 hours; this purpose may draw in a MONTH what the Mint allows in a DAY, so it is about thirty times tighter than the Mint and the Mint stays the outer bound.                                                                                                                                                              |
| A4  | Largest guarantee per event          | 1,000,000 Diamonds          | **Reasoned, and said so.** The chip estate has no per-event cap to clone. An event may advertise no more than one Mint operation can fund, which is 1,000,000.                                                                                                                                                                                                                                        |
| A5  | Most overlay outstanding             | 2,000,000 Diamonds          | **Reasoned, and said so.** Equals A3: the platform may never owe more than one month of issuance covers. The chain A4 ≤ A5 ≤ A3 is asserted by the migration and pinned by the law.                                                                                                                                                                                                                   |
| A6  | Does a guarantee cover bounties      | Prize pool only             | **Read off the chip estate.** `fn_ca_fund_overlay_on_lock` computes its shortfall as guarantee less `prize_pool`; `bounty_pool` is a separate column and is not in it. The Diamond ledger already keeps `prize_part` and `bounty_part` apart.                                                                                                                                                         |
| A7  | Set aside, or checked then paid      | Set aside at creation       | The chip estate checks at creation and falls back to the club treasury; the Diamond side has no such fallback, so cloning "checked then paid" would clone the failure without its net. Rule R3 supplies what the chip estate never had: an earmark costs nothing to hold and moves nothing.                                                                                                           |
| A8  | May a cap refuse a creation          | Yes, and only there         | **Derived from ruling 21 itself.** Admitting an event the account cannot fund and only reporting it is a platform pot refusing a player _after they have paid_. Refusing at creation harms nobody who has been told anything. The boundary: once an event exists and its guarantee is earmarked, no value in the table may refuse any player a registration, a prize, a bounty, a refund or a payout. |
| A9  | Who may create one                   | Any platform admin          | The rule the creation door already enforces, and ruling 16's population. "Only me" is the holding pattern 10.9 exists to end. Bounded besides by the live-session requirement of `20260930131500` and by A13 to A15.                                                                                                                                                                                  |
| A10 | May a Diamond event be a freeroll    | Yes                         | **Read off ruling 16**, which names freerolls among the things that exist and stay diamond-funded.                                                                                                                                                                                                                                                                                                    |
| A11 | Freeroll rebuy and add-on price      | None offered                | The chip Free Buy prices are chip amounts and carry nothing. The arena already makes its one other format with promised seats a freezeout (`diamond_satellite_is_a_freezeout`, read live). A freeroll follows it, so no price is invented.                                                                                                                                                            |
| A12 | May the house pay an entry           | Yes                         | **Read off the programme line itself**: "Fund guarantees and promotional entries from authorized diamond house/budgets." The chip product is live (631 tickets). Under R3 the Diamond version earmarks instead of escrowing.                                                                                                                                                                          |
| A13 | Entries per player per day           | 10                          | **Reasoned, and said so.** The only existing per-user, per-day limit expressed as a COUNT is ruling 15's ten referees a day. The count cannot live in `diamond_engine_daily_caps`, which is Diamond-denominated, so the ledger enforces it.                                                                                                                                                           |
| A14 | Entries per event                    | 9                           | **Reasoned, and said so.** The arena's maximum table size: at most one full table of an event's field may be seats the house gave away.                                                                                                                                                                                                                                                               |
| A15 | Monthly Diamond value of entries     | 500,000 Diamonds            | **Reasoned, and said so.** One quarter of A3, so promotional entries can never consume the month and starve the guarantees. Asserted strictly below A3.                                                                                                                                                                                                                                               |
| A16 | Where a refund goes                  | Back to the funding account | **Derived from R3 directly.** Nothing moved at issue, so "nothing moved, so nothing moves back". The wallet would hand a player Diamonds they never owned; a re-issued entry would evade A17 and A13.                                                                                                                                                                                                 |
| A17 | Days before an unused entry returns  | 14                          | **Read off ruling 14's** fourteen-day Diamond purchase-settlement window, the one expiry clock the Diamond economy already runs on. The sweep is product design, not a repair, so 10.12 is not engaged.                                                                                                                                                                                               |
| A18 | Horse entry funding                  | Their own balance           | **CLAUDE.md 10.5 applied, not a preference.** See below.                                                                                                                                                                                                                                                                                                                                              |
| A19 | Horses into a short guaranteed event | Yes                         | **CLAUDE.md 10.5 applied.** Chips do it under the 2026-08-27 overlay rule; the test is "is it identical".                                                                                                                                                                                                                                                                                             |
| A20 | Horses into freerolls                | Yes                         | **CLAUDE.md 10.5 applied.** Chips do it under the 2026-08-27 freeroll rule. A freeroll costs nothing, so there is no funding question at all.                                                                                                                                                                                                                                                         |

## A18 to A20, and the Phase 8 comment that had to go

The live horse door was read rather than trusted. `fn_register_horse_for_tournament(uuid,uuid,boolean)`,
md5 `84c0354e68fb129b5373bc6024cba334`, still returns
`{"ok":false,"reason":"diamond_horse_funding_not_open"}` for **every** Diamond event, under
the comment _"DIAMOND PHASE 8: house-funded horse entries are Phase 9"_. That comment
records the assumption 10.5 forbids: if the house funded every horse's seat while humans
funded their own, that is exactly the "equal outcome by a different mechanism" Dan rejected
outright on 2026-08-27. A18 settles it the other way — a horse pays the same buy-in out of
the same wallet through the same door — and a horse may also hold a promotional entry on
exactly the same terms as a human, under the same caps, never more and never less. Any
`p_include_horses` on this path defaults to true. The door itself is **not changed in this
round**; see "What is left" below.

It also matters that the claim handed to this work — that the refusal string was "gone from
every function body" — was **false**. The phrase with spaces is absent; the refusal
`diamond_horse_funding_not_open` is live. Read, not trusted.

## What was built

**`ca_diamond_economics`** (migration 1). Append-only by trigger. A row is
`(name, scope, value | value_text, units, approved_quote, basis, approved_on, recorded_by,
recorded_at)`; the current value of a name is its **latest** row for a scope, so changing an
answer is recording a row and never editing code. `name` is a closed list carrying **every**
question in section 1 — A1 to A20, B1 to B22 and C1 — so the other Phase 9 lanes add rows
without touching the constraint. `units` is checked against the name by an IMMUTABLE map, a
choice must come from its own question's options, an account must be one whose storage
exists, a Diamond amount must be whole, and neither the owner words nor the derivation may
be empty. Row security on, no grant to `anon` or `authenticated`, `SELECT` to the service
role only.

**`fn_ca_diamond_economic` / `_text` / `_on`** (migration 1). Never return NULL, never fall
back from a stake scope to `all`, to a chip value or to a literal. An unset value raises
`diamond_economics_unset:<name>/<scope>` under **SQLSTATE PDE01**, which no door in this
estate used before (a survey of every ERRCODE literal in `supabase/migrations` found 57
distinct codes and no PDE class). Asking for a word with the number reader raises PDE02
rather than returning NULL. A switch nobody set is **not** off.

**`ca_diamond_house_earmarks`** (migration 2). Append-only. One `earmark_key` is a sequence
of `open`, `pay` and `release` entries and what is open is the arithmetic; amounts are always
positive and whole, and the entry says the direction. `fn_ca_diamond_house_available()` is
the house balance less everything promised. A guarantee belongs to an event, a promotional
entry to a holder, a jackpot seed to neither.

**`fn_ca_diamond_earmark_guard`** (migration 2) enforces A4, A5, A7, A13, A14, A15 and A17
on an **open**, reading every number through the reader so a changed answer is a changed row.
It locks `ca_diamond_house` row 1 per promise (R1, R4 — a promise is not per-hand money, so
one lock per promise is the right cost).

## Ruling 21, and the one line that matters most

Every cap is checked on an `open` and on **nothing else**. The `pay` and `release` branch
returns from the guard **before the first cap is read**, so no value in `ca_diamond_economics`
can stand between a player and a promise already made. A cap stops a promise being **made**;
it never stops one being **kept**. That ordering is the law, pinned both as a text assertion
inside the migration and as an assertion in the law test.

## What was proved, in one rolled-back transaction

CLAUDE.md 11.5 rule 1: both migrations plus a probe sent as **one** call, ending in
`RAISE EXCEPTION`, so an error is the success case and nothing could commit. Measured output,
verbatim:

```
A7 unfunded-house open REFUSED: diamond_house_cannot_set_aside:0 available, guarantee asked for 1000
house funded to 3000000 for the probe; available=3000000 identity_diff=3000000.00
opened 250000 guarantee: available=2750000 balance=3000000 identity_diff=3000000.00
A4 REFUSED: diamond_guarantee_over_per_event_cap:1000001 exceeds 1000000
outstanding guarantees = 2000000
A5 REFUSED: diamond_guarantee_over_outstanding_cap:2000000 already promised, 100000 asked, cap 2000000
A17 promotional entry expiry set by the ledger = 2026-10-19 15:34:51.421304+00
A13 REFUSED: diamond_promotional_entry_over_player_day_cap:10 already today, cap 10
caps rewritten to 0; reader now returns A4=0
ruling21: a NEW promise at cap 0 REFUSED: diamond_guarantee_over_per_event_cap:1 exceeds 0
ruling21: the 250000 promise PAID IN FULL at cap 0; open now = 0
ruling21: an issued promotional entry REDEEMED at cap 0
overpay REFUSED: diamond_earmark_not_open:tg1
release of 750000: available 1249100 -> 1999100
FINAL identity_diff after 13 opens, 2 pays, 1 release = 3000000.00 (baseline 3000000.00)
house balance still = 3000000
append-only UPDATE REFUSED: ca_diamond_house_earmarks is append-only: ...
```

The house was credited inside the probe only, so there was something to promise against;
that is why the identity baseline reads 3,000,000 rather than 0. The claim being proved is
that the **earmarks** did not move it: 3,000,000.00 before and 3,000,000.00 after thirteen
opens, two pays and a release, with `ca_diamond_house.balance` unchanged throughout. A
promise is not supply.

## Measured in production before any of it, 2026-10-05 15:13 UTC

Read inside `BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY`:
`ca_diamond_economics` did **not** exist (0 relations), `fn_ca_diamond_economic` did **not**
exist (0 procs), no relation named `%earmark%` existed, `ca_diamond_house` row 1 held 0,
`fn_ca_diamond_register_vs_supply().difference` was 0.00, `fn_poker_diamond_create_tournament`
was md5 `05e4ae642e1a3949da8bb34bc62f7f3d`, and `ca_arena_settings` read
`tournaments_enabled` true, `cash_games_enabled` false.

**The claim that step 0 had already built the settings table and the earmark ledger was
false.** `20260929160000` and `20260929160100` are the section 4 step 0 **fences** only.
These two migrations are therefore the first of the spine, not an extension of it.

## One recorded defect that needed no fix

Section 6 item 3 of the design — the creation door dropping a guarantee silently — is
**already fixed**. The live body refuses `guaranteedPrize`, `isRebuy`, `isReentry`,
`addOnAvailable`, `addOnCost` and `addOnFromStart` by name with
`diamond_tournament_money_key_not_read: %`, installed by `20260929160000`. Both migrations
assert that refusal is still there, so it cannot quietly regress.

## What was deliberately left alone

- **Both arena switches.** `tournaments_enabled` was already true and `cash_games_enabled`
  is false; neither migration reads or writes `ca_arena_settings`, and both assert the cash
  door is still shut.
- **Every Diamond door.** No door is redefined. Both migrations pin
  `fn_poker_diamond_create_tournament` to the md5 it was read at and fail if it moved.
- **The B1 and B2 fee rows.** Section 3.2 is explicit: until an answer exists the creation
  door keeps its inherited rule. Seeding a fee row here would silently change a fee running
  in production, so migration 1 **asserts no B row was seeded**.
- **The B and C answers.** They belong to the cash rake, BBJ and budget lanes. Their names
  are in the closed list so those lanes add rows only.

## What is left, and it is the expensive half

The answers are recorded and the spine is built; the **doors do not read it yet**. In the
design's order, what remains is section 3.3 (the creation door admitting a guarantee and the
two chip guarantee triggers refusing a Diamond event by name), section 3.4 (the promotional
entry door, the freeroll admission rule and the Diamond arms of the horse door, the overlay
guard and the freeroll fill, which A18 to A20 now unblock), and the A17 expiry sweep. Until
then a Diamond guarantee, a freeroll, a promised satellite seat and a promotional entry are
all still refused by name at the creation door, and the horse door still refuses every
Diamond event — the refusals are now _backed by recorded answers_ rather than by an absent
decision, but they are still refusals.
