# A quiet answer does not mix with a number (2026-09-26)

## What happened

From 2026-09-25 15:59 UTC the engine had gone unable to certify a single
restart for over 12 hours (the `engine-restart-gate-cannot-be-replaced`
incident tracked on Production Alerts Fleet board issue #5070). Two root-cause
fixes landed to address it - #5255 (the certificate timing budget) and #5266
(bounding `stopped_bank_custody_unconfirmed`, merged 2026-09-26 02:25:46 UTC)

- and neither one's own verification run could get past a `stopped-bank
custody... consulting the database for hands actually in the air` admission
  without dying.

Every `Engine Release` run that reached that new code path since #5266 merged
failed the same way. Job log for run `36212511823` (commit `dd555bf57a`,
2026-09-26 02:55:09 UTC), after the build succeeded and the database
correctly proved no hand was in the air:

```
[engine-release-transaction] the database confirms no hand is in the air; admitting the cutover past the unresolved preparation named above
295850: syntax error: operand expected (error token is "[engine-release-inflight-hands] no hand in the air: zero incomplete hand snapshots written in the last 120s
295850")
line 1455: TOKEN: unbound variable
...
##[error]could not reattach to the durable Hetzner release transaction (1)
```

## Root cause

`maintenance_certificate()` in `server/scripts/engine-release-transaction.sh`
is always invoked as `BREAK_REMAINING_MS="$(maintenance_certificate ...)"` -
its entire stdout IS the caller's captured numeric return value, which the
caller then feeds straight into arithmetic:
`BREAK_END_EPOCH=$(( $(date +%s) + (BREAK_REMAINING_MS / 1000) ))`.

Inside the function's `inflight_rc==0` (success) branch, two lines wrote to
stdout instead of stderr:

1. `server/scripts/engine-release-inflight-hands.py`'s own QUIET-path
   `print(...)` (no `file=sys.stderr`, unlike every other outcome in that
   file).
2. `engine-release-transaction.sh`'s own
   `echo "[engine-release-transaction] the database confirms..."` right after
   it (no `>&2`, unlike every sibling branch in the same `case`).

So the captured "verdict" was a three-line blob (the QUIET message, the
"admitting the cutover" message, then the actual number) instead of a bare
integer. Re-parsing that blob as a bash arithmetic expression at the call
site produced exactly the "syntax error: operand expected" seen in
production, which is a fatal parse error under `set -euo pipefail` - the
script died before `TOKEN` was ever assigned, and the systemd unit's own
recovery path then retired the terminal release as if nothing had mutated
(true here, since the crash was before `persist_break_deadline`).

Reproduced byte-for-byte locally against the unmodified file: same "operand
expected" message, same shape, using the harness in
`tests/a-stopped-bank-that-can-never-be-released-does-not-hold-the-restart-shut.law.test.ts`.

Both this defect and the fix it sits beside (#5266) touch the same success
branch, which is why it was invisible until the first release actually
reached this code path in production.

## Fix

- `server/scripts/engine-release-inflight-hands.py`: the QUIET print now
  carries `file=sys.stderr`, matching every other outcome in the file.
- `server/scripts/engine-release-transaction.sh`: the "database confirms"
  echo now redirects to `>&2`. The direct invocation of `$INFLIGHT_HANDS`
  itself is also now redirected (`1>&2`) as a standing invariant - the
  helper's own stdout can never again leak into the caller's captured
  return value, regardless of what a future edit to the helper prints.

## Hardening

`tests/a-stopped-bank-that-can-never-be-released-does-not-hold-the-restart-shut.law.test.ts`'s
`inflightHelper` stub now reproduces the real script's exact QUIET-path
stdout line on success (previously it stubbed a silent `exit 0`, which could
never have caught this). Two existing assertions moved from
`toContain('the database confirms...')` on stdout to an exact
`expect(result.stdout.trim()).toBe('296000')` - a substring check would still
pass on the broken code, since the polluted blob still _contains_ the
expected words; only an exact match on the whole captured value proves
nothing else is in it. Confirmed failing on pre-fix code and passing after.

No new detector was added: the existing law test file already exercises
exactly this code path end-to-end, and the harness itself was the gap, not
missing coverage.

## Scope

Both changed files are cross-cutting engine release infrastructure, not
Production Alerts Fleet's own code, but the incident was already this fleet's
tracked item (board issue #5070) and the fix is bounded (two missing stream
redirects) and fully tested, so it is fixed in place per CLAUDE.md 10.9.
