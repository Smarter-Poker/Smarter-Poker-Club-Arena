# The In-Flight Verdict Is Not The Break Remaining (2026-09-26)

## What Broke

Engine release 36211686180 (16dfb5df, PR #5266) was the first ever admitted
through the database in-flight-hands branch of `maintenance_certificate()`.
Every caller captures that function as
`BREAK_REMAINING_MS="$(maintenance_certificate ...)"` and does arithmetic on it.
On that branch the helper `engine-release-inflight-hands.py` printed its
"no hand in the air" line on stdout, and the confirmation echo did too, so the
captured value was three lines. The transaction died at
`BREAK_END_EPOCH=$(( ... ))` with `syntax error: operand expected`, then
`TOKEN: unbound variable`, and recovered 778075b4. While 778075b4 serves, its
unbounded `stopped_bank_custody_unconfirmed` count keeps `readyForRestart`
false, so this branch is the only way any engine release can cut over.

## The Fix

The helper's output and the confirmation line go to stderr. Stdout carries only
the remaining-milliseconds verdict, exactly as on the certified path. The gate,
its allow-list, the database proof and every refusal are unchanged.

## Regression Protection

`tests/a-stopped-bank-that-can-never-be-released-does-not-hold-the-restart-shut.law.test.ts`:
the stand-in helper now speaks on stdout like the real one, and the admitted
cases assert stdout is exactly the verdict. Two cases fail against the previous
script and pass against this one.
