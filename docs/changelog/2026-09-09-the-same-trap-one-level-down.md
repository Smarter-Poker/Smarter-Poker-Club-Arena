# 2026-09-09 — The same trap, one level down

Dan: "NOTHING IS MINE TO DECIDE, THATS ON YOU."

## My previous fix did not land

#3912 taught `proveTournamentLaunchSetup` that a zero stack is a **bust**, not an
uncredited field, and asserted conservation instead. I verified it in the engine,
ran the suite, shipped it, and reported the wedged Spins as handled.

They were not. They moved to the next refusal:

```
Tournament.launch_setup_unproven      ->  Tournament.launch_completion_unproven
                                          (launch_roster_unproven)
```

24 in six minutes, because `fn_complete_tournament_launch_before_lease_generation`
carries the identical rule in SQL — **twice**:

```sql
OR COALESCE(p.chips, 0) <= 0     -- the roster
OR COALESCE(s.stack, 0) <= 0     -- the felt
```

This is CLAUDE.md 10.86 rule 4, word for word: _"a fix that leaves the same trap
one level up has not landed. When you fix something, ask what the next person
will reach for, and check that it works."_ I checked the engine and stopped. The
database was the next thing the code reached for.

## The rule, now identical on both sides

- a **negative or absent** stack is still refused — that is impossible, not busted;
- a **zero** stack is accepted, because a player who lost their chips at a table
  that dealt before the launch was proven is busted;
- the **field** must still hold what it was bought for. An uncredited field is
  short of `active_players x starting_chips`; a played field still adds up to it.
  Bonuses and rebuys only add, so the expected total is a floor. A field where
  nothing was credited sums to zero and is refused under the new
  `launch_stacks_uncredited` reason — the original check, kept.

Both the roster and the felt get it, because both carried the per-row rule.

## Verified on production

The three wedged Spins read exactly as predicted before the fix — every clause
passing except the one:

| tournament | active | required | negative | zero | roster chips | floor | felt    |
| ---------- | ------ | -------- | -------- | ---- | ------------ | ----- | ------- |
| `19cf9300` | 3      | 3        | 0        | 1    | 900          | 900   | 900.00  |
| `6aeb091f` | 3      | 3        | 0        | 1    | 900          | 900   | 900.00  |
| `72b27269` | 3      | 3        | 0        | 1    | 3000         | 3000  | 3000.00 |

After applying: **zero launch refusals in the following sixty seconds**, ten
tournaments launched in five minutes, and the wedged population began draining
(47 → 41). The migration asserts each of the other five launch proofs is still
present in the rewritten body and aborts if any went missing.

Pinned by `server/src/tournament/TheLaunchCompletionAgreesWithTheProof.test.ts`,
which asserts the engine and the database say the same thing — so neither half
can be relaxed on its own again.

## What this says about the earlier report

I told Dan the wedged Spins were handled. They were not, and the evidence was
one `docker logs` away. The lesson is not "check twice"; it is that a rule
expressed in two places is one rule with two copies, and finding a copy is a
reason to go looking for the others rather than to stop.
