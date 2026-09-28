# A best-effort ledger write held a tournament hostage for 80 minutes (2026-09-28)

## What was wrong

Engine `763e4cec` (serving since 06:55Z, no release since): `/health` showed
`stalledTableCount: 43`, `deadStalledCount: 43`, `tournamentTablesNotRunning: 44`,
`maintenance.unparkedReasons: { stopped_bank_custody_unreadable: 1, bank_park_write_incomplete: 2 }`,
`maintenance.readyForRestart: false`. Every stalled table belonged to one tournament,
`87a68e55-2c91-43e6-a803-4a9a2b9505b0` ("$100 Freeroll - 6:00 AM", 44 tables), whose
manager sat in `/health.quarantinedTournamentManagers` with `reason:
"GameServer.quarantined_tournament_manager_stop_retry"` and `custodyRefusal:
"mixed:originals_not_drained:engine_stops_not_all_fulfilled"`, 80 attempts, 81
minutes old.

Engine logs traced the mechanism exactly. A cluster of tournament leases was lost at
12:19-12:20 UTC (heartbeats did not land inside their proof window - a smaller repeat
of the 2026-09-26 storm this repo already hardened once). 87a68e55's manager then
failed `TournamentManagerBase`'s `stop()` on "retained time-bank custody" for 32 of
its table engines; 31 cleared on retry as their in-flight writes settled
(`AggregateError: ... failed to stop 32/19/8/1/1/1/1 table engine(s)` across
successive attempts). One, `9333d016-f241-4f31-95ad-b3f062055f22`, did not, and had
not cleared in 80 retries:

    Error: Tournament table 9333d016-... retained time-bank custody

because `fn_consume_time_bank`'s RPC for that table returned `Error:
supabase_timeout` - an ordinary transient DB hiccup. `onTimeBankAccounting` /
`consumeTimeBankSeconds` in `server/src/engine/ServerTableEngineBase.ts` treated any
non-success answer as permanent: `this.timeBankAccountingUnconfirmed = true`, and
nothing anywhere ever set it back to `false`. That single flag makes
`hasUnretiredStoppedTimeBankCustody()` refuse for the life of the process, which
holds the manager's `stop()` in permanent quarantine, which holds all 43 sibling
tables of the same tournament stalled (`ServerTableEngine.stop()` memoizes
`teardownPromise`, so those 43 kept re-resolving instantly on every retry, but the
MANAGER never completed its own teardown to let a successor adopt them), and which
holds every hourly maintenance certificate shut
(`unparkedReasons.stopped_bank_custody_unreadable`) - correctly, per the binding law
in `tests/a-stopped-bank-that-can-never-be-released-does-not-hold-the-restart-shut.law.test.ts`,
which refuses that reason from every serving release with no bound and no exception.

The disproportion is the bug. `fn_consume_time_bank` decrements
`feature_purchases.uses_remaining` and `vip_feature_usage_monthly.usage_count` -
real but small-stakes resources - with no idempotency key, so the original caution
("An unacknowledged non-idempotent debit must not be retried or certified") was
correct for the deduction. But the CUSTODY this flag gates
(`stoppedTimeBankCustody.banks`, captured by `captureParkedTimeBanks()` from this
process's own in-memory `timeBankEngine` state) never depended on this RPC's
outcome at all - `meta.dbConsumedSeconds` is bumped synchronously before the RPC is
even sent. So one ambiguous BEST-EFFORT ledger write - the function's own comment:
"accounting must never break gameplay" / "Gameplay never waits for this call" - was
escalated into a table that could never retire, a tournament permanently
quarantined, and a production release gate refusing every cutover.

## What changed

**1. `fn_consume_time_bank` gets the idempotency key it was missing**
(`supabase/migrations/20260928144831_time_bank_consume_is_idempotent_by_request_id.sql`),
the same pattern this repo already uses for `fn_rabbit_hunt_purchase`
(`digital_purchase_receipts`, `p_request_id`, in the same source migration two
hundred lines above this function). An optional `p_request_id uuid`, and a new
`time_bank_consume_receipts` table keyed on it: a call carrying a request_id that
already has a receipt returns that receipt's own stored result WITHOUT touching a
balance a second time, checked once before the advisory lock and once more under
it. `p_request_id` omitted behaves exactly as the preimage, byte for byte. Verified
in a rolled-back transaction against production (CLAUDE.md 11.5 rule 1): a fresh
request_id decremented a scratch `feature_purchases` row by the expected uses; the
SAME request_id replayed returned the identical result and left `uses_remaining`
unchanged; a call with `p_request_id` omitted decremented again, matching the
preimage. Both branches (lifetime-VIP and ordinary) write their own receipt in the
same transaction as their own deduction.

**2. The engine resolves an ambiguous answer before it believes it forever.**
`consumeTimeBankSecondsResolved` (replacing the duplicated logic previously split
across `onTimeBankAccounting` and `consumeTimeBankSeconds`) generates one
`request_id` per consumption event and, on an ambiguous first answer (error,
throw, or `data.success !== true`), asks again ONCE with the SAME request_id -
safe now that a replay can never double-deduct - before setting
`timeBankAccountingUnconfirmed`. Only when the resolving retry is ALSO ambiguous
does the prior, permanent, fail-closed behavior still apply: this does not loosen
`hasUnretiredStoppedTimeBankCustody()` or the maintenance certificate's refusal of
a genuinely unresolved custody, both of which remain correct. "I could not tell"
is answered by asking again, not by refusing forever (CLAUDE.md 10.86).

## What this does not fix

The RUNNING production engine (763e4cec, no release since 06:55Z) already has
`9333d016`'s `timeBankAccountingUnconfirmed` latched `true` in this process's
memory from the OLD code; this fix prevents the NEXT occurrence and does not
retroactively clear an in-memory flag in an already-running process without a
restart. Today's occurrence needs either the sanctioned recovery-window path to
carry a build with this fix once the gate can admit one, or a decision by whoever
holds engine-restart authority; this agent has read-only access to the engine host
and does not restart it. See the coordinator's incident record for the current
state of that decision.

## Tests

`server/src/engine/aTimeBankAmbiguityIsResolvedBeforeItTaintsCustody.law.test.ts`
(new law, `docs/laws.d/server-src-engine-aTimeBankAmbiguityIsResolvedBeforeItTaintsCustody.md`):
the exact production shape (`supabase_timeout` once, success on retry) resolves
without tainting; a `data.success !== true` answer resolves the same way; a
genuinely persistent failure still taints after exactly one retry (not a loop);
every call carries a request_id. Updated `TimeBankVip.test.ts` and
`ParkedTimeBank.test.ts` assertions on the RPC call shape to allow the new
`p_request_id` field (`expect.objectContaining`) and to return realistic
`{success: true}` payloads where the old fixtures returned `data: null` (which
would now, correctly, trigger the one resolving retry).
