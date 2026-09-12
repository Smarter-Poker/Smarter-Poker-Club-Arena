# The promo sweep names what drives it

BBJ programme, post-audit phase 4 of 5. 2026-09-12.

## What was wrong

The phase 2 sweep left this open:

> **`fn_sweep_bbj_promo` moves money continuously with no cron row in this repo
> and no entry in `docs/BAND-AIDS-REGISTER.md`.**

It is worse than that, and also better.

**The sweep is alive.** Measured on production: 1,791 sweeps in seven days
moving **24,965.28** chips, one per five-minute boundary, the `:00` run absent
each hour because the platform is frozen for the maintenance break. The most
recent was 0.13 at 00:20:01 UTC, minutes before this was written.

**Nothing in this repo calls it.** No `cron.job` row names it - the four BBJ
cron jobs are rollup-catchup, repair-unbanked, threshold-notify and the
invariant audit. No trigger has it as `tgfoid`. No TypeScript in Club Arena or
the World Hub references it. **The driver is a third repo**: Open Claw
dispatches `/api/cron/bbj-detect` every five minutes, and
`scripts/openclaw-cron-dispatcher.py` line 1022 records that the route now
lives in the workers repo as `src/routes/bbj-detect`.

## I got this wrong first, which is the point

Auditing Club Arena, I found a `SECURITY DEFINER` function that moves real
money, found no caller and no schedule anywhere I could see, saw
`promo_balance = 0.00` on every pool, and concluded the promo slice was banked
inline and the sweep was dead code.

**The zero is the sweep working.** `bbj_record_contribution` accrues
`promo_balance = promo_balance + v_promo` on every one of 46,814 contributions
a day; the sweep empties it every five minutes. Had I acted on the first
conclusion I would have deleted a live money path, and every check in this repo
would have stayed green while the promo slice stopped reaching clubs.

That is the failure this phase fixes, and the fix is that the function says so
itself now.

## The trap that came with it

`fn_sweep_bbj_promo_all`'s comment ended by telling the next agent to schedule
it.

It is not scheduled. Its per-club sibling already is, from another repo. An
agent obeying that sentence adds a **second driver** onto the same staging
slot: `_all` loops every pool `FOR UPDATE` while `fn_sweep_bbj_promo` works the
same rows five minutes apart, and the thing they would be racing over is the
promo slice of every raked hand on the platform.

A comment that recruits the next agent into a money path is not documentation.
It is a defect with good manners.

## What changed (migration `20260912003749`)

Comments only. No behaviour, no signature, no grant, no schedule - the
functions are correct and are untouched. The comments were what was wrong.

| function                  | now says                                                                                               |
| ------------------------- | ------------------------------------------------------------------------------------------------------ |
| `fn_sweep_bbj_promo`      | its driver, its repo, its cadence, the measurement, and that it is neither dead nor to be given a cron |
| `fn_sweep_bbj_promo_all`  | **DO NOT SCHEDULE THIS**, why, and what the second driver would race over                              |
| `fn_bbj_promo_bank_check` | that it is a read, that it is not scheduled, and what a stalled sweep would look like instead          |

The migration also asserts, against the live `cron.job` table, that **no cron
row has acquired either sweep**. If one ever does, the two-driver race is
already live and the migration refuses rather than letting somebody merge past
it.

### The assertion does not quote the sentence it forbids

Writing `position('<the recruiting sentence>' in v_all) > 0` would put that
exact string into the migration, and a migration that asserts the absence of a
phrase while quoting the phrase matches its own check. The phase 2 corrective
pass hit that four times. This one asserts the **presence of the refusal**
instead, and says why in a comment beside it. The first draft also tried to
build the comment with `||`, which `COMMENT ON ... IS` does not accept - it
takes a literal, and adjacent literals separated by a newline concatenate on
their own.

## Why no new scheduled job was added

CLAUDE.md 10.12 forbids shipping a scheduled job as the answer to a defect, and
10.85 puts scheduled application work in Open Claw rather than wherever an
agent finds convenient. The sweep already has a driver and it already works.
The defect was that this repo could not see it. **Naming it is the whole fix.**
Nothing here schedules, repairs, backfills or sweeps.

