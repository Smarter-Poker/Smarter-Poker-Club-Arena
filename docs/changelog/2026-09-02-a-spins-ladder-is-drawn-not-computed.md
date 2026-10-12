# A Spin's ladder is drawn, not computed from the field size

2026-09-02. Live money bug, found while verifying a different fix.

## What was happening

Every high-multiplier Spin since **04:13 UTC today** paid second place nothing.
A 10x pays 80/20 by spec; these paid 100/0. **32 games, 1,592 chips.**

| day            | 10x games | paid one place | paid the split |
| -------------- | --------- | -------------- | -------------- |
| 08-21 .. 09-01 | 246       | 0              | 246            |
| **09-02**      | 33        | **29**         | 4              |

## Root cause

`fn_ca_fund_overlay_on_lock` is a BEFORE UPDATE trigger on `tournaments` that
fires when status moves `REGISTERING -> RUNNING` - exactly when the engine
writes the Spin draw. It then rewrote the ladder it had just seen.

Its rule is an MTT rule, pay the top `payout_percent` of the field:

```
v_places := GREATEST(1, LEAST(3, ceil(3 * 10 / 100.0)::int))   ->  1
```

On three seats that rounds to **one** paid place. The condition
`jsonb_array_length(v_existing) <> v_places` is then true for every high
multiplier, because a 10x pays two - so the drawn ladder was replaced by
`fn_ca_payout_structure(3, 10)`, which returns:

```
[{"place": 1, "percentage": 100.0000000000000000}]
```

That is **byte-identical** to the string sitting on every affected row. I
confirmed it by calling the function rather than by reading it, which is what
turned a hypothesis into a diagnosis.

## Why it started this morning

The trigger's own comment says the payout rewrite stood down while it sorted
BEFORE `fn_guard_managed_game_lifecycle`, to be _"re-enabled once the trigger
is renamed to sort after the guard"_. It is now `zz_ca_fund_overlay_on_lock`.
The rename re-enabled the rewrite.

## Why #2645 did not fix it

#2645 is a real bug and a real fix - the engine's hand-written per-field copy
dropped `payout_structure` out of `tournamentCache`. It is a _different_ bug.
The engine writes the correct ladder to the row; this trigger overwrote it
afterwards, in the same statement.

The tell: a 10x that started at **17:07:42**, five minutes after #2645
deployed, still carried the 100% stamp. Without that check I would have
reported a live money bug as fixed.

## The fix

One guard - `IF NEW.variant IS DISTINCT FROM 'spin'` around section 1. A
Spin's ladder is a property of the multiplier the wheel drew (`SPIN_TIERS`:
2x-5x pay one place, 10x pays 80/20, higher tiers pay three). It is not a
percentage of a three-player field and never was.

The guarantee-overlay half of the trigger is untouched: a Spin carries no
guarantee, so it returns at `v_short <= 0` exactly as before.

Applied to production at 17:09 and verified by mechanism: every Spin drawn
since carries the engine's compact `[{"place":1,"percentage":100}]` rather
than the trigger's scaled numeric, so the rewrite is no longer happening.

## Still owed

Back-pay for the 32 games is Dan's call, tracked in #2648. Horses are among
them and are owed the same as anyone else (CLAUDE.md 10.5).
