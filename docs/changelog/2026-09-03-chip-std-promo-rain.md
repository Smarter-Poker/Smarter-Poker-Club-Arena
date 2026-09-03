# The owner's splash pot: three faults, none of them visible from outside

2026-09-03, found during the pre-Phase-3 verification sweep.

> "WE WILL BUILD IN MORE PROMOTIONS THAT ARE AUTOMATED LIKE HIGH HANDS AND
> RANDOM SPLASH POTS ETC, BUT FOR NOW, PROMO'S ARE DISBURSED MANUALLY BY
> OWNERS." - Dan, 2026-09-03

`fn_bbj_promo_rain` is that splash pot. An owner presses a button in BBJService,
every seated player gets a share. It has existed, with a button, and has never
paid a chip. Three faults, and the third is the one no amount of reading the
rain itself would have found.

## 1. It drew from the bucket after the money had left it

The rain took its money from `bbj_pools.promo_balance`. The hourly sweep empties
that balance into the owner's promo float continuously. At the moment of the
probe: **6.27 chips** in the union's pool, **40,184.01** in the float it had
been swept into. Any rain worth pressing refused with
`insufficient_promo_balance`.

Now it draws on the float - the union's `promo_wallet`, or a standalone club's
`promo_balance`. The pool is the occasion the rain is named for, not the purse.

## 2. It paid into a locked bucket

Shares landed in `club_members.promo_balance`. Ruling 4B says that idea does not
exist: promo chips are ordinary chips. Shares now land in `chip_balance`,
cashable, like every other chip.

## 3. The owner was not allowed to press their own button

`fn_bbj_promo_payout_atomic` opened with:

    IF auth.role() = 'authenticated' THEN RAISE EXCEPTION 'Unauthorized'; END IF;

The rain is `SECURITY DEFINER` and its own comment says the delegation makes
"the raw RPC's revoked authenticated grant irrelevant". That is true of the
GRANT and false of this check: `SECURITY DEFINER` changes the database role, not
the request's JWT, so `auth.role()` still reads `authenticated` for an owner
pressing the button. **Every owner-pressed rain died on `Unauthorized` before it
reached a line of money code.** A rolled-back probe as the real union owner got
exactly that error.

The check never protected anything the `REVOKE` was not already protecting:
`anon` and `authenticated` hold no EXECUTE grant, so a browser cannot call it
directly, and the only way in is through a definer that has already established
who is asking - `fn_bbj_promo_rain` checks the pool's owner or a god/admin
profile before it delegates. The grant is the gate.

## The probe, after all three fixes

As the real union owner, rolled back:

    rain: success, amount 500, recipient_count 413, lands_as ordinary_chips
    union promo float  40,184.01 -> 39,684.01
    credited to players 500.00 across 413 chip_transactions rows
    member promo buckets total 0.00
    ledger  union_wallet -> player_wallet  413 rows  500.00
    CONSERVATION: 0.00

One declared ledger row per player, nothing in suspense, nothing in a promo
bucket, and the float down by exactly what the felt went up by.

## Files

- `supabase/migrations/20260903231637_a_promo_rain_falls_from_the_float_the_sweep_fills_and_lands_as_chips.sql`
- `supabase/migrations/20260903231744_the_grant_is_the_gate_on_the_promo_payout_not_the_callers_jwt.sql`
- `tests/a-promo-rain-falls-from-the-float.law.test.ts`

No caller changed: the signature and its defaults are identical, so
`fn_bbj_promo_rain`, `bbj_promo_payout` and the BBJService button all keep
calling it exactly as they did.

---

# Three detectors were timing out, not watching

Also found in the sweep, by running the repo's own `check-cron-health` gate
against production:

| job                               | failures     | cause                                       |
| --------------------------------- | ------------ | ------------------------------------------- |
| `ca-cash-pot-conservation-hourly` | 8 of 24 runs | statement timeout scanning hand history     |
| `ca-stats-money-repair`           | 9 of 45 runs | statement timeout in `ca_hand_player_facts` |
| `rake-law-wide-daily`             | 1 of 1 run   | statement timeout in `fn_rake_law_check`    |

None is a money bug. All three are **detectors**, and a detector that times out
is not raising a false alarm - it is not looking at all. The cash-pot
conservation check, the one of the three that watches chips, has been blind for
a third of the last day.

They were scheduled without a `statement_timeout`, so they inherit the database
default while the tables they scan keep growing. Each now carries a budget
suited to its cadence (600s / 240s / 900s) and the advisory-lock wrapper its
neighbours already use, so a slow run is skipped rather than piled on. Cadences
are unchanged and the migration asserts that before it commits.

`supabase/migrations/20260903232357_the_conservation_detectors_are_given_time_to_finish_looking.sql`
