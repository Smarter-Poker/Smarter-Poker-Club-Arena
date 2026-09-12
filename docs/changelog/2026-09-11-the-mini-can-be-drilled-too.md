# The mini can be drilled too

2026-09-11. Branch `fix/bbj-the-mini-can-be-drilled-too`. Phase 2 of 5 of the
post-audit programme.

Phase 4 of the original programme built the drill so the **main** jackpot payout
could be proved end to end with real chips at a drill club: a real showdown,
real players, real board, real pot, and only the verdict injected.

The mini got nothing.

It is a separate product — its own reserve (`backup_balance`), its own flat
tiers, its own payout RPC (`fn_bbj_mini_payout`), its own refusal reasons — and
the only way to watch one pay has been to wait for a real one. Twenty-one have
happened in the mini's whole life. That is not a test cycle, it is a vigil.

## And the drill was actively hiding it

`claimBBJDrill` is tried when `detectBBJHit` refused — which is **exactly** the
case the mini exists to catch — and the drill's verdict then took the main
branch:

```ts
const effectiveBbjResult = drillResult ?? bbjResult;
if (effectiveBbjResult.hit) {
  /* main */
} else {
  /* mini detection */
}
```

So on a drill table, a hand that genuinely qualified for the mini never reached
mini detection at all. "One hand pays one jackpot" makes that the right
_outcome_; nothing made it a decision anybody had taken, and nothing let an
operator drill the other one.

## What an arm carries now

`bbj_drill_arms.kind` — `'main'` or `'mini'`, defaulting to `'main'` so every
existing caller and every historical row means exactly what it meant. The claim
hands the kind back, because the engine cannot read the arm row and must not
guess: **a mini drill taking the main branch would pay a share of the pool for
an arm that asked for a flat tier out of the reserve.**

## The guards are the mini's own, not the main's

A main arm is refused above a 1,000.00 main balance, so a drill can never pay a
large jackpot. A mini pays a flat tier amount already capped by the tier table,
so the ceiling is structural and the danger is the opposite one: **arming
against a reserve that cannot cover the payout**, which would fire the arm and
then have `fn_bbj_mini_payout` refuse it — an operator burning their one arm and
watching nothing happen. That is the failure the main arm's own _"refuse before
claiming, never after"_ comment was written about.

So a mini arm additionally requires:

- the mini is **enabled** on that pool (`mini_is_off_for_this_pool`);
- the reserve covers the **largest enabled tier above its floor**
  (`reserve_cannot_cover_a_mini_payout`), and at least one tier is enabled
  (`no_mini_tier_is_enabled`).

Largest rather than this table's tier, so the guard needs no
big-blind-to-tier mapping in SQL — that mapping lives in the engine and
duplicating it here is how two halves of one rule drift apart. Conservative by
construction: if the largest is affordable, every tier is.

Everything the main arm refuses, a mini arm refuses too — platform admin only,
and **never a union pool**, checked before the kinds diverge so neither branch
can miss it. The mini pays out of that same pool's reserve.

## Proved in a rolled-back transaction

One MCP call, one self-aborting `DO` block (11.5 — the error is the success
case), as a real platform admin:

```
pool a7a65cfc (club, not union)   backup 13,697.93   floor 5,000.00
                                  largest tier 1,500.00   headroom 8,697.93

unknown kind  -> {"ok": false, "reason": "unknown_drill_kind", "kind": "sideways"}
union table   -> {"ok": false, "reason": "union_pool_is_never_a_drill_target"}
MINI ARM      -> {"ok": true,  "kind": "mini", "armId": ...}
main arm      -> {"ok": false, "reason": "pool_above_drill_ceiling",
                  "balance": 19700.66, "ceiling": 1000.00}
claim         -> {"claimed": true, "kind": "mini", ...}
```

That last pair is the point of the whole phase: on this pool the **main** cannot
be drilled — 19,700.66 is far above the ceiling — and the **mini** can, because
its guard asks about its own reserve. The arms table was back to zero rows
afterwards.

## The defect this phase introduced, and caught

`CREATE OR REPLACE FUNCTION` matches on the **argument list**. Adding `p_kind`
therefore created an **overload**: `fn_bbj_arm_drill(uuid, text)` and
`(uuid, text, text)` both existed, and an existing caller passing
`(table, note)` resolved to the exact two-argument match — the **old body**,
with no kind and none of the mini's guards.

Two definitions of one rule, with the older one winning for every caller that
had not been updated. That is exactly the drift this sweep has spent the
evening closing, introduced by the fix for it. It was caught by reading
`pg_proc` after applying rather than assuming the replace had replaced.
Migration `20260911230639` drops the two-argument form and refuses to finish
unless exactly one definition survives and it is still callable the old way.

## Pinned

`server/src/engine/theDrillArmsATableNeverADeck.law.test.ts` — the existing law
gains six pins: an arm carries a kind and an old row still means main; a mini
arm is guarded on the mini so it cannot fire into a refusal; the tier bound is
the largest enabled so no big-blind mapping is duplicated in SQL; a union pool
is out of reach for **both** kinds and is refused before they diverge; the main
arm keeps every guard it had; and a mini drill records `miniRule: 'drill'` so a
synthetic verdict is never filed under a real rule's name.

Two pins **moved** with their mechanism in the same commit (rule 8, never
weakened): the drill-consulted-only-on-a-miss pin now reads the destructured
claim and asserts `effectiveBbjResult` takes a drill's verdict only for a main
arm; and the log pin now requires the line to name **which** drill fired, which
is stronger than the literal it replaced.

