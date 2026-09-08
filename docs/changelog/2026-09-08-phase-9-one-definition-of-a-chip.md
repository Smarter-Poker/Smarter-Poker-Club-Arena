# Phase 9: one definition of a chip, and the three contracts

2026-09-08. Phase 9 of 9 of the chip-accounting programme, opened on Dan's
"PROCEED TO PHASE 9 OF 9". Branch `feat/one-definition-of-a-chip`.

Phase 9's roadmap listed eight items. Four were already closed by earlier
phases — 9.2 by phase 6, 9.5 and 9.6 by phase 7, 9.7 by phase 8. This is the
remaining four: **9.1** built and enforced, and **9.3, 9.4, 9.8** written as
contracts.

## 9.1 — A chip is two decimal places

### What was measured

236 money columns on 2026-09-08: **137 declared `numeric(_,2)`, 11 declared
`numeric(_,4)`, and 86 were unconstrained `numeric`**, able to hold any scale.

`chip_ledger.amount` is `numeric(15,2)`. **A balance that can hold a third
decimal place, against a journal that cannot record one, is a fraction that
lives in the balance and can never appear in a leg** — and no conservation
check on this platform can see it, because both sides round the same way.

### It had already opened, three times, and closed itself

The roadmap said on 09-06 there was "not one sub-cent residue in live data". It
had not checked these:

| column                                   | rows             | window        | drift                              |
| ---------------------------------------- | ---------------- | ------------- | ---------------------------------- |
| `union_rake_paid_daily_user.rake_amount` | 6,881 of 8,244   | 08-10 → 09-01 | **+0.2799** on 1,855,063.77        |
| `rakeback_period_payouts.payout_amount`  | 933 of 2,704     | 07-22 → 08-17 | **−0.2385** on 46,314.22           |
| `wallet_transactions.balance_after`      | 243 of 2,899,837 | 04-17 → 07-21 | **0.000000** (they cancel exactly) |

8,057 rows, **net drift +0.0414 chips**, and all three stopped on their own
when the writers above them were rebuilt. None has produced a row in a week.

**That is precisely why this is worth doing today.** Declaring the unit while
the drift is four hundredths of a chip costs nothing. Declaring it after an
epoch reset means declaring it against balances that have already moved — and
9.8 writes an opening balance to every account on the platform.

### What was built

A `CHECK (col IS NULL OR col = round(col, 2))` on **33 chip-carrying columns
across 28 tables** whose declared type did not already pin two decimal places:
the journal's four running-balance columns, every live balance, every money
movement record, the three currencies phase 8 guarded, rake attribution, and
the pools and meters.

Four decisions worth the words:

**Not `ALTER COLUMN TYPE`.** That rewrites the whole table under ACCESS
EXCLUSIVE. On `chip_ledger` (2.36M rows, 1,995 MB) or `agent_commissions`
(4.00M) it is minutes of frozen felt for a constraint a CHECK enforces just as
completely.

**Every constraint `NOT VALID` first** — catalogue-only, 18 ms on the largest
table — so it binds every new write the instant it commits. The `VALIDATE` that
proves history follows in the same transaction and takes SHARE UPDATE
EXCLUSIVE, not ACCESS EXCLUSIVE. Measured: agent_commissions 6.28 s,
chip_ledger 4.43 s, rake_distribution_legs 2.38 s.

**The three columns with residue are added NOT VALID and left that way.** They
refuse every new sub-cent value but do not assert a history that is already
imperfect. Rounding 8,057 settled rows would be rewriting settled records to
tidy a number, which CLAUDE.md 10.9 forbids in as many words, and no player is
owed a fraction of a chip that could be paid. Each carries a `COMMENT ON
CONSTRAINT` in the catalogue naming the rows, the window and the drift — where
`\d+` will show it, not only a changelog.

**The scope is stated, not discovered.** The column list is explicit and the
migration aborts if a named table or column is not there. A migration that
picks its own targets from the catalogue is CLAUDE.md 10.86's shape — a guard
answering confidently about a scope nobody stated.

### Two things the probes caught that reading would not have

