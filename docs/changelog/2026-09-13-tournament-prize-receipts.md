# Tournament close receipts require explicit prize amounts

Entry-close and add-on-close responses could turn a null or blank prize pool
into zero, or accept negative and fractional-cent amounts. The manager could
then mark its pool finalized and start repricing or run the add-on tail. Both
paths now share the guarantee receipt's strict whole-cent decoder; an invalid
response retains the current retry. Entry close also checks that its final
ladder is usable before accepting the financial contract.

The unused TypeScript field-ladder generator and its obsolete tests have been
removed. Actual field ladders come from the database entry-close receipt. The
new private PostgreSQL 17 probe executes the captured installed generator and
checks every paid depth through 2,000: positive, ordered shares summing to 100%,
consecutive ranks, 10/15/20% depth boundaries and deterministic replay. It uses
the existing captured definition and verifies its body hash. It does not write
production data, change stored contracts, or certify monetary allocation.

Validation: the pre-fix methods failed 15 entry-close and 9 add-on receipt cases.
The focused suite passes 123 tests across six files; the final rebased tournament
suite passes 1,890 tests across 153 files after updating an obsolete source guard.
Server typechecking passes. The installed percentage
generator passes all 22 native groups. Run the native probe from the repository
root with `python3 scripts/dev/probe-tournament-payout-structure-pg17.py`; it
creates and removes its own local PostgreSQL cluster and accepts no database URL.
