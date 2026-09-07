# Tournament payment receipt validation

The original settlement parser accepted an infinite paid amount with ok=true and could certify a cumulative payment greater than the recorded obligation as fully settled. Validated money fields now remain finite nonnegative exact cents; contradictory success receipts return invalid_response and never certify completion. Numeric decimal strings remain supported. Legacy receipts with valid moved amounts remain accepted without claiming full settlement.

An invalid receipt may follow a committed credit. It is reported as an invalid response without the ordinary nonpayment alert and without a new retry in this call. Existing idempotent settlement and payment amounts are unchanged. No balance adjustment or historical payment is performed.

Executed the actual original parser to reproduce both defects. Executed the changed parser with mocked RPC/reporting boundaries against malformed moved amounts, contradictory/overpaid totals, partial/final/replay and decimal receipts, legacy responses and escrow refusals. Added Vitest behavior coverage. Input amount/place normalization and full production integration remain separate audit work.

CI follow-up: the first server run passed 6,479 tests but two older success fixtures omitted the database's already_paid field. Updated those fixtures to include zero prior credit without changing their assertions, and added explicit missing/null prior-credit rejection cases. Client tests and TypeScript passed that run. Full CI for this follow-up is a separate gate.
