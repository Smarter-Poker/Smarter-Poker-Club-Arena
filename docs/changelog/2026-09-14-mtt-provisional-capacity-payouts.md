# MTT creation does not price a hypothetical maximum field

The table-config creator generated a prize row for every hypothetical paid
entrant at the maximum capacity. At one million seats and 20% paid, that meant
200,000 rows, many rounded to zero. Its rounded field depth and option-specific
weights also differed from the database's final-field rule. The other manual
creator already used a bounded provisional structure.

Both manual paths now use the same engine-owned provisional constructor.
The selected 10/15/20% depth still travels through the real creation and saved
schedule payloads. The existing database finalizer derives the actual ladder
from funded entries; the form does not duplicate that calculation. SNG and Spin
terms and satellite target/seat settings are preserved. Existing events,
templates, schedules, payout receipts and funds are untouched.

Three new regressions failed on the former mapper. The fixed suite passes
119 client tests across six files, including actual mapping and serialization
at capacities 2, 34, 300 and 1,000,000, saved schedules, mutable draft isolation,
and retained SNG/Spin behavior. Related engine creation/policy checks pass
111 tests across two files. App and server TypeScript and focused lint pass.

These are local source checks. No SQL migration or financial write is part
of this change. The installed final generator was inspected read-only:
definition MD5 320527cd5203efab28b465d2b56ca567. Current owner policy disables
GitHub publication; no transfer or delivery bypass was attempted.
