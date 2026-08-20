# Spins: how the format works, and what ours is actually doing (2026-08-20)

Dan asked for research into how Spin formats work — how the prize pool is
funded, how the multiplier is drawn, how it is raked, and how clubs and unions
get credited — as groundwork for building the Spins animation.

The research turned up a finding that outranks the animation, so it leads.

---

## THE HEADLINE

**We have three different Spin multiplier tables, they disagree with each
other, and the one actually running is not the one that was designed.**

| Table | Where | Expected multiplier | House take beyond the fee |
|---|---|---|---|
| **A. Designed** | `src/services/TournamentService.ts` `SPIN_BONUS_TIERS` | **2.999994** | **0%** — fee only, as documented |
| **B. Actually running** | `server/.../TournamentRecurringService.ts:203` | **2.75** | **8.3%** of every buy-in, unbooked |
| **C. Engine fallback** | `server/.../TournamentManagerBase.ts` `SPIN_STANDARD` | **2.2415** | **25.3%** of every buy-in, unbooked |

Table A's own comment states the intent plainly:

> *"House keeps $0.30 (10% rake) — this is the ONLY house revenue"*

That is not what happens. Table B is what the scheduler rolls from, so the real
house take on a Spin today is the 10% fee **plus** roughly 8.3% of every
buy-in, and the second part is **recorded nowhere**.

### Production evidence

2,091 COMPLETED spins, every one 3-handed:

| | |
|---|---|
| Buy-ins collected | **13,335.00** |
| Prize pools paid | **11,349.00** |
| Difference | **1,986.00** |
| Rake actually booked to `rake_records` | **825.60** |
| Observed average multiplier | **2.5753** (design says 3.0) |

So ~**1,986** was retained beyond the prize pool, and only the ~826 of entry
fees reached the ledger. The remaining **~1,160 exists in no ledger at all** —
not in `rake_records`, not in any club balance, not in any union statement.

### How the money silently disappears

`fn_register_for_tournament` does the right thing: each player is charged
`buy_in + fee`, the fee is written to `rake_records` with the `club_id` (so it
reaches the club and its union normally), and the buy-in is **added** to
`prize_pool`. After three registrations `prize_pool = 3 × buy_in`.

Then `TournamentManagerBase` starts the tournament and does this:

```ts
const prizePool = Math.round(buyIn * spinMultiplier * 100) / 100;
await supabase.from('tournaments').update({ prize_pool: prizePool, ... })
```

It **overwrites** the accumulated pool with `buy_in × multiplier`. Whenever the
multiplier is below 3.0 — which is ~93% of the time — the difference between
what players contributed and what the pool now holds simply ceases to exist. No
debit, no credit, no record.

This is not theft and nobody hid it; it is what happens when the funding rule
lives in one file and the payout rule lives in another. But it means:

- **The house edge on Spins is invisible.** It cannot be reported, reconciled,
  or shared with clubs and unions, because no row is ever written for it.
- **Club and union revenue is understated.** Under the current split, clubs earn
  from `rake_records` only, so they see the 10% fee and none of the ~8.3%.
- **The reconciler cannot catch it.** `fn_tournament_payout_reconcile` verifies
  the pool was fully disbursed. It has no way to know the pool should have been
  larger.

### And the bonus pool was never built

Table A's design is a **jackpot pool** model, and describes it precisely:

> *"Pool deposit = $1.00 per spin (always) / Pool draw = bonusBuyIns × buy_in"*

Every tier carries a `bonusBuyIns` figure for exactly this. A table exists:
`spin_bonus_pools`.

**It has 0 rows, after 2,091 completed spins.** Nothing writes to it. No server
code reads `bonusBuyIns`. The mechanism that was supposed to fund the big
multipliers was designed, given a table, and never connected.

---

## 1. How the format works, generally

A Spin is a 3-handed hyper-turbo Sit & Go where the prize pool is a **random
multiple of one buy-in**, drawn before the cards. The draw is the product; the
poker is the delivery mechanism.

### The identity that makes it solvent

For an *n*-handed Spin at buy-in *B* with rake rate *r*:

```
E[multiplier] = n × (1 − r)
```

Everything else is free design. Which multipliers exist and how they are
weighted is a product decision; only the expectation is a constraint. At 3
players and 7% rake, `E[mult] = 2.79`. At 10%, `2.70`.

