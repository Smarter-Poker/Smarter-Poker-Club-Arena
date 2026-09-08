# Promo Payments Keep One Identity Across Retries

WalletService.disbursePromo generated p_op_id inside the retry callback. A payment that committed before its response was lost could therefore be submitted again under a new identity. The ID is now generated once per deliberate payment and reused for every network retry.

The client also requires an explicit success receipt before announcing a paid disbursement. Null and malformed responses no longer emit a balance-update event.

Verification: a behavioral test uses the actual retry helper and simulates a committed payment whose first response is lost. The retry uses identical parameters and the simulated server pays once. Separate deliberate payments use different IDs; null, incomplete and refused responses fail without announcing success. Five new tests plus eight existing wallet-balance tests pass. A TypeScript AST scan of retry callbacks across src and server/src found no other direct randomUUID, uuidv4 or newIdempotencyKey generation inside those callbacks. That scan does not prove every manual retry loop or called helper is safe.

This client fix does not claim the remaining wallet, engine or historical-incident audit is complete.
