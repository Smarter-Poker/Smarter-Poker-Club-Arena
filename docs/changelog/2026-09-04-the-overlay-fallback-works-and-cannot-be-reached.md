# The overlay treasury fallback works, and on production it cannot be reached

**2026-09-04.** The fallback Dan asked for on 2026-09-04 was shipped the same
day with source assertions only and carried into the handoff as
"BEHAVIOURALLY UNVERIFIED". It is verified now. It does exactly what it says.
It also cannot fire on this database as configured, because a different guard
refuses the start before it is ever consulted.

## What Dan asked for

> "IF FOR ANY REASON THAT THE MAIN BANK DIDN'T HAVE ENOUGH CHIPS, YOUR BACK UP
> PLAN IS PULLING FROM THE TREASURY WALLET AS A FALL BACK."

## The probe, rolled back (CLAUDE.md 11.5)

Two scratch tournaments cloned from a live row, a starved union bank, and one
`RAISE EXCEPTION` at the end so every write is undone and only the report
survives. Nothing was committed to production.

| Case | union bank | club treasury | shortfall | prize_pool after | treasury after | alert                                   |
| ---- | ---------- | ------------- | --------- | ---------------- | -------------- | --------------------------------------- |
| A    | 100        | 500,000       | 20,000    | **20,000.00**    | **480,000.00** | `warning: overlay_funded_from_fallback` |
| B    | 100        | 5             | 20,000    | 0                | 5 (untouched)  | `critical: overlay_unfunded`            |

The union bank was left untouched at 100 in case A: the fallback takes the
WHOLE shortfall from the treasury rather than draining the bank first and
topping up the remainder. The guarantee was met, the warning names the
fallback, and only both banks being short is still critical. That is the
behaviour the migration describes, confirmed against the live function.

## And the part the probe found by accident

Case A only reached the funding trigger because the probe first set
`clubs.guarantee_enforcement_enabled = false`. With the live value (`true`),
the status flip to RUNNING is refused before the funding trigger runs at all:

```
ERROR: 55000: Tournament cannot start because its guarantee is short by 62332.50 chips
CONTEXT: PL/pgSQL function fn_guard_tournament_start_readiness() line 10
```

Two BEFORE UPDATE triggers on `tournaments`, and Postgres fires them in NAME
order:

1. `trg_tournaments_start_readiness` -> `fn_tournament_management_readiness`
2. `zz_ca_fund_overlay_on_lock` -> the fallback

`fn_tournament_management_readiness` sets `v_bank` to the union wallet alone
when `clubs.union_id` is set. It never looks at `clubs.chip_treasury`. So for
every union-owned event the readiness guard asks "can the UNION BANK cover
this?", answers no, and raises - and the fallback that could have covered it
is three triggers away and never runs.

The same blind spot is in `trg_tournaments_guarantee_affordable`, the CREATION
gate. It refused the first version of this probe outright:

```
Club Midway Union cannot guarantee 100000.00 chips: union bank holds 66546.34,
floor 0.00, already promised 22432.50 on live events - short by 55886.16.
```

For a STANDALONE club the fallback is a no-op by construction: the readiness
bank and the fallback store are the same column, `clubs.chip_treasury`.

**So Dan's instruction is written down, correct, tested, and currently
unreachable on every path.**

## Why this was not fixed in the same pass

The fix is one line of arithmetic - let the readiness bank be
`union_wallets.chip_balance + clubs.chip_treasury` for a union-owned event, so
the guard measures the money the funding trigger can actually reach. It is also
a change to what "affordable" means for **every guaranteed event on the
estate**, which is house exposure on FUTURE events, and CLAUDE.md 10.9 reserves
that to Dan. There is a real second-order question in it too: the exposure sum
would then be pooled across two stores that are drawn from in a fixed order, so
the double-count has to be reasoned about rather than assumed away.

Measured headroom today, so the decision has numbers under it:

| Host               | bank the guard reads               | live exposure | headroom     | treasury the fallback would add |
| ------------------ | ---------------------------------- | ------------- | ------------ | ------------------------------- |
| Midway Union       | `union_wallets` 66,546.34          | 22,432.50     | 44,113.84    | 0.66                            |
| Deep Stack Society | `clubs.chip_treasury` 1,886,141.43 | 42,027.50     | 1,844,113.93 | same column                     |

Note the last cell. Even if the readiness guard were fixed today, Midway
Union's fallback store holds 0.66 chips, so nothing would change for that host
until it is funded. **The fallback is not what is protecting the Union
guarantees; the 44,113 of headroom in the union bank is.**

## What this means for the Free Buy board, concretely

Nothing bad, and by construction rather than by luck. A Free Buy guarantees 250
or 500, and the three-hour publication lead is shorter than the four-hour
cadence, so **exactly one Free Buy per host is ever open at a time**. The most
the board can add to live exposure at any instant is 500 against 44,113 of
Union headroom. It is also why a Free Buy has never yet needed the fallback:
its own rebuys and add-ons cover the guarantee at 125 entrants (standard) and
167 (feature), both inside the field cap.

`checkAndCreateFreeBuys` already handles a refusal from either guard: it
recognises the 55000 "cannot guarantee" message through `isGuaranteeRefusal`,
calls `fn_notify_guarantee_bank_short`, and skips the slot rather than
retrying. The slot has 36 more ticks inside its lead.

## Status

- The fallback: **verified working**, both branches, rolled back.
- The readiness guard's blind spot: **found, evidenced, not changed.** For Dan.
- Nothing was written to production by any probe in this pass.
