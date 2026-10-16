# One-time retirement of legacy test learning data

The owner explicitly authorized a one-time legacy test-learning purge on October 15, 2026: “Allow a one-time legacy test-learning purge.” Human hand histories and financial records remain protected.

Older adaptive observations can predate disposal certificates and the completed-settlement fields on immutable disposal receipts. Their absence is not evidence that a hand was settled or horse-only. This exception must therefore have its own explicit learning-data record; it must never fabricate a normal settlement or horse-disposal certificate.

The fixed cohort ends October 4, 2026 at 23:59:59.999 UTC. The bounded private operator transition removes only eligible legacy learning observations and their saved batch copies, retaining every neighboring tuple and the original replay digest. A hand with surviving history, an atomic commit, an existing normal disposal certificate, newer observations, known human evidence, original reported/disputed evidence, unresolved work or a relevant protected hold remains excluded. No history, financial receipt, accounting ledger, normal certificate or retained statistics row is erased by this exception.

The exception record also fences the original append, enqueue, raw-insert and recovery paths so a later replay cannot recreate the discarded learning data. The ordinary retention policy remains eight days for settled horse-only raw hands, with human/mixed histories retained forever. There is no new schedule or repair loop.

Focused native PostgreSQL 17.11 qualification passed 41 checks on the final SQL candidate. It proved the original owner retains uncertified legacy data before the exception, then verified bounded erasure, preserved neighboring tuple bytes and original digests, unchanged human/financial/normal-certificate/statistics/fence records, reported-hand protection, original boolean/text human-marker protection, rollback, duplicate requests, replay blocking, private permissions, immutable ledger, maintenance refusal and real two-session capacity contention. The existing required retention harness directly invokes this regression qualification.

Verified: source and connected replay paths re-read. TypeScript: not applicable to this SQL/Python-only change. Protected delivery, installation and the finite foreground purge remain separate acceptance steps recorded in the task checkpoint; source qualification does not claim production cleanup or disk recovery.
