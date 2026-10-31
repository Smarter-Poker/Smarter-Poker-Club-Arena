# Free Diamond Cancellation Disposition

Canceling an unstarted Diamond freeroll released every zero-balance custody row, then counted those free results as paid refund lines. The exact receipt verifier refused the null ledger evidence and rolled back the event. Three overnight freerolls exposed this failure during rollback qualification.

Classify the original refund result in the cancellation authority: a verified fully settled free entry, paid at zero with no ledger, obligation or journal, belongs in the zero-disposition roster. Paid results retain their original flow. Unknown or inconsistent free results refuse atomically. Preserve authorization, original settlement locks, all paid refund rails and immutable receipt validation.

The existing PostgreSQL cancellation qualification now installs this exact source patch and executes the installed result-classification block for free, paid, nonzero, missing-total, unsettled and unexpected-ledger results. Its existing real funded cancellation, rollback, duplicate replay, immutability and concurrency cases remain required. The private setup SQL is passed as a file to avoid the observed local stdin transport stall.

The one-time overnight cleanup used the existing zero-value custody release authority and exact atomic cancellation receipt, after rollback qualification. This source change removes the need for that separate release on future cancellations. No engine replacement or recurring repair is introduced.
