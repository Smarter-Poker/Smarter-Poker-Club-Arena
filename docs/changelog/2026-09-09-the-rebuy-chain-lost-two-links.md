# The rebuy chain lost two links

2026-09-09

## The number that gave it away

`rebuy_prompt_until` is cleared by exactly one statement on this platform - the
last line of `fn_after_tournament_rebuy`. Across every RUNNING tournament:

| rebought players, prompt **still set** | rebought players, prompt **cleared** |
| -------------------------------------- | ------------------------------------ |
| **70**                                 | **1**                                |

That is what a function nobody calls looks like.

## What happened

`process_tournament_rebuy` is a stack of wrappers, each renaming its
predecessor to `..._before_<what_it_added>` and calling it. Read live this
morning, the chain was:

```
process_tournament_rebuy
  -> _before_maintenance_announcement_gate
      -> _before_one_minute_addon
          -> _before_atomic_live_seat_lock        (the core)
```

and **two functions were stranded, called by nothing at all**:

```
_before_atomic_pool_gate  ->  _before_bounty_guard_20260907
                                 -> _before_one_minute_addon
```

`_before_maintenance_announcement_gate` was added on 2026-09-08. It
re-implemented the lifecycle/clock gate itself and then jumped straight to
`_before_one_minute_addon`, with this reasoning in its body:

> Call the audited money core directly. The superseded one-minute wrapper is
> retained under its historical name but had closed rebuys at the base level
> even during the add-on clock.

**The clock fix was right.** What went with it was not intended:
`_before_one_minute_addon` is not the core, it is a _lower_ wrapper, and jumping
to it drops the two layers above it.

## What stopped happening

1. **`fn_after_tournament_rebuy`** - its only caller is the pool gate. It
   resolves the player's pending knockout candidate to `rebought` and clears
   `rebuy_prompt_until`.
2. **"Bounty Settlement Pending - Rebuy Or Re-Entry Cannot Replace This Entry
   Generation Yet"** - a rebuy could replace an entry generation whose bounty
   was still unsettled.
3. **"A Zero-Stack Bounty Entry Cannot Take An Add-On"**.
4. **"Bubble Protection Already Paid - This Result Cannot Be Resurrected"**.
5. `fn_emit_tournament_manager_wake` after a successful purchase.

Nothing failed. No test went red. A layer simply stopped being reached, and the
only evidence was a column that had stopped being written.

Downstream, measured the same morning: **147 entrants `playing` with no seat, 57
of them holding chips** - the population `poker_tournament_seatless_phantoms`
counts - with their knockout candidates `pending` for ever, because the one
thing that resolves them was unreachable.

## The fix

### Guard 1: put the links back

`_before_maintenance_announcement_gate` now calls `_before_atomic_pool_gate`.
Its own lifecycle/clock gate still runs first and still passes the authoritative
`v_t.current_level` down; the pool gate forwards `p_current_level` unchanged and
`_before_one_minute_addon` is still reached underneath, so **the 2026-09-08
add-on-clock fix is preserved exactly**. Nothing is bypassed and nothing is
re-ordered - two layers are put back where they belong.

Every restored layer is strictly _more_ restrictive - four extra refusals - plus
one extra action that only resolves rows and clears a prompt. It cannot pay
anyone more, credit any extra chips, or open a window that was closed.

Verified live after applying:

```
process_tournament_rebuy
  -> _before_maintenance_announcement_gate
      -> _before_atomic_pool_gate              restored
          -> _before_bounty_guard_20260907     restored
              -> _before_one_minute_addon
                  -> _before_atomic_live_seat_lock
```

### Guard 2: make the restored layer safe before it is reachable

As written, `fn_after_tournament_rebuy` **raised**
`integrity_constraint_violation` when a player carried more than one unresolved
knockout generation - and it runs _after_ the wallet debit and the chip credit,
in the same transaction, so the raise rolled the whole rebuy back. Re-linking
without this would have turned a dormant refusal into a live one that takes a
player's rebuy away, permanently, for anyone in that state.

The correct reading was already written down today, in
`fn_eliminate_tournament_player_atomic`:

> MORE THAN ONE PENDING GENERATION IS A REBUY, NOT AN AMBIGUITY. The unique
> constraint is `(tournament_id, eliminated_user_id, seat_joined_at)`, so two
> pending rows for one player are two DIFFERENT seat generations: the player
> busted, bought back in, took a new chair and busted again. The older
> generation is therefore settled by definition - it is what 'rebought' means.

So this applies the same rule, in the same words: resolve _every_ pending
generation rather than refusing. No money decision moves - the bounty guard
restored by Guard 1 sits above this and still refuses a rebuy while the latest
generation owes an unsettled bounty.

## How the edit was made

Both functions are read **live** with `pg_get_functiondef` and changed by
literal `replace()`, with the anchor and two sibling landmarks asserted first,
so a body that has moved on aborts rather than being silently rewritten from a
stale copy. Three post-checks then prove the result rather than assuming it:
the gate calls the pool gate, the pool gate calls the clean-up, and the clean-up
no longer raises. Pattern established by
`20260828041248_the_union_law_check_follows_the_money.sql`.

**Recorded at the version production actually assigned.** The Supabase MCP
assigns its own version, `20260909071226`, not the one
`scripts/new-migration.mjs` reserved. A file left at the reserved number would
be applied a SECOND time on a rebuild and would abort on its own anchor assert,
since the anchor is gone by then. This is the second time today that mismatch
has had to be corrected.

## Pinned

`server/src/tournament/theRebuyChainKeepsItsLinks.guard.test.ts` - nine pins,
windows bounded by `sliceDollarQuoted`:

- the gate re-links to the pool gate, not past it;
- the authoritative level is still passed down, so the add-on clock fix survives;
- the edit refuses a body that has moved on;
- **it checks the layer it re-links to still calls the clean-up before pointing
  at it** - re-linking to a pool gate that had itself lost `fn_after_tournament_-
rebuy` would restore the shape and none of the behaviour;
- the outer wrapper's own lifecycle gate is asserted as a sibling landmark;
- the clean-up is made safe _before_ it becomes reachable, and the raise appears
  exactly twice in the migration, both times as a needle;
- every pending generation resolves, not just the one row it happened to pick;
- the three post-checks exist;
- one transaction, per the production DDL policy.

## Verification

- Applied to production; the chain re-read afterwards and confirmed above.
- `npx vitest run src/tournament`: **118 files, 1224 tests, all passing.**
- `tests/unit/noFixedSizeSourceWindows.test.ts` + `tests/law-registry.law.test.ts`:
  290 passing.
- The measurement to watch: `rebought players whose prompt is still set` should
  stop growing, and `poker_tournament_seatless_phantoms` should fall. Both are
  live gauges, so neither needs a hand-written check.
