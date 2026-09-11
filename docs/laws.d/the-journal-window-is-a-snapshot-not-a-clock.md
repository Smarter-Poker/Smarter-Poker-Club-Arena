# tests/the-journal-window-is-a-snapshot-not-a-clock.law.test.ts

fn_ca_ledger_replay compares balances read under a snapshot against a journal,
so the journal window must be that snapshot, never a created_at clock: every
reading records pg_current_snapshot() from the statement that read it, the
next reading counts a leg iff it was not visible in the previous snapshot
(created_at only bounds the scan), a 32-bit xmin gets its epoch back before it
is judged, a change of basis rebaselines rather than judges, and whatever
migration defines the replay last must still window by snapshot.