---

## What the adversarial review of this phase found

The change above was reviewed with the instruction to break it. Ten findings —
three defects, three gaps, four nits — and every one is closed in the same
branch. Three of them were the same mistake in three costumes: **the guard I
wrote was not the guard the payout applies.**

### 1. The mini arm's guard was not the payout's guard (defect)

```
arm    : backup_balance - mini_reserve_floor  <  largest_enabled_tier
payout : backup - fn_bbj_parked_reserve(pool,'backup') - THIS tier's amount < floor
```

Three holes, each of which fires the arm and then has the payout refuse it —
the exact failure the guard was written to prevent:

- **the parked reserve was ignored.** `fn_bbj_parked_reserve` sums unpaid
  `bbj_unclaimed_shares`: chips still sitting in `backup_balance` and already
  owed to somebody. A pool with parked shares passed the arm and got
  `reserve_at_floor` from the payout.
- **the wrong tier's enabled flag.** The arm checked the largest _enabled_
  tier's **amount**; the payout checks **this table's** tier's `enabled` bit.
  With `nosebleeds` on and `nano` off, arming a nano table passed and the
  payout refused.
- **the variant was never checked.** A mini drill bypasses `detectMiniBBJHit`
  entirely, so the arm was the only place it could be asked — and it did not.
  A mini drill on a Short Deck table would have paid a mini for a variant the
  jackpot does not cover, and filed it in the winners history.

**And the reasoning that justified the shortcut was wrong about the facts.**
The first cut said using the largest tier avoided "a big-blind-to-tier mapping
duplicated in SQL". That mapping was _already_ in SQL: `bbj_stakes_tiers`
carries `min_bb`/`max_bb`, and `fn_bbj_mini_for_club` already joins it to
compute exactly this predicate. The argument was invented to defend a
simplification, and the simplification was the defect.

### 2. The arm recorded the wrong bank (defect)

`pool_balance_at_arm` stored `main_balance` for a **mini** arm — the one number
a mini arm has nothing to do with — and handed it back to the operator as
confirmation, and put it in the `financial_alerts` context. A mini arm now
records the bank it is armed against and names it: the answer carries `bank`,
`balance`, `kind` and, for a mini, the `tierId` it will pay.

### 3. `already_armed` was checked last (gap)

Pre-existing, and **widened by this phase from two masking refusals to five**:
an operator with an open arm was told `pool_above_drill_ceiling` and went to
chase a pool balance when the fix was to fire or clear the arm they already
had. It is now asked as soon as the table is known, before any balance is read.

### 4. The arms listing could not tell the kinds apart (gap)

`fn_bbj_drill_arms()` is the surface the runbook sends an operator to, and it
did not return `kind` — so a mini arm and a main arm looked identical, beside a
`pool_balance_at_arm` that meant a different bank for each.

### 5. `detected - drills` became false (defect)

`bbjDrillsFiredTotal` is documented in `engineInstruments.ts` **and in the
runbook** as the subtrahend in _detected minus drills = genuine bad beats_. A
mini drill incremented it while incrementing the **mini's** detected counter —
so that subtraction under-counted genuine main bad beats by one per mini drill
and could go negative in any window where minis were drilled and no main
jackpot hit.

That is the same error the block directly above it in that file was written the
same day to fix, made again one counter along. Each family has its own drill
counter now, and the runbook states the two subtractions explicitly and says
never to do one across families.

### 6. The runbook still documented a feature nobody could use (gap)

Arming is SQL by hand — there is no UI — so the runbook **is** the interface. It
still showed the two-argument call, and its refusal table listed five reasons
and none of the five new ones. It now carries both calls, all the mini
refusals, the `bank`/`kind`/`tierId` in the answer, and a note that a mini arm
deliberately does **not** check the 1,000 ceiling: that ceiling bounds a share
of a pool, and a mini pays a flat tier the tier table already bounds. Which is
why a long-running club whose main pool is far above the ceiling can still be
drilled for a mini.

### Nits, all closed

- `expect(migCode).not.toMatch(/big_blind/)` was trivially true — the token
  appears nowhere in that file, not even in prose. Replaced with assertions
  that fail if the fix is removed.
- `expect(drill).toMatch(/kind: 'main' \| 'mini'/)` pinned a **type
  annotation** while its comment claimed it pinned a runtime default; it would
  have survived the default being changed to `'mini'`. It now pins the ternary.
- `'drill'` escaped the declared `miniRule` union by way of a widening
  assignment plus a cast — it typechecked, and no compiler would have caught a
  typo. `'drill'` is in the union now.
- The grants are declared in two migrations. Harmless and idempotent; recorded
  rather than tidied, because the second one is the file that makes the guard
  pass on a rebuild.

### And a trap that caught me for the fourth time

The corrective migration asserts at apply time that the arm no longer records
the main balance — so it **quotes** the forbidden string. A law asserting that
absence over the whole file matched the check that exists to forbid it. The law
slices to the function bodies; the runtime assertion stays, because it is the
one that reads the _live_ body rather than the file.

## Proved again, rolled back

```
table bb=20.00 variant=plo4 parked=0

MINI ARM       -> ok  bank=backup  balance=13,699.07  tierId=high
second arm     -> already_armed                    (was pool_above_drill_ceiling)
tier disabled  -> mini_disabled_for_this_tier      (the payout's question)
short_deck     -> variant_is_not_eligible_for_the_jackpot
```

The balance in that first line is the **backup** bank. Before the fix it read
19,700.66 — the main pool.
