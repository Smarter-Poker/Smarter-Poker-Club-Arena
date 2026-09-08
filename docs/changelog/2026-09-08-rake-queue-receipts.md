# Rake Queue Completion Requires Confirmed Receipts

The queue reader treated an error-free atomic_distribute_rake call as a banked fee. The live function can return applied=false and already_processed=false without an RPC error, so that branch could close a claim without evidence of banking. It now requires one receipt, explicit mutually exclusive applied/already_processed booleans, and a nonempty rake record identity. Empty, ambiguous and contradictory receipts keep the claim pending.

The same reader counted a row as resolved even when its bookkeeping update failed. It now requests an exact affected-row count and reports resolution only after one row is acknowledged. Failed, missing or ambiguous acknowledgements count as still failing. The confirmed payment outcome remains separate; late jackpot events still reflect that payment rather than the bookkeeping result.

Verification: eight receipt cases and four failed-write acknowledgement cases failed before their corrections. Afterward, server TypeScript and all 6,936 tests across 486 server files passed. Successful first payments and already-processed rake receipts remain accepted. Tests use mocked database boundaries; no production money or queue row was changed.

Read-only live definition verification established the actual table-shaped RPC response and its explicit no-op branch. This is a source contract correction, not proof that every historical fee was banked, and it requires separate engine rollout verification.
