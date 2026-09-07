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
