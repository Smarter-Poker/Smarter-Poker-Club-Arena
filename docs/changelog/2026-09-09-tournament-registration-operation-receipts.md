# Tournament Registration Operation Receipts

Before: the initial wallet registration RPC had no request identity. The browser used a current roster lookup after an ambiguous error, which cannot prove the original registration lifecycle. The existing database core already locks the tournament and books entry funding atomically.

Change: add a mandatory-request RPC using the existing immutable entry-purchase receipt protocol, current authenticated session, exact caller/event payload binding and the canonical core in one transaction. The client will retain and replay that original request through the existing durable intent mechanism. Ticket admission remains on its immutable-ticket authority.

Status: implementation and verification in progress; not applied, published or accepted. Legacy entrypoint retirement requires compatible-client adoption and remains separate.

## Verification Checkpoint

Seven new client regressions failed before correction. After correction, 115 focused tests in three files and TypeScript passed. The related caller suite passed 156 cases with one old RPC-name assertion failing; that assertion now names the durable RPC and its three-case file passed. The existing complete isolated PostgreSQL harness exited zero, including ten new wrapper assertions, actual immutable receipt helpers, rollback and exact replay. Its underlying registration funding core is a test double, so this is not full tournament-funding acceptance.

The additive function was applied as live version 20260909211745. Read-only catalog verification confirmed body MD5 c80d08529c03284adc51c6cb03764a55 and authenticated-only execution. It is registered as an audited wrapper separately. The first local build compiled but its provenance gate found one newer main commit; a normal integration and final build remain required. Publication and legacy registration retirement remain pending.
