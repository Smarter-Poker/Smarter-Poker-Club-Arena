# Fleet evidence attributes original-turn controller actions and effects

The fleet observer now reports whether each reconciled controller action matched its original selection or was coerced. Accepted actions remain distinct from strategy optimality and qualification.

Effect evidence is attributed to the exact original producer and turn, using the maintained effect-batch and durable-receipt validators. A receipt for one horse cannot credit another horse in the same hand. Qualified empty effects are explicitly not applicable; missing, conflicting or mismatched evidence stays unknown; failed application remains failed. Legacy hand-level Phase15 reports are unchanged.

The sanitized canonical-index ledger validates and retains these counts. Older engine output without the new evidence remains unknown. Global correctness, restart restoration, profitability and whole-phase completion are not inferred from counters. The installed observer CLI must contain this change before it can produce the new evidence.
