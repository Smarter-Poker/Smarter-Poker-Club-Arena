# 2026-09-07 - BBJ build plan, Phase 4 of 6: prove it live

Plan of record: `docs/BBJ-BUILD-PLAN.md`. Follows phase 3
(`2026-09-06-bbj-phase-3-everyone-hears-it.md`).

The Bad Beat Jackpot fires about once a fortnight. The last real one was
**2026-08-19**. So everything downstream of detection - the celebration, the
fan-out to sibling tables, the lobby card, the notifications, the ticker,
Previous Winners, real chips landing in real stacks - has never been watched end
to end on live infrastructure. Every phase so far has been proven by probe and
by test, which is why phase 4 exists.

## 4.1 The drill arms a table, never a deck

**The plan called for a staff-only rigged deck. It should not exist, and it
does not.** The case, put to Dan and agreed:

> `detectBBJHit` is a pure function with **32 tests** across
> `RakeConfig.bbj.test.ts`, `bbjnearmiss` and `bbjunenforced`, covering every
> qualifying rule, every variant, both-cards-play, the double-board refusal,
> multi-winner chops, and every rejection reason. Dealing one lucky hand proves
> a single case those already prove. What it costs is code inside a real-money
> poker engine that can choose a player's hole cards, and there is no
> ring-fence worth that.

So the drill arms a **table**, and what it injects is the **verdict**. On the
next hand at an armed table the engine treats the real showdown - real players,
real board, real pot - as a qualifying hit. Everything after that runs for
real, because it is real: the payout RPC, the recipients, the notifications,
the hub events, the ledger rows. **A drill produces a genuine jackpot at a
drill club**, so nothing in the history is fabricated and no surface has to
learn to lie about it.

The engine's deck is untouched: still crypto-shuffled through `secureShuffle`,
still unseeded, still with no injection parameter on `HandController`.

### Five things that make it safe, each proven rather than asserted

|     |                                                                                                                                                                                                                                                                                                                      | proven by                                                                                             |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| 1   | **The engine never decides.** The arm lives in the database; there is no env var, config flag or build that turns this on - so no deploy can turn it on, and none can leave it on.                                                                                                                                   | law: `reads no environment and no local flag`                                                         |
| 2   | **Only a platform admin can arm.** `fn_is_platform_admin()`, the same gate the mint uses.                                                                                                                                                                                                                            | probe: as `service_role`, `fn_bbj_arm_drill` returned `{"ok": false, "reason": "not_platform_admin"}` |
| 3   | **It can never reach the production jackpot.** An arm is refused outright if the table's pool is a UNION pool - that is where the 107,727.33 lives, shared across the union.                                                                                                                                         | probe: the Midway Union club resolves to the union pool, `union_pool = t`                             |
| 4   | **The blast radius is bounded and derived.** Refused if the pool holds more than 1,000.00. At that ceiling the largest possible drill payout is about 850 - the same order as the smallest real jackpot ever paid here (654.14), visible against a median member balance of 10,216, and 0.8% of the production pool. | probe: Deep Stack's 24,265.11 pool, `over_ceiling = t`                                                |
| 5   | **Single shot, claimed atomically.** A partial unique index allows one un-fired arm per table, and the engine consumes it with `UPDATE ... WHERE fired_at IS NULL RETURNING`.                                                                                                                                        | probe: a second live arm was `refused`; `claim1 = claimed:true`, `claim2 = claimed:false`             |

All five were exercised in **one self-aborting transaction on production**
(CLAUDE.md 11.5 - an error is the success case). Zero residue afterwards: no
arms, no alerts.

### And it is loud at both ends

Arming and firing each write a `financial_alerts` row saying in words that this
is a drill and that the chips are real. A new counter,
`poker_bbj_drills_fired_total`, is kept separate from the jackpot counters, so
`detected - drills` is the number of genuine bad beats. Without it, the first
drill would look exactly like the jackpot finally hitting.

### Refusing before claiming

The drill checks it can actually produce a payout - two showdown results, a
winner - **before** it claims the arm. An arm burned on a hand that cannot fire
is an operator arming again and wondering why. And an unreachable database
returns no drill rather than a drill: "I could not tell" is not "yes"
(CLAUDE.md 10.86).

## 4.2 Running the drill

Blocked on one thing only, and it is the right thing to be blocked on: the
built-in browser is signed out, and **an agent never signs in as a person or
sets a credential** (CLAUDE.md 10.84). Dan signs in; the drill then runs
against a live session with four tables open at 375px, checking the
celebration, the sibling pop-up, the ticker, Previous Winners, the wallets and
the notifications in one pass.

The other precondition is a drill club: every existing pool is either the union
pool (refused by rule 3) or above the ceiling (rule 4), which is the guard
working rather than a gap.

## The deep dive before phase 5, and the defect it found in this phase

### An unindexed foreign key, and it blocked the whole repo

`bbj_drill_arms.club_id` shipped with a foreign key into `public.clubs` and no
plain index on it. The club-deletability guard refused `TypeScript Check` on
**every open pull request in the repo** - including a docs-only one of mine and
other agents' work - because that guard reads the LIVE schema rather than the
diff, and the table was already on production.

The guard is right, and its own text says why: an unindexed foreign key into
`clubs` makes `DELETE FROM clubs` a sequential scan, the retirement RPC runs
inside a PostgREST request cancelled after a few seconds, and when it is
cancelled a certification fixture and its 100,000 chips stay in Club Arena.
That has already happened once.

**It is the second time I have done it.** `bbj_threshold_crossings` (phase 3.4)
did the same thing hours earlier and another agent fixed it in
`20260907001323`; another agent unblocked this one in `20260907052937`. Twice
is a pattern and the pattern is mine: I add indexes for the queries I can
picture and forget the one the DATABASE runs on my behalf - the reverse lookup
a DELETE on the parent must do before it can remove a row.

`20260907053124` closes the two the guard cannot see, both also mine:

```
bbj_drill_arms.table_id        -> tables        (phase 4.1)
bbj_unclaimed_shares.payout_id -> bbj_payouts   (phase 2.3)
```

The guard only polices foreign keys into `clubs`, so those two would have sat
there indefinitely. `bbj_drill_arms` already had a UNIQUE index on `table_id`,
but it is PARTIAL (`WHERE fired_at IS NULL`) and a foreign-key check must find
the rows the predicate hides.

And rather than fix two columns, the migration **asserts the general rule** for
all four tables this programme created, so a third one cannot ship without
failing there first. All six BBJ foreign keys are now followable backwards.

### What else was checked

- Server suite 443 files / 6,346 tests green; the drill law mutation-checked.
- Production: the drill functions are `service_role`-only, `bbj_drill_arms` is
  unreachable from a browser, nothing is armed, and no drill has ever fired.
- The three open pull requests were `mergeable=true` and `blocked` - the block
  was this guard, on all of them, from one missing index.
