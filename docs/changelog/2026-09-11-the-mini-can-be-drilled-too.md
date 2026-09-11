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