## It is in the register, and the register says it is not a band-aid

`docs/BAND-AIDS-REGISTER.md` carries the row the phase 2 sweep said was
missing - deliberately as a **NOT-A-BAND-AID** entry. It repairs nothing and
compensates for nothing; it is the transfer itself, batched, and crediting one
`union_wallets` row inline on 46,814 contributions a day is a lock-contention
problem rather than a correctness improvement. 10.12's own carve-out is "a job
whose schedule IS the product", and this is one. An entry that read as debt
would invite somebody to "close" it by deleting a live money path - which is
exactly the mistake this changelog opens by admitting.

## The one genuinely open item

**`fn_bbj_promo_bank_check` is a guard with no reader** (10.86 rule 3). It
reads whether the swept slice arrived, and nothing calls it - not `cron.job`,
not either repo, not the workers repo. So a stalled sweep raises nothing on its
own; the visible symptom would be `bbj_pools.promo_balance` climbing instead of
sitting near zero.

It is **not** given a scheduler here, for the reasons above. The root fix is
one edit in the repo that already owns the schedule: the workers repo's
`bbj-detect` route, which already runs every five minutes and already calls the
sweep, reads the check in the same pass and raises on a non-zero answer. That
adds no new scheduled job anywhere. It is written down in the register with
that root fix named, rather than left for the next audit to rediscover.

## BBJTicker is deleted

The other half of phase 4. `src/components/bbj/BBJTicker.tsx` was 211 lines of
a component that subscribed to `bbj_winners` INSERTs, resolved the pool, and
**rendered on no page**. It was not forgotten - the reachability law
_allowlisted_ it, so it was parked.

Parked is the worst of the three states, and it cost something every time
somebody looked at it. Three separate files reasoned about it as live, and one
of those was a claim about what a player sees: `bbjHitFeed.ts` offered "it
appears in the ticker" as one of three compensations for not announcing a mini
platform-wide, and that compensation had not existed for weeks. The mini test's
own docblock said the same thing. Two agents wrote those sentences in good
faith from a file that was sitting right there.

**Deleted rather than mounted**, and the reasoning is in `DynamicWallet`'s own
comment: mounting it would have put a second live subscription on the same
jackpot number, which is how one screen ends up showing two different figures.
Both halves of what it did already have live homes - `ClubBBJShell` is the
lobby jackpot tile (mounted on `DynamicWallet` and `ClubHomePage`) and
`BBJRecentHits` is the recent-hits list (mounted on `BadBeatJackpotPage` and
inside `BBJInfoModal`). Deleting changes nothing a player sees; mounting would
have changed what every player sees, unasked.

Removed with it: two entries from the reachability allowlist, one row from the
discarded-error ratchet, and the five comments that named it - in
`BBJRecentHits`, `DynamicWallet`, `bbjHitFeed`, `ClubHomePage`,
`BBJThresholdPanel.css` and `theMiniDoesNotTakeOverEveryScreen`. The
`ClubHomePage` `Number()` coercion **stays**: the ownership check that
motivated it lived in the deleted component, but `main_balance` still arrives
from the database as a string and every remaining reader of that state expects
a number.

If the lobby should have a scrolling ticker, it is in git history at this SHA -
and mounting it starts with deciding which single surface owns the live pool
number, not with restoring the file.

## The law

`tests/the-promo-sweep-names-what-drives-it.law.test.ts` (6 tests), registered
in `docs/laws.d/`. It pins that the live sweep names its driver, repo and
cadence; that `_all` refuses to be scheduled; that the migration asserts
against `cron.job`; that the assertion does not quote what it forbids; that
**this repo still has no caller** (a real `rpc(...)` call, not a mention in a
comment) so the comments cannot quietly become wrong; and that the register
entry exists and calls itself what it is.

Its own first draft failed to compile, which earned a line in the file: the
cron expression written literally inside a block comment ends the comment.
