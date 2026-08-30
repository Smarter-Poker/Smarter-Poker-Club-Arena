# 2026-08-29 — the bounty money

Continuing the sweep at Dan's instruction. This pass covered bounty pools,
mystery bounties, the bad beat jackpot, promotions and rakeback.

**The headline is not a bug I fixed. It is one I found, measured, and can prove
is already fixed** — but it cost players a great deal and nobody had noticed.

---

## 3,158 knockouts went unpaid, and the winner took the money

On mystery bounty events between **18 and 27 August**, knocking a player out
paid the knocker nothing. The bounty stayed in the pool, and at the end
`fn_finalize_bounty_pool` swept the whole thing to the champion as "unclaimed".

|                                                              |               |
| ------------------------------------------------------------ | ------------- |
| events affected                                              | **85**        |
| knockouts that paid nobody                                   | **3,158**     |
| money paid to champions instead of the players who earned it | **18,472.80** |

No chips were lost — every pool balances to the cent, which is exactly why no
conservation check ever complained. The money went to the **wrong players**.

It is intermittent across the window (broken 19–20, working 21–23, broken
24–27) and **working again since 28 August**: the three most recent mystery
events paid 32 of 34, 41 of 42 and 34 of 35 knockouts. The 28 August knockout
fix closed it.

Whether the 18,472.80 should be redistributed is Dan's call — it means
reclaiming from 85 champions to pay 3,158 knockouts, and that is a decision
about players' balances, not an arithmetic correction.

### How it was found, and the two claims that did not survive checking

Worth recording, because both were confidently wrong and both would have caused
harm if acted on.

**"Every mystery bounty event pays its final chest twice."** Predicted from a
reveal-timer race. Measured: 25 of 25 mystery events in the last 72 hours
balance **exactly**. Not happening. Not fixed, because there is nothing to fix.

**"20,461.40 of bounty pools were funded with money nobody paid."** My own
query, and it looked damning across 183 events. Then: `tournament_buyin` ledger
rows **did not exist at all** before 19 August — zero rows on the 12th to the
18th, 5,626 on the 19th. I had measured a logging gap and called it minted
chips. Discarded.

The lesson is the one already in this repo's history: verify a money finding
against the ledger before believing it, including when the finding is your own.

---

## The chest system has never paid anybody

104 mystery chests have been built across 27 events. **Every single one is
`void`.** `tournament_bounty_awards` and `tournament_bounty_award_recipients`
have never held a row — not one chest has ever been reserved, revealed or paid.

So the advertised mechanic (knock someone out, open a chest, win a random
share) has never happened. On those 27 events the entire bounty pool went to
the champion, and all 54 bounty payments across them carry the description
"awarded to champion".

That is not fixed here — it is a live feature question for Dan, not an
arithmetic one. What IS fixed is that the path is now safe for the day it does
start running, because two defects on it would have taken money from knockers:

**A chest could be consumed with nobody to pay.**
`fn_mystery_bounty_reserve` flips the chest to `reserved` and inserts the award
_before_ it works out the recipients, then `RETURN`s when there are none — and
a RETURN **commits**. The chest is permanently consumed and then swept to the
champion. Guarded by a `DEFERRABLE INITIALLY DEFERRED` constraint trigger,
which sees the whole transaction and covers every writer rather than the one
call site that is wrong today. It also refuses a split that does not add up to
the chest. Verified by probing it and watching the probe unwind.

**A refused credit was recorded as paid.** `fn_mystery_bounty_pay` stamped
`paid_at` before reading whether the credit landed, and the retry loop selects
`WHERE paid_at IS NULL` — so a refused recipient was excluded from retry
forever. Worse, `fn_mystery_bounty_settle` computes what was paid from that
same flag and reports `balanced`, so the one check designed to catch the
shortfall was fed by the corrupted value. The stamp now lives inside the
credited branch, and an award is no longer marked complete over a refusal.

---

## A bounty pool can still be funded by an entrant who paid nothing

`trg_seed_bounty_head` returns early when the head is already set, which is the
case for everyone arriving through a register RPC. Anything else — a satellite
seat award, a ticket redemption, a backfill — reaches the funding line and adds
`bounty_amount` to `bounty_pool` with no collection behind it, and
`fn_finalize_bounty_pool` turns the excess into real chips for the champion.

**Not blocked, deliberately.** Nothing is known to walk this path today, and
refusing to fund is not obviously safer: an unfunded head still makes its
holder knockable, and `fn_collect_bounty` caps payment at the unpaid pool, so
under-funding lands on whichever knockouts happen _last_ — which is precisely
the 3,158-knockout shape above. Trading a visible over-funding for an invisible
under-funding would be a poor trade made on a guess. It now raises one alert per
tournament so the question can be answered from evidence.

---

## Two promotions could never have paid anyone

`applyDepositBonus` and `processReferral` filtered on `promotions.is_active`.
**There is no such column** — the table carries `status`, confirmed against the
live schema. PostgREST failed the whole query with 42703, and neither call site
bound the error, so a broken query was indistinguishable from "no promotion
configured": one returned 0 every time, the other returned without paying.

The tell is inside the same file: `getPromotions` filters on `status`
correctly, and the mapper's own comment says "promotions has `status`
(open/active/…), not a boolean is_active."

No money was lost, because no `deposit_match` or `refer_friend` promotion has
ever been configured. That is luck, not safety.

Fixed, with the errors now bound. The repo's own discarded-error ratchet caught
the improvement and required the baseline tightened from 4 to 2 in the same
commit — the test working exactly as intended.

---

## Reported, not fixed

