# Spin economics — verified against 5,091 live games

**Date:** 2026-08-22 · **Repo:** Smarter-Poker-Club-Arena
**Migration:** `supabase/migrations/20260822230000_spin_no_extra_rake.sql`
**Tests:** `tests/config/spinNoExtraRake.test.ts` (12)

`src/config/spinSpec.ts` is an unusually careful document. It sets one rule —
`E[multiplier] = seats × (1 − rake_rate)` — and derives everything from it. What
had never been done is check whether the live games obey it. This is that check,
plus the one real hole it found.

---

## 1. The draw is correct

Every Spin that has ever started, by drawn multiplier:

| multiplier | all time | share  | spec share |
| ---------- | -------- | ------ | ---------- |
| 2          | 3,190    | 62.66% | 47.72%     |
| 3          | 1,334    | 26.20% | 39.68%     |
| 4          | 215      | 4.22%  | 9.00%      |
| 5          | 242      | 4.75%  | 2.50%      |
| 10         | 102      | 2.00%  | 1.00%      |
| 25         | 8        | 0.157% | 0.075%     |
| 50         | 0        | 0      | 0.010%     |
| 100        | 0        | 0      | 0.0101%    |

Read alone that looks alarming. It is not — it is **three different tables
averaged together**. `spinSpec.ts` replaced three that disagreed (EV 2.999994 /
2.75 / 2.2415) and landed on 2026-08-20. Split at the cutover and the picture
resolves completely:

| window            | games | realized E[mult]                            |
| ----------------- | ----- | ------------------------------------------- |
| before 2026-08-20 | 2,710 | wanders 2.10 – 4.17 daily, **zero 4x ever** |
| 2026-08-21        | 1,127 | 2.7223                                      |
| 2026-08-22        | 1,254 | 2.7616                                      |

Spec expectation is **2.763773**. Post-cutover, n = 2,381:

| multiplier | observed | expected | share obs / spec |
| ---------- | -------- | -------- | ---------------- |
| 2          | 1,149    | 1,136    | 48.26% / 47.72%  |
| 3          | 937      | 945      | 39.35% / 39.68%  |
| 4          | 208      | 214      | 8.74% / 9.00%    |
| 5          | 59       | 60       | 2.48% / 2.50%    |
| 10         | 27       | 24       | 1.13% / 1.00%    |
| 25         | 1        | 1.8      | 0.042% / 0.075%  |
| 50+        | 0        | 0.5      | —                |

Realized E = **2.7429** against a design of 2.763773; the SD of a single draw is
1.6229, so the standard error at n = 2,381 is 0.033 and the gap is well inside
one sigma. The `4x` tier — absent from every pre-cutover game, because the old
tables did not have it — appears at 8.74% against a designed 9.00%.

**The ladder is paying what it advertises.** No 100x has ever landed; expected
in the post-cutover window is 0.24 games, so that is unremarkable rather than a
locked tier. `can_draw_100x` currently reads true, so it is reachable.

Also checked and clean: no Spin has ever drawn a multiplier that is not on the
ladder (0 all time), and no Spin has ever lacked a `club_id`.

## 2. The hole: a rule everything believed and nothing enforced

`spinSpec.ts`, in capitals:

> A Spin is NOT priced like an MTT. There is no "10 + 1" ... **THEY ARE STRAIGHT
> JUST 10 BUY IN... NO ADDITIONAL RAKE IS ADDED.** ... So the buy-in is the
> whole charge, and `buy_in_fee` MUST be 0 on a Spin.

and, on the cost of breaking it:

> Had the player been charged buy-in PLUS 8% on top, the true edge would have
> been 14.7%, which is not what any room advertises.

**7,120 of 9,603 spins carried a fee.** Every one created before 2026-08-20
19:23 UTC, when the spinSpec cutover fixed the writer. Since then: zero.

That is a pricing bug that has already stopped. What had not stopped, and is the
reason this belongs in an audit rather than a footnote, is the **second-order
effect**. Both things that watch the reserve skip a fee-bearing Spin:

```
fn_spin_sweep_unbooked ... AND COALESCE(t.buy_in_fee, 0) = 0
v_spin_reserve_health  ... AND COALESCE(t.buy_in_fee, 0) = 0   (unbooked_24h)
```

Each filter is defensible alone — settling a game against economics it does not
match would be worse than leaving it. Together they meant the backstop skipped
the game **and** the counter that exists to notice skipped games did not count
it. The one shape of broken game nothing could fix was the one shape nothing
could see.

**2,116 spins ran and were never booked to `spin_reserve_ledger` for exactly
this reason:**

```
collected from players      13,512.00
charged as fee ON TOP        1,351.20
should have entered reserve 12,431.04
prizes that never left it   11,488.00
```

No alert ever fired. `unbooked_24h` has read 0 throughout.

## 3. What was changed

1. **A `NOT VALID` CHECK constraint**, `tournaments_spin_no_extra_rake`. New and
   updated rows must satisfy it; the 7,120 historical rows are left as
   historical fact and no table scan is taken. It tests **both** `variant` and
   `tournament_type` — they agree on every row today, but `spinReveal.ts` checks
   both on purpose and the union-reserve audit records that reading only one
   "is how it quietly returns false for half the Spins in the system".

   The migration refuses to install itself if any fee-bearing Spin was created
   in the previous 24 hours. A constraint today's writers would immediately
   violate is a broken deploy, not a guard.

2. **`v_spin_reserve_health.fee_violations_24h`**, and `spin_charged_a_fee` in
   `/api/cron/spin-sweep` (World Hub PR #665). The exclusions stay; the silence
   does not. The constraint should keep this counter at zero — if it is ever
   non-zero, either the constraint was dropped or something is writing around
   it, and an operator hears about it within fifteen minutes.

**Proven, not assumed.** Against production, inside a transaction that was then
rolled back:

```
spin given a fee (0.90 + 0.10)  -> REFUSED (check_violation)
spin kept fee-free               -> ACCEPTED
non-spin with a fee              -> ACCEPTED  (unaffected)
historical fee-bearing spins     -> 7,120 still present
fee_violations_24h               -> 0
```

The probe uses 0.90 + 0.10 rather than 1.00 + 0.10 deliberately. A trigger,
`fn_enforce_whole_dollar_buyin`, already refuses a fee that does not sum to a
whole total, and triggers fire **before** check constraints — so a 1.00 + 0.10
probe would only ever prove the older guard works. Splitting a whole total is
precisely the shape that trigger permits and this constraint must not: for a
Spin, 0.90 + 0.10 is still a fee, and a fee is still what makes the sweep and
`unbooked_24h` look straight past the game.

## 4. Open — and it is Dan's call, not an agent's

**The 2,116 historical games are still unbooked.** Booking them retroactively
moves real money through the reserve pool, so it is deliberately not done here.
The numbers are in §2. The three options, as I see them:

1. **Leave them.** They are outside every 24h window, so nothing will ever
   surface them again. The reserve's ledger simply does not contain that era.
2. **Book them at the fee-era economics.** Requires deciding whether the extra
   1,351.20 the players were charged counts as rake (house) or as reserve.
3. **Book only the net.** 12,431.04 in minus 11,488.00 out is **+943.04** to the
   pool. Simpler, but it loses the per-game record.

Whichever, `fn_spin_sweep_unbooked` would need its fee filter relaxed for a
one-off backfill, which is exactly why that should be a deliberate, separate,
reviewed operation and not a side effect of this work.

**Also worth a decision, unchanged from the union-reserve audit:** whether the
seed idempotency key should be owner-scoped.
