# Cashier Tests Finish Their Original Recovery Work

Hosted client shard 1 exposed a load-order fixture race: the preceding legacy
recovery's asynchronous hash/reservation finished after the next test cleared
the RPC history and server model. The quota test then compared its new batch
against that preceding reservation. The other 10,697 tests in the shard passed.

The fixture now tracks the real delegated recovery promises, unmounts the UI,
and waits for that original work before resetting mocks. A deferred real digest
keeps legacy restoration pending through teardown, and a fixture invariant
refuses to begin the next case with outstanding recovery work. No sleeps,
retries, production changes or financial assertions are removed.

The controlled pre-fix teardown fails the pending-work invariant; corrected
teardown passes all 11 cashier load-order cases. Batch and per-recipient
operation IDs must still match their reserved recovery envelope exactly.
