# The restatement policy

**Roadmap 9.3. Written 2026-09-08 because it was needed on 2026-09-06 and did
not exist, and the agent who needed it had to invent one under pressure.**

CLAUDE.md 10.9 covers two cases and names them clearly: **what a past event owes
is yours to settle**, and **what a future event will owe is Dan's**. A
restatement is neither. It is the correction of an amount that has already been
computed, already been paid, and already been spent — VIP points awarded, agent
commissions banked, rakeback withdrawn.

The 2026-09-06 clearance found **16,426.46 chips of rake attributed to clubs by
duplicate rows**, spread over five months and already paid downstream. The
decision made then was right, but it was a judgement, made once, by one agent.
This is that judgement written as a rule so the next one reads it instead of
repeating it.

---

## 1. What counts as a restatement

A restatement is a change to **an amount that has already been settled**: paid
into a wallet, converted into VIP points, banked as commission, or reported to
an operator as final.

It is **not** a restatement to:

- pay something that was owed and never paid (that is a settlement — 10.9, yours);
- correct an amount that has not yet been paid (that is a fix — yours);
- change what future events will pay (that is Dan's, and always was).

If you are not sure which you are holding, the test is: **has a player or an
operator already been able to spend it?** If yes, it is a restatement.

## 2. The three outcomes, and when each applies

There are exactly three, and they are not interchangeable.

### CLAWBACK — taking it back. **Forbidden when our defect caused it.**

10.9 rule 3 already says it: _"Nothing is taken back from a player for our
mistake."_ Overpay our defect caused is absorbed by the house, reported, and
left alone. This does not become permissible because the amount is large, or
because the recipient is a horse, or because the books would balance more
neatly. It stops being a clawback only when the money was taken by fraud or by
a deliberate exploit, and that is Dan's call and nobody else's.

### WRITE-OFF — the amount stands, the record says why. **The default.**

Correct the _cause_, leave the _settled amount_, and write the difference down
where the next reader will find it — a `financial_alerts` row resolved with the
reasoning, a constraint comment, an entry in the changelog. The books then
disagree with the identity by a known, named, bounded number rather than an
unknown one, and that is a strictly better position than a tidy total nobody can
explain.

Worked example, from this same PR: 8,057 rows across three tables carry sub-cent
values, **net +0.0414 chips** (two of the three nearly cancel, and the third
cancels exactly). Rounding them would rewrite settled `paid` records. They are
written off: the constraint that stops any new one is added `NOT VALID`, and its
`COMMENT` in the catalogue says exactly which rows, which window and how much.

### RE-RUN — recompute and pay the difference forward. **Only when all four hold.**

1. The correct figure can be **read**, not estimated — 10.9 rule 1.
2. Every affected party comes out **the same or better**. A re-run that takes
   from anyone is a clawback wearing a different hat.
3. It goes through the platform's own **idempotent** path, so a replay pays
   nothing twice — 10.9 rule 2.
4. It is **proved in a transaction that was rolled back** first, and the
   migration asserts the numbers so it aborts if the board moved — 10.9 rule 4.

## 3. Who decides, by size

The threshold is on the **total restated**, not per player.

| total                                    | who                                        | what is required                                                                                          |
| ---------------------------------------- | ------------------------------------------ | --------------------------------------------------------------------------------------------------------- |
| **under 1,000 chips**                    | the agent, alone                           | the migration, the changelog, and a resolved `financial_alerts` row naming the outcome                    |
| **1,000 to 25,000**                      | the agent, and Dan is told before it ships | the above, plus one paragraph to Dan naming every affected party and the outcome chosen — sent, not filed |
| **over 25,000**                          | Dan                                        | options with their costs and a recommendation, never a question                                           |
| **any size, if it is a CLAWBACK**        | Dan                                        | and only for fraud or a deliberate exploit                                                                |
| **any size, if it changes future terms** | Dan                                        | 10.9 already says so                                                                                      |

The 2026-09-06 case (16,426.46) sits in the middle band: the agent decides,
and Dan hears about it in the same breath. The 0.0414 in this PR sits in the
first: decided here, written down here.

## 4. What the affected party is told

- **A player or agent whose balance does not change** is told nothing. A
  notification about a correction they cannot see and did not lose costs their
  attention and buys nothing.
- **A player or agent who is paid more** is told, through the platform's
  existing notification, in the same words a normal credit uses. They should
  not have to know a restatement happened to understand why they have more
  chips.
- **Nobody is ever told their balance went down because of a restatement**,
  because under section 2 that does not happen.
- **An operator** sees it on the club's own financial surface, because their
  reported totals moved.

## 5. The record is part of the fix

Identical to 10.9's rule, restated here so this document stands alone. A
restatement is finished when **all four** exist:

1. the migration, with the reasoning in its header rather than only its SQL;
2. the changelog under `docs/changelog/`;
3. the `financial_alerts` row resolved with a `resolution` naming which of the
   three outcomes was chosen and why;
4. the code fix that stops it recurring — without which it is not a
   restatement, it is a repeated one.

## 6. What is never a restatement

Deleting the record. Editing history in place so the number reads correctly and
the change leaves no trace. 10.9 forbids it — _"Correct it forward, with a row
that says what changed. Never edit history quiet"_ — and it is worth repeating
here because a restatement is precisely the moment the temptation arrives.
