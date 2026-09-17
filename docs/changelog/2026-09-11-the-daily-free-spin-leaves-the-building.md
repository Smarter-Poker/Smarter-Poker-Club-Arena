# The daily free spin leaves the building

**2026-09-11. Phase 2 of 6 of Dan's "BREAK THIS DOWN INTO PHASES AND BUILD THEM
OUT ONE PHASE AT A TIME".**

Continues `docs/changelog/2026-09-11-the-promo-funding-button-is-safe-to-press-twice.md`.

## What was left standing

Dan replaced the daily free spin with a one-time welcome spin on 2026-09-10.
The replacement was built and shipped. The thing it replaced was never taken
out, and an audit found three costs of that.

`free_spin_daily_budget_diamonds` was read by **no function in the database**.
It sat at 2000 on both hosts and the operator console could still write to it. A
number a person can set that governs nothing is a trap, not a leftover.

`free_spin_enabled` had become the **welcome** spin's on/off switch while
keeping the retired feature's name. Every reader of that column was reasoning
about a different feature than the name describes, which is how the next bug
gets written by someone who trusts the name.

And `DiamondWheel` still carried a `free` prop that re-inked the rim by amount
instead of by kind. That rule was written for the retired five-prize table,
which paid diamonds only and would otherwise have come out as one flat blue. The
welcome spin draws the **real** wheel, so the rule was about to paint the real
table by the wrong scheme.

## The budget never reset, and the wheel got meaner as it filled

This is the one that mattered most. `welcome_chips_paid` only ever went up,
checked against a lifetime budget, and the check was made **tier by tier**
inside the eligibility loop: any prize that would not fit in what was left got
locked out of the draw.

So the first new member to arrive spun the whole table, and the last one spun
whatever was still cheap enough to fit. A probe on production proved it before
anything changed: with a 50 chip top prize and 25 chips of budget, the welcome
spin ran with 1 of 11 tiers locked out, and it gets worse from there.

A welcome gift that gets worse the later you join is not the gift Dan
described.

Both halves are fixed.

**The budget is a window.** `welcome_budget_period_days` (default 30, 0 meaning
for ever) makes it a rolling window rather than a lifetime cap, and the window
is **derived, not reset**: `fn_wheel_welcome_spent` sums the welcome spins
inside it straight from `wheel_spins`. There is deliberately no counter to zero
and no job to zero it. CLAUDE.md 10.12 forbids a cron as the resolution to
anything, and a sliding window needs none: it is correct at every instant by
construction, it cannot drift from the rows it is computed from, and it has no
month-end cliff where a calendar reset would put one.

**The spin is the whole wheel or it is not offered.** The per-tier checks are
gone. The budget is asked one question, before the spin is offered at all: can
what is left still cover the biggest prize on this table? If it can, every tier
is live and the newest member spins the same wheel the first one did. If it
cannot, there is no welcome spin here until the window turns.

Up to one top prize of budget can therefore sit unspent at the end of a window.
That is the price of never handing anybody a hollowed-out wheel, and it is the
right price.

Cover and owner-diamond locks are untouched and still apply to a welcome spin
exactly as they do to a paid one. Those say "the host cannot pay this", which is
a fact about the host's money rather than an artefact of the budget.

## What is renamed, and what is buried

    free_spin_enabled               -> welcome_spin_enabled
    free_spin_daily_budget_diamonds -> dropped
    fn_wheel_free_state             -> fn_wheel_welcome_state
    fn_wheel_free_spin              -> fn_wheel_welcome_spin
    fn_wheel_set_free_spin          -> fn_wheel_set_welcome_spin
    the spin result's `free` key    -> `welcome`

The old names are dropped, not left answering beside the new ones.
`fn_wheel_free_history` and `fn_wheel_free_spin_result` go entirely, and
`wheel_free_spins` and `wheel_free_segments` are registered as deprecated in
both the database and `check-deprecated-tables`, so a future read fails the
build. The tables keep their rows: a deprecated table is retired by becoming
unreadable from source, not by being dropped out from under whatever might still
want to look at the history.

The console gains a Budget Window field, a Top Prize reading (what the window
has to be able to cover) and an all-time given-away figure, so the operator can
see the three different numbers rather than one that means whichever of them the
reader assumes.

## A law that had gone stale, again

`the-welcome-spin-keeps-its-own-books.law.test.ts` pinned its migration **by
name**. When this migration rewrote `fn_wheel_spin_core`, the law went on
reading the old file and went on passing green while production contradicted
three of its claims. That is the second time a law here has gone stale that way,
and a law nobody can trust is worse than no law.

The law now resolves each migration by what it **defines**: the last one to
declare a function is the one in force, which is exactly how Postgres sees it. A
rewrite of any of those functions has to bring the law with it now.

## Verified

A rolled-back probe on both host shapes. It asserts the dead column is gone and
the renamed one is not, that both hosts took the 30 day default, that all five
retired functions are gone and all four welcome ones exist, that the two tables
are in the registry, that anon cannot take a welcome spin and the window helper
is unreachable from a browser at all, and then plays real spins: a funded window
offers the whole wheel with **zero** tiers locked for the budget, the page
reports the same top prize the table holds, the window never exceeds the budget,
a window that cannot cover the top prize refuses the spin and the page says
`pot_empty` in agreement with the door, a 45 day old welcome spin does not count
inside a 30 day window but does inside a 60 day one and does for period 0, a
second welcome spin for the same member is refused, and the operator can set the
window to 7 but not to minus one.

`wheel_spins` is append-only, and rightly so, so the old spin in that window
test is inserted rather than back-dated.
