# A stopped bank that can never be released does not hold the restart shut

2026-09-25

## What was wrong

Serving engine `778075b4` was wedged. Twenty tournament managers were
quarantined after lease loss, and their STOPPED (terminal) tournament engines
answered `hasUnretiredStoppedTimeBankCustody() === true` for ever. The root
cause of that answer is fixed engine-side in #5254 (`bc8727bc`), which
`778075b4` was not running.

`MaintenanceBreak.unparkedTables()` counted that reason with no bound at all:

    if (engine.hasUnretiredStoppedTimeBankCustody?.()) {
      out.push(tableId);
      count('stopped_bank_custody_unconfirmed');
      continue;
    }

so `/health.maintenance` showed, at every break, measured at 22:20 UTC:

    readyForRestart false
    unparkedTables 154
    unparkedReasons { f06_preparation_stuck: 13, stopped_bank_custody_unconfirmed: 154 }

The release transaction's `maintenance_certificate()` admits a cutover past a
shut certificate only when EVERY unparked reason is on its allow-list
(`PREPARATION_ONLY`, the two F06 preparation reasons) and the database helper
confirms no hand is in the air. The raw stopped-bank reason was not on that
list, so **the release carrying the fix could never be admitted**: every
`auto-deploy-hetzner` run since 15:59 UTC waited for a certificate that cannot
open.

The same file's own comment above the retained-preparation loop already
explains why an unbounded fail-closed gate on a shared resource is the worse
bug: _"a stuck table never recovers ... including the restart that carried the
fix"_. #4909 bounded `f06_preparation_unresolved` into `f06_preparation_stuck`
for exactly this reason. The stopped-bank branch, three lines above it, was
left unbounded.

## Why bounding it is safe

`stopped_bank_custody_unconfirmed` is by construction raised only by a
TERMINAL tournament engine: the first clause of
`ServerTableEngineBase.hasUnretiredStoppedTimeBankCustody` is
`if (!this.terminal || ...) return false`. A terminal engine deals no hands.
What a restart discards is the in-memory time-bank mirror of seats that have
already stopped; the chips live in the database. That is the same class the
legacy checkpoint guard already classifies as DISPOSED: _"the live value is
already gone and no refusal can bring it back"_. Holding the process past the
bound does not make the custody more confirmed; it only guarantees that the
replacement which WOULD retire it can never run.

The database in-flight proof is unchanged and still required. `cards_in_air`,
`stopped_bank_custody_unwritten`, `stopped_bank_custody_unreadable`,
`bank_park_write_incomplete` and every unrecognised reason still refuse.

## What changed

**1. `MaintenanceBreak.unparkedTables()` bounds the stopped-bank class exactly
like the preparation class.** A per-table clock starts when
`stopped_bank_custody_unconfirmed` is first observed, using the same
`F06_UNRESOLVED_GATE_MS` (600 s) and the same clearing rule (the entry is
dropped the moment the reason disappears, so a fresh custody gets the full
gate). Inside the bound the table is pushed and counted under the raw reason,
unchanged. Past it the table is NOT pushed; it is counted under
`stopped_bank_custody_stuck` and in the same `stuck` counter the F06 class
uses, so it is still named on `/health`, published on `/metrics` (zero-seeded)
and alertable, and no longer holds the certificate shut. Both classes go
through one `holdsGateWithinBound` helper, because two copies of a bound
drift, which is what left this one unbounded.

**2. `engine-release-transaction.sh` admits the bounded class.**
`PREPARATION_ONLY` is renamed `BOUNDED_ONLY` and gains
`stopped_bank_custody_stuck`. Still an allow-list; still under the same
database proof; nothing else relaxed.

**3. A self-retiring exception for the predecessor that cannot present the
bounded class.** The serving `778075b4` has no bound, so it can never publish
`stopped_bank_custody_stuck`, however long the custody has been held. The
certificate therefore admits the RAW `stopped_bank_custody_unconfirmed` reason,
under the same database proof, ONLY when `/health`'s `releaseSha` is on a
literal allow-list of exact full SHAs (like the checkpoint predecessor profiles
in `legacy-engine-checkpoint.mjs`), today just
`778075b419d078c58565c284c0ca7c5225bb773a`, and says so on stderr:

    restart certificate is held shut by stopped-bank custody the predecessor
    778075b4 can never release; the bound that retires it is not in that
    release; consulting the database for hands actually in the air

Any other serving release keeps refusing the raw reason. The moment a bounded
engine is serving, the exception is dead code by construction.

The timing budgets are untouched (#5250 owns them).

## Law

`tests/a-stopped-bank-that-can-never-be-released-does-not-hold-the-restart-shut.law.test.ts`
(38 cases, driving the real `maintenance_certificate` with a stubbed `/health`
and a stubbed in-flight helper) and
`docs/laws.d/a-stopped-bank-that-can-never-be-released-does-not-hold-the-restart-shut.md`.
The engine-side bound is pinned in
`server/src/maintenance/theGateSaysWhyItIsShut.law.test.ts` (six new cases:
inside the bound holds, past the bound counts `_stuck` and does not hold, the
stuck counter is shared, clearing resets the clock, the two classes keep
separate clocks, one helper and one constant). The allow-list pins in
`tests/a-preparation-that-can-never-resolve-is-not-a-hand.law.test.ts` and
`server/src/maintenance/theCertificateOpensBeforeTheFleetIsSwept.law.test.ts`
now name `BOUNDED_ONLY` and keep every refusing bank class out of it.
