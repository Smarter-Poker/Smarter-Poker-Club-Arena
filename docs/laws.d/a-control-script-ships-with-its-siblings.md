# tests/a-control-script-ships-with-its-siblings.law.test.ts

`install-engine-supervisor.sh` builds each immutable engine-control generation
from a hand-maintained `REQUIRED_FILES` array, and validates the generation
directory by EXACT SET equality against it, so a script left out of that array
can reach the host by no other route. #5003 added
`engine-release-inflight-hands.py` - the helper that asks the database whether
a hand is really in the air - and did not add it to the array. For five
consecutive releases the release gate reached "consulting the database for
hands actually in the air", the shell answered 127 for a missing file,
`if "$INFLIGHT_HANDS" ...; then` read any non-zero as "not quiet", and the run
printed "the database did not prove the felt is quiet" about a database it had
never asked - CLAUDE.md 10.86 rules 1 and 2, one level below the defect #5003
had just fixed one level above, while the engine stayed frozen for 59 hours.
This pins the packaging by SCANNING what the control scripts actually invoke
rather than by keeping a second list beside the first, pins the installer's two
per-language syntax-check loops to the same manifest, pins the helper by name, and requires the gate to
keep the helper's three outcomes distinct - all of them refusing, with a
missing or unrunnable helper saying UNKNOWN and NEVER ASKED in its own words
instead of borrowing the database's verdict.
