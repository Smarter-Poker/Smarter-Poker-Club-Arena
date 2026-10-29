# Horse executor exception custody

Classic and Lightning horse executors now finalize returned execution witnesses when a synchronous executor failure occurs after cancellation custody has been detached. Finalization preserves the controller acceptance receipt even if later effect bookkeeping throws; the original error still propagates and the action is not retried.

Lightning fast-fold success can transfer ownership to a queued preaction. Its original accepted/abandoned callbacks retain custody after successful transfer, including a later dispatch unwind failure.

Regression coverage exercises Classic and Lightning ordinary dispatch failures, effect bookkeeping failures after controller acceptance, early-fold failure before transfer, successful queued transfer, and accepted on-turn fast-fold dispatch unwind. The two maintained acceptance suites pass 239 tests. These isolated custody results do not identify the allocator responsible for a production memory exhaustion incident.
