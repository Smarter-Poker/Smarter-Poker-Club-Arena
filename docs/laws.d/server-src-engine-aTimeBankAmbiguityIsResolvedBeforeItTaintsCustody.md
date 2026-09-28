# server/src/engine/aTimeBankAmbiguityIsResolvedBeforeItTaintsCustody.law.test.ts

An ambiguous answer from `fn_consume_time_bank` (a timeout, a dropped response, a
non-success payload) is asked again ONCE, with the SAME `p_request_id`, before
`timeBankAccountingUnconfirmed` is set. The retry is safe because
`supabase/migrations/20260928144831_time_bank_consume_is_idempotent_by_request_id.sql`
gives the RPC an idempotency receipt keyed on that id: a replayed request_id returns
the stored result instead of deducting the player's time-bank uses a second time.
Only when the resolving retry is ALSO ambiguous does the flag get set, and it is
never cleared afterward - that remaining fail-closed behavior is deliberate and
correct: `hasUnretiredStoppedTimeBankCustody()` and the maintenance certificate are
right to refuse a genuinely unresolved custody forever
(tests/a-stopped-bank-that-can-never-be-released-does-not-hold-the-restart-shut.law.test.ts
is not loosened by this). What changes is that an ORDINARY transient failure - the
production case, one `supabase_timeout` - now resolves instead of permanently
quarantining the table's tournament manager and every sibling table behind it. Every
call, resolved or not, carries a request_id, so a manager's later stop-retry (which
re-runs the same accounting path) can never double-deduct either.