- **Leaderboard, high-hand and rake-race prize pools are stored, displayed, and
  never distributed.** `promotion_leaderboards.prize` is read and rendered;
  nothing anywhere writes it. There is no high-hand scorer and no leaderboard
  payout job. Currently dormant — zero leaderboard rows exist — but a club that
  advertises one today would take entries and pay nobody.
- **The rakeback settlement watermark advances over failed recomputes.**
  `failures` from `fn_rakeback_recompute_periods` is counted, logged, and then
  the durable cursor moves past those rake records anyway. It self-heals only if
  another record lands in the same club and the same ISO week; a failure on a
  week's last batch is permanent, and the same figure selects the tier band, so
  a shortfall compounds. The file already defines a `'halted'` state for exactly
  this and uses it only for read failures.
- **A split pot shares the mystery chest but not the regular/PKO bounty.**
  Carried over from the previous pass — splitting a PKO head is a rule, not
  arithmetic, and is Dan's to make. It is no longer silent.

---

## Two more, found by finishing the sweep

**The guard caught the next asset, from a different author, one day later.**
The final table art was redrawn on main today and it fixes the seat-plate
misalignment properly — `sideRailStep` 113 → 20.7, better than my own
machine-cleaned attempt, so main's version is the one kept and mine was
dropped. But the new export arrived carrying the white matte Dan said must
never be there: **83.2 against a limit of 20**. Run through
`scripts/dev/table-skin-defringe.py`: 83.2 → 0.3, alpha untouched, dimensions
unchanged. This is exactly what the guard was written for.

**A failed rakeback recompute no longer advances the watermark.**
`_runSettlementInner` counted `failures` from `fn_rakeback_recompute_periods`,
logged the number, and then moved the durable cursor past those `rake_records`
anyway, returning `'idle'`/`'more'` — although this same file defines
`'halted'` as _"a read failed: the cursor did NOT advance"_ and already uses it
for precisely that, twice.

It does not self-heal. Recompute rebuilds a (club, week) period from source, so
a failed batch only repairs itself if another rake record lands in the same
club and the same ISO week before that week closes. A failure on a week's last
batch is permanent — and it compounds, because `rake_generated` selects the
tier band (5/10/15/20/30%), so a period built from partial data can pay a
player a whole band low. That is the failure mode this service's own notes
record as having understated one player 16× and dropped them a tier.

Retrying is safe: recompute rebuilds from source and the `player_stats` applies
are keyed, so holding the cursor costs a re-read, never a double-credit.

Worth recording: there are **two** cursor advances in that method and only one
was wrong. The first sits in the `buckets.size === 0` branch — no eligible
credits, nothing to recompute, nothing that can fail — and advancing there is
correct. My first guard test matched that one and failed; the fix was to make
the test precise, not to widen the code.

---

## A live overpayment, found by conservation check

The most important find of the whole sweep, and it came from a **query against
production**, not from reading code. Eight mystery bounty events completed in
one afternoon paid out **more than their bounty pool held**:

| event                  |   pool |   paid |   over |
| ---------------------- | -----: | -----: | -----: |
| Evening Mystery Bounty | 180.00 | 191.00 | +11.00 |
| Union Mystery Bounty   | 420.00 | 445.00 | +25.00 |
| Evening Mystery Bounty | 174.00 | 192.00 | +18.00 |
| Union Mystery Bounty   | 420.00 | 439.00 | +19.00 |
| Evening Mystery Bounty | 180.00 | 189.50 |  +9.50 |
| Union Mystery Bounty   | 420.00 | 459.00 | +39.00 |
| Evening Mystery Bounty | 180.00 | 189.60 |  +9.60 |
| Evening Mystery Bounty | 180.00 | 189.50 |  +9.50 |

**140.60 of chips created from nothing in about four hours** — roughly 840 a
day at that rate. And `bounty_pool_paid` agreed with the ledger throughout, so
the counter was not merely wrong: it had been _updated to match_ the
overpayment, and nothing objected.

### The mechanism

Taking the 180.00 event apart: 30 entrants × 6.00 = 180.00 funded, and the
knockers received **exactly 180.00** — the whole pool, correctly, with
`fn_collect_bounty`'s cap doing its job. The champion was then paid 11.00 on
top as an "unclaimed" residual.

`fn_finalize_bounty_pool` computed that residual as

```sql
v_residual := bounty_pool - bounty_pool_paid;
```

under a `FOR UPDATE` lock on `tournaments`. **The lock is real but it guards
the wrong thing.** `bounty_pool_paid` is a _counter_ that `fn_collect_bounty`
increments as knockouts settle, and finalisation runs while collections are
still landing. It read a stale 169.00, called 11.00 unclaimed, paid it — and
the outstanding collections then took the pool to 180.00 anyway.

### The fix

The residual is measured from the **ledger**, which is the only record that
cannot be stale relative to the money, because it _is_ the money: sum every
`bounty` wallet transaction already written for that tournament, signed off
`type` (a debit is not a payment — the rule the tournament reconciler learned
on the 28th). Residual is what remains of the pool after that, floored at zero.
The counter is reconciled to the ledger at the same time so the next reader is
not misled the way this function was.

Verified: re-running the finaliser on all eight overpaid events now returns
**residual 0** on every one. The overpayment cannot repeat.

### What this does not fix, stated plainly

It makes **overpayment impossible**, in any ordering. It does not guarantee the
residual reaches the right player: if finalisation still runs before the last
collections, the champion takes a residual those knockouts would have claimed,
and they find the pool empty. That is a **shortfall** — visible, correctable,
and with the money still inside the pool — rather than chips minted. The
ordering question (finalise only after the reveal queue drains) is the
follow-up; this closes the minting.

The 140.60 already paid is in players' wallets. Reversing it is a clawback, and
clawbacks are Dan's call.
