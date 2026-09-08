# A partial late-reg top-up cannot display the full prize

The original repricing result branch wrote correctPrize whenever settlement returned ok. A successful partial credit therefore looked like the entire corrected prize had been paid.

Require the authoritative fully_settled receipt and an amount_paid covering the corrected prize before writing the prize stamp. Preserve the prior stamp for incomplete or unknown outcomes and report that state without asserting zero payment. The record-write error reports the confirmed cumulative payment, not the requested difference as money moved.

An executable test extracts the actual result branch using the TypeScript AST. Three of six cases failed on the original code; all six pass after correction, including partial, legacy, refused, insufficient-total and complete receipts. Server TypeScript and all 6,527 server tests across 461 files pass. This changes no entitlement or wallet amount and adds no recovery mechanism. Runtime release and other payment consumers remain separate gates.
