# tests/an-absent-guard-is-not-an-empty-one.law.test.ts

The estate audit must keep present, empty, absent and unreadable as four
separate answers about a shared guard, and must never rank a non-variant as the
copy the estate should converge on. Measured 2026-09-23: `gh api
.../contents/<path> --jq .content` prints the 404 error body on stdout and
exits 1, so a deleted path was counted as present, `base64 -d` refused the
error text, and the digest became `e3b0c442...`, the sha256 of nothing. The
audit reported "is a ZERO-BYTE FILE" about two Diamond-Arena workflows that its
own PR #64 had deliberately deleted, and the absent sentinel then carried the
deletion's date into the "most recently committed" ranking and won it for
`agent-open-pr.yml` - telling every reader that the newest authoritative copy
of the estate's pull-request opener was nothing, and naming the six repos that
have a working one as the ones behind. The law pins each outcome to its own
sentence, keeps empty and deleted files out of the ranking, requires a
deliberate difference to be recorded with its reason, and alarms if a recorded
retirement is reversed without the record changing.