**A three-day sample of `wallet_transactions.balance_after` read clean.** The
full table has 243 residue rows from April to July. The `VALIDATE` found them;
the sample never would have. Time-windowed sampling of a five-month table is
not a measurement, and this is why every money change here is probed before it
is applied (11.5).

**It deadlocked twice, and that is the finding.** The first probe took ACCESS
EXCLUSIVE one table at a time and died on `club_members` after eight
constraints (40P01) — the same shape that killed the phase 8 migration at 02:19
and the hand re-drive at 04:03. Taking all 28 locks in one `LOCK TABLE`
statement, as phase 8 taught, **still deadlocked against live writers**. So the
migration is applied **inside the :55 maintenance freeze**, with every table
parked and no writer to race, which is the same window that made the 04:56
migration cost zero hands.

## 9.3, 9.4, 9.8 — the three contracts

Each is a rule that did not exist and was needed. They are documents rather
than code because what was missing was the decision, not the mechanism — and a
decision written down is what stops the next agent inventing a different one
under pressure.

**`docs/CHIP-RESTATEMENT-POLICY.md` (9.3).** 10.9 covers a past event's money
(yours) and a future event's terms (Dan's). A restatement of _already-settled_
earnings is neither, and on 09-06 an agent had to invent a policy for 16,426.46
chips of duplicate rake attribution under pressure. Three outcomes, named:
**clawback** (forbidden when our defect caused it — 10.9 rule 3), **write-off**
(the default: correct the cause, leave the settled amount, write the difference
down where it will be found), **re-run** (only when the figure is read not
estimated, nobody comes out worse, it goes through an idempotent path, and it
was proved in a rolled-back transaction). Plus who decides by size — under
1,000 the agent alone, 1,000–25,000 the agent with Dan told, over 25,000 Dan —
and what the affected party is told, which for a write-off that costs them
nothing is nothing.

The 0.0414 chips this PR writes off are its first worked example.

**`docs/CHIP-JOURNAL-RETENTION-POLICY.md` (9.4).** The journal is **2,356,797
legs, 1,995 MB, taking 353,008 legs a day** — up from the roadmap's 232k
measured six days ago — and it is **not partitioned**. Nobody had written down
how long a leg is kept. Seven years, matching the regulated regimes the
hierarchy audit was drawn against; hot / warm / cold split **on the epoch, not
a date**, because a bare date cuts an epoch in half and makes its opening
balance unreadable; **space is answered by partitioning, never by deleting**,
and until the 8.4 cut lands nothing ages out at all; nothing moves without its
`ca_ledger_day_manifests` sha, and the manifest outlives the legs; and nothing
is removed while an unresolved obligation still points at it.

**`docs/CHIP-EPOCH-RESET-CONTRACT.md` (9.8).** Dan's Monday item. Four steps in
order: the closing position of every account **recorded as a leg in
`chip_ledger` before anything is zeroed** (a snapshot proves what a table said;
a leg proves it against the journal, and without it the epoch cannot be audited
after it closes); the reset inside a :55 freeze **with nobody seated**, which is
not the same as parked; **one migration that can put every balance back**,
written and rolled-back-tested before the reset, because a reset whose only
undo is a database restore is not undoable at 09:00 with players online; and
the opening grants issued **through the Mint** so the new epoch starts from a
known number rather than an assumed one.

## Pinned

`tests/a-chip-is-two-decimal-places-everywhere.law.test.ts`, 11 pins: the unit
migration covers the journal's balance columns, the live balances and the other
currencies; it adds NOT VALID rather than rewriting a table; it locks up front
and does so before the first `ADD CONSTRAINT` (comments stripped, so the header
explaining the deadlock cannot satisfy the pin); it states its scope; it leaves
the residue columns unvalidated with catalogue comments; it is idempotent. And
that all three contracts exist and still say the load-bearing things.

## What phase 9 does not close

**The 8.4 partition cut.** 9.4 is now the shape it should be built to — an
epoch boundary and a manifest check, not a storage target. At 353k legs a day
the journal passes 10 GB before December.

**The reset itself**, which is Dan's, and whose longest-lead item is step 1 —
the closing position — because it is the one thing that cannot be added
afterwards.
