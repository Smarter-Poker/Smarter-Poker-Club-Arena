# Phase 5: the promo bank made honest

2026-09-11. Branch `feat/one-qualifying-rule`. BBJ programme phase 5 of 5.

**The money was never wrong.** `fn_bbj_promo_bank_check()` reconciles with
`unexplained: 0` — 134,595.44 contributed, 91,291.64 swept to unions, 49,989.50
swept to clubs, 19.51 still staged, and the remainder explained by the
pre-triple-bank era it deliberately refuses to backfill. Every chip is
accounted for.

What was wrong is everything a person could read about it.

---

## The pool is the occasion, not the purse

`fn_bbj_promo_payout_atomic` has said so in its own body since Dan's ruling of
2026-09-03:

> THE PURSE (2026-09-03, Dan's ruling 3): the promo float ... the union's
> `promo_wallet` when the pool belongs to a union, otherwise the standalone
> club's `promo_balance`. **The pool is the occasion, not the purse.**

`bbj_pools.promo_balance` is a **staging slot**. `fn_sweep_bbj_promo` empties it
into the purse continuously — twelve sweeps in the hour this was measured — so
it sits near zero by design.

Every promo surface read the staging slot. Measured on production 2026-09-11:

| bank                          | owner              | chips         |
| ----------------------------- | ------------------ | ------------- |
| **THE PURSE** (what is spent) | Midway Union       | **56,291.01** |
| **THE PURSE**                 | Deep Stack Society | **21,246.52** |
| THE POOL (what was displayed) | union pool         | 14.61         |
| THE POOL                      | Deep Stack Society | 7.28          |

**77,537 chips in purses, and the jackpot page showed 14.61 and 7.28.**

The staged figure was not merely displayed. It was used **five ways** on
`BadBeatJackpotPage`: the "Promo Pool" card, the guard on the amount, the
input's `max`, the Max button, and the condition deciding whether the control
rendered at all — so the control vanished entirely whenever a sweep had just
run.

## The control could never have worked anyway

It called `fn_bbj_promo_rain`, which is a **deliberate stub**. Dan, 2026-09-03,
in the function itself:

> the splash pot has never been built or specified and is to be added later,
> once the accounting work is finished. Until its rules exist — eligibility,
> size, frequency, and what stops a single click emptying a union's promo
> float — **this moves no chips**.

`BBJService.executePromoRain` did not even map `not_built_yet`. So an operator
filled in an amount, clicked through a dialog reading _"Rain N chips ... This
can't be undone"_, and was rewarded with a toast reading, literally,
**`not_built_yet`**.

It is **removed, not disabled**. A disabled control still advertises a feature,
and CLAUDE.md 10.12 is explicit that a thing which looks live and is not is the
defect.

> **And then the service itself went.** Removing the only method left
> `export const BBJService = {}` plus a `BBJPool` type nothing imported — an
> empty exported object is precisely the thing 10.12 forbids, so the file, both
> barrel exports and an archived test's dangling import are gone. The law
> asserts the file's **absence**.

## The operator bar drew a flow as a slice

`BBJAdminAnalytics` rendered _"Pool Split — Main / Backup / Promo"_ and sized a
promo segment from `promo_balance`. At 14.61 against a 94,401 total that is
**0.007% of the bar** — telling every operator that promo gets essentially
nothing.

Promo gets **26.1% of every raked chip**. It is not in the bar because it has
already been swept to the purse. The bar now draws only the two banks the
jackpot actually holds, and says so underneath.

## What replaced it

`fn_bbj_promo_facts(p_pool_id)` (migration `20260911170328`) answers what the
surfaces were guessing at: the purse and its kind, the staging slot, what the
slice has contributed and what has been swept, and the rate — **observed from
the contribution rows, never a constant**, because it has varied by stakes tier
and over time, and pre-triple-bank rows carry NULL portions that must not count
as zero. Same reasoning `fn_bbj_promo_bank_check` already used.

It is operator data, gated exactly as phase 3 gated the mini's runway: the
function names its own actor with `auth.uid()`, pre-login roles hold no
EXECUTE, and a non-operator gets **NULLs rather than zeros** — a purse withheld
and an empty purse are different facts.

Proved end to end in a transaction that was rolled back (11.5 — the error is
the success case):

```
AS SERVICE ROLE  -> is_operator=f, every figure NULL
AS CLUB ADMIN    -> is_operator=t purse_kind=club purse=21,253.80
                    staged=3.19 contributed=21,268.02 swept=21,254.30 rate=25.00%
```

The page had been showing that operator **3.19**.

The jackpot page now tells the people who can act on it where the slice goes,
what the purse holds, and how it is actually disbursed: an owner sends it with
`fn_promo_disburse` from the wallet page, and leaderboards are the one
automatic promo payout. The splash pot is named as not built, rather than
mimed with a button.

## Pinned

`tests/the-promo-slice-names-its-purse.law.test.ts` — no client surface calls
`fn_bbj_promo_rain` or `executePromoRain`; the dead control and its state are
gone rather than disabled; the read names the purse both ways; the rate is
observed and not a constant; the function names its actor and no pre-login role
holds it; the page reads the purse; and the operator bar draws only the two
banks, with the promo segment gone from both the markup and the total that
sizes it.

The law asserts against the files **with comments stripped**. These files
deliberately explain in prose what was removed, quoting the old button labels
and the old bar heading; asserting on raw text would make the explanation
itself illegal and push the next author to delete the reasoning to get the law
green.
