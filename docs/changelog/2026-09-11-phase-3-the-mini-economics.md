# Phase 3: the mini's economics, measured instead of assumed

2026-09-11. Branch `feat/one-qualifying-rule`. BBJ programme phase 3 of 5.

The mini's **price** is global - a flat amount per stakes tier from
`bbj_mini_tiers`. Its **funding** is per pool: 25% of that pool's own BBJ rake
lands in `backup_balance`. Nothing on the platform had ever compared the two.

A pool paying minis faster than its backup fills drifts down to
`mini_reserve_floor` and the mini stops there, permanently, until somebody
funds the reserve. The only symptom is `payable` turning false on every tier -
which reads to a player exactly like a reserve that is briefly low, and reads
to an operator like nothing at all.

---

## The alarm I raised twice was wrong, and this phase is what proved it

Twice in this programme I reported that **Deep Stack Society was running a
deficit of about -280/day and its mini would die in roughly a month.** That
number was an artifact of my own measurement: I divided the pool's backup
**income over seven days** by 7, and its **mini spend over the mini's whole
3.54-day life** by 3.54. Two windows are not a rate. They are two numbers
divided by each other.

Measured properly - one window, applied to both sides:

| pool                                  | backup    | in/day   | out/day  | net/day       | days to floor |
| ------------------------------------- | --------- | -------- | -------- | ------------- | ------------- |
| union pool (JAQK, SHARK CLUB, Midway) | 43,640.60 | 2,649.28 | 1,172.75 | **+1,476.52** | not draining  |
| Deep Stack Society                    | 13,755.35 | 2,163.05 | 1,907.49 | **+255.57**   | not draining  |

**Both live pools are solvent.** There is no deficit and no 31-day clock.

Two corrections come with that, and both matter more than the original alarm:

- **The first cut of this very function had the bug too.** It measured both
  sides over seven days, which is the right principle and the wrong number
  while the mini is younger than seven days: a 7-day divisor averages in three
  days during which the mini could not spend anything, and reported Deep Stack
  Society at +767.42/day. Corrected by migration `20260911162733` to an
  **adaptive window** - seven days, or the mini's age, whichever is shorter -
  published as `window_days` so nobody has to guess what a rate is an average
  of. The law pins it.
- **An earlier reading of "three of five pools hold 0.00 backup" was also
  wrong.** Those three clubs are union members: `fn_bbj_pool_for_club` resolves
  them to the union's pool, which holds 43,640.60. Their own `bbj_pools` rows
  are vestigial. Reading the table directly instead of through the resolver is
  what produced the scare.

I state all of it plainly because the whole point of this phase is that nobody
could measure the mini's economics before - and "nobody" included me.

---

## What was built

### 1. The runway, on `fn_bbj_mini_for_club`

`in_per_day`, `out_per_day`, `net_per_day`, `days_to_floor`, `floor_minimum`
and `window_days`. Both rates come from ONE window so they are comparable, and

**`days_to_floor` is NULL when a pool is not draining - never zero.** A surface
has to be able to tell _"never, at this rate"_ from _"today"_, and a zero there
would read as the latter. `lib/bbjMiniFeed` keeps the NULL rather than passing
it through `num()`, which would have flattened it to 0.

The club settings panel now shows all three rates and says, in words, either
that the reserve is not draining or how many days are left, and names the
window the rates are an average of.

> **The window was published and then not shown.** `window_days` exists so a
> rate can be interpreted, and the first cut of the panel printed "X A Day"
> without it — which is how a rate goes back to being a number with no stated
> basis. The audit caught it; the panel states it.

### 2. The reserve floor became a control

`mini_reserve_floor` has always been a per-pool column, and every pool carried
the same 5,000 because nothing could set it. `fn_bbj_set_club_mini_floor` gives
it to the club that owns its pool, through the same authorization as the mini
switch and in the same order - **name the actor, authorize, then explain** - so
a stranger cannot learn a club's union shape from a refusal.

**The lower bound is derived, not chosen:** the largest ENABLED mini tier
(1,500 today). A reserve may be small, but not so small that it cannot cover
one more payout - below that the felt would show an amount the payout RPC must
refuse, which is the one thing this programme's governing rule forbids.

The migration asserts that every pool carries a floor before the control ships,
and aborts if one does not.

> **Corrected in the audit that followed.** The first version asserted every
> floor is exactly 5,000 — right about the intent, wrong as a permanent check,
> because the same file ships the control whose job is to change that value.
> Any replay after one club had set a floor would have aborted on a number that
> club was entitled to set. What the migration must not do is change a floor
> _itself_, and it contains no such write; that is what is asserted now.

### 3. The mini has its own near misses

`detectBBJNearMiss` only ever judged the MAIN rule, and only for a loser who
had already cleared the MAIN hand bar. So the mini - which exists precisely to
catch the beats the main turns away - had **no near-miss record at all**.

Measured that day: **50 near misses in seven days, zero of them about the
mini**, and 13 of the 50 were `both_cards_must_play`, a rule the mini DROPS.
The mini's rate was unmeasurable and its tuning was guesswork.

`detectMiniBBJNearMiss` mirrors `detectMiniBBJHit` gate for gate and reports the
first unmet condition, prefixed `mini_` - the same shape settlement already
uses for `mini_refused:<reason>` - so one table carries both jackpots and a
query can always tell them apart. A hand nobody nearly won is **not** recorded:
burying the real ones would defeat the point. Like the main's, the branch is
fire-and-forget and cannot break settlement.

### 4. The mini has its own players-dealt floor

It read `BBJ_RULES.minPlayersDealt` directly, so the two jackpots could never be
set apart - and they are different products: the mini fires about four times a
day at a flat amount out of a reserve, the main about once a day at a share of a
pool. `BBJ_RULES.miniMinPlayersDealt` ships **equal** to the main's, so nothing
changes until somebody sets it.

It lives on `BBJ_RULES` and deliberately **not** in `RAKE_SPEC.rules`. Putting
it there broke `RakeSpecParity.law.test.ts` on the first attempt, correctly:
that spec is a contract with SQL - `rakeSpecChecksum()` is pinned against the
database's own serialiser - and the database applies no jackpot detection rule.
The law caught a real mistake and the knob moved to where `excludeDoubleBoard`
and `requireBothHoleCards` already live.

---

## Still Dan's

The floor's **default value**, the **tier amounts**, and what
`miniMinPlayersDealt` **should be** all decide who is owed a jackpot in future
hands (CLAUDE.md 10.9). This phase built every mechanism and retuned nothing:
5,000 floors, the same six tier amounts, and a mini floor equal to the main's.

## Pinned

`tests/the-mini-reserve-has-a-runway.law.test.ts` - one window applied to both
rates and never longer than the mini has existed; NULL kept as NULL through the
feed to the surface; the floor's derived lower bound and its authorize-before-
explain order; every refusal reason having words for the operator; the mini's
own players floor being absent from the rake spec; and the near-miss detector
mirroring the hit's bar.
