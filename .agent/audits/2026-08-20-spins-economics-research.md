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

---

## ADDENDUM — BUILT, 2026-08-20

Dan supplied the full specification the same day. Everything in the
recommendation above is now implemented. What changed against the research:

### The pricing question is settled, by arithmetic

Dan: *"SPINS ARE DIFFERENT THEN MTT OR SIT N GO TOURNAMENTS WHERE THEY ARE
STRUCTURED AS BUY IN + RAKE (10+1)... THEY ARE STRAIGHT JUST 10 BUY IN... NO
ADDITIONAL RAKE IS ADDED."*

The supplied reference material contradicted that in one line (*"Each player
pays $1.08"*). Dan's framing is the correct one and the frequency table proves
it rather than merely supporting it:

```
E[multiplier]        = 27,638,000 / 10,000,000 = 2.7638
buy-in only:      (3     − 2.7638) / 3     = 7.87%   ≈ the advertised 8%
buy-in + 8% on top: (3.24 − 2.7638) / 3.24 = 14.70%  ≈ nobody advertises this
```

So `buy_in_fee` is now **0** on the Spin creation path, and there is a test
asserting it — this is exactly the kind of thing a later reader "fixes" back
into the MTT shape by pattern-matching.

### The money model

```
collected   = seats × buy_in          every player pays exactly buy_in
house_rake  = rake_rate × collected   FIXED, booked to rake_records every game
reserve_in  = collected − house_rake  everything else
reserve_out = buy_in × multiplier     the whole prize, from the pool
```

The pool absorbs 100% of the variance; the house takes the advertised rake win
or lose. `E[prize] = E[mult] × buy_in = reserve_in` by construction, so the
pool is net-neutral over volume and its balance is a direct measure of
solvency.

This is deliberately simpler than the reference's *"a percentage of the surplus
from every 2x and 3x plus a fixed 0.75–1.25% contribution"*. That version leaves
the house edge varying game to game and the pool's drift hard to reason about;
this one has an invariant you can assert, and it produces the same long-run
economics.

### The gate

A high multiplier is **not eligible to be selected** until the pool can pay it
— 100× at 1.5× its own jackpot, 500× at 2.0×, measured against the highest
stake running. Excluding it from the draw rather than drawing and refusing is
what makes an unpayable jackpot structurally impossible. A CHECK constraint
enforces non-negativity at the database as well.

Rehearsed on production and cleaned back to zero rows:

- 600 draws on an empty pool never selected a locked tier
- 100× unlocked at exactly 1500 (10 × 100 × 1.5), not a cent earlier
- a 2× booked rake 2.10 = 7% of 30, prize 20
- re-settling the same tournament returned `already_settled`
- a 500× was paid **by the pool** and the balance never went negative

### Shipped

| | |
|---|---|
| `src/config/spinSpec.ts` | canonical table, mirrored to `server/src/config/`, byte-identical enforced by test |
| `supabase/migrations/20260820_spin_reserve_pool.sql` | pool state, ledger, 4 RPCs, RLS, applied |
| `TournamentRecurringService` | gated draw, `buy_in_fee: 0`, spec-driven stack/blinds/payouts |
| `TournamentManagerBase` | two hardcoded tables deleted; settles through the ledger |
| `SpinWheel` | spec ladder, locked tiers shown not hidden, payout split on the reveal |

**Tables reduced from three to one.** While writing the guards, one failed and
was right to: I had *renamed* the old table rather than deleting it, leaving a
dead copy of the exact structure that caused the drift. A test now asserts zero
hardcoded `{ multiplier, weight }` literals in either server file.

### ⚠ ONE THING DAN MUST DO

**The Reserve Pool is unseeded, so 100× and 500× are locked and Spins top out
at 50×.** That is the spec working as designed — the seed is operator money and
is explicitly not taken from player contributions — but nothing above 50× can
appear until it is funded:

```sql
SELECT fn_spin_reserve_seed(
  '<club_id>'::uuid,
  <seed_amount>,      -- ≥ 2 full 500x jackpots at the highest stake offered
  <highest_stake>,
  <ceiling>           -- suggested: 8 x that jackpot
);
```

At a $10 top stake that is a 10,000 seed with a 40,000 ceiling.

### Still open

The ~1,160 of historical margin identified above sits in no ledger and is not
backfilled. It is test-money on test tournaments, and the mechanism that
created it is now closed, so this is recorded rather than corrected.