Two ways to satisfy it:

- **Direct (PokerStars, GGPoker).** Weights are tuned so the expectation lands
  on target every spin. The operator absorbs the variance of a jackpot hit.
- **Pooled (what Table A designed).** Every spin deposits a fixed amount into a
  bonus pool; big multipliers draw from it. `E[draw] ≤ E[deposit]` keeps the
  pool solvent, and the operator's exposure is bounded by the pool balance
  rather than by a single jackpot. Slower to hit big numbers early, but it
  cannot bankrupt a small club.

**For a club/union platform the pooled model is the right one**, and it is what
was designed here — it just needs connecting.

### What the majors do

| | PokerStars Spin & Go | GGPoker Spin & Gold |
|---|---|---|
| Rake | 8% at micro, tapering to 5% at $100+ | 7% flat |
| Seats | 3 | 3 and 6 |
| Top multiplier | up to 12,000× | up to 200,000× on selected buy-ins |
| Winner-take-all below | 10× | 8× |
| At 10× | 80 / 20 | — |
| At 25×+ | 80 / 12 / 8 | 41.7 / 33.3 / 25 at jackpot, more places at the top tier |
| Extras | blind length scales with multiplier (1 min at 2×, 5 min at 100×) | optional insurance that refunds the buy-in on a 2× |

Two ideas worth stealing:

1. **Blind speed scaling with the multiplier.** A 2× is over in minutes; a 100×
   deserves a real tournament. Costs nothing and directly serves Dan's standing
   instruction to slow down for the moments that matter.
2. **More paid places as the multiplier climbs.** Winner-take-all at the bottom,
   three (or more) paid at the top. Ours currently pays 100% to first at every
   tier — a 100× where second gets nothing is a worse story than one where all
   three walk away up.

---

## 2. How ours is raked and credited today

The fee path is correct and already integrates with the club/union system:

```
player pays buy_in + fee
  fee   -> rake_records(club_id, is_tournament, tournament_id)
             -> club rake wallet -> union statements / agent commission
  buy_in -> tournaments.prize_pool
             -> overwritten at start with buy_in × multiplier   <-- the leak
```

So: **the fee reaches clubs and unions correctly. The multiplier margin reaches
nobody, because it is never written down.**

---

## 3. Recommendation

1. **Pick one table and delete the other two.** Three tables with three
   different expectations is how this drifted. `SPIN_BONUS_TIERS` is the
   documented one and should win.
2. **Connect `spin_bonus_pools`.** Deposit `1 × buy_in` per spin, draw
   `bonusBuyIns × buy_in` on a bonus tier, and record both. That makes the big
   multipliers genuinely funded and bounds the club's exposure.
3. **Stop overwriting `prize_pool`.** Set it from the pool mechanics and write a
   ledger row for every movement, so the margin is visible and reconcilable.
4. **Book the house margin as rake** so clubs and unions actually earn from it,
   or deliberately set `E[mult] = 3.0` and take only the fee — either is
   defensible, but it should be a decision rather than a side effect of which
   file rolled the number.
5. **Scale blind length and paid places with the multiplier.**

Items 1–4 are money-path changes and need Dan's sign-off on the intended
margin before anything is applied. Nothing in this document has been changed in
production; this is research plus a defect report.

---

## Sources

- [PokerStars Spin & Go: multipliers, probabilities, structure — WorldPokerDeals](https://worldpokerdeals.com/blog/pokerstars-new-spin-go-multipliers-and-1000-spins)
- [Spin & Go prize multipliers and prize pool distribution — PokerStars](https://www.pokerstarsnj.com/help/articles/trn-sag-prizes/)
- [PokerStars Spin and Go: New Payouts Structure Unveiled — RakeRace](https://rakerace.com/news/poker-rooms/2023/07/27/pokerstars-spin-and-go-new-payouts-structure-unveiled)
- [GGPoker Spin & Gold 2026: buy-ins, payouts, odds, rake — YourPokerDream](https://www.yourpokerdream.com/online-poker/spingo-jackpot-tournaments/spin-gold-ggpoker-network/)
- [GGPoker Spin and Gold complete guide — WorldPokerDeals](https://worldpokerdeals.com/blog/spin-gold-the-ultimate-guide-on-ggpoker-network)
- [Spin & Gold — GGPoker](https://ggpoker.com/poker-games/spin-gold/)
