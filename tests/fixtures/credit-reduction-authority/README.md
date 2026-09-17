# Credit reduction authority qualification source

Status: **SOURCE ONLY / UNRUN**. These files are prepared for the existing protected full-accounting qualification runner. They do not authorize a database connection, establish native acceptance, or prove publication, financial reconciliation, or device delivery. The current owner execution policy and explicit admission hold still apply.

The finite contract is an authenticated, club-scoped credit reduction through the existing `fn_admin_update_agent` writer, with an immutable original operation, exact revision/amount intent, explicit retirement of an unknown operation, and a private nonpayable credit-change document. An exception is never a retirement receipt. A recorded retry must preserve later limits and original evidence. No financial function is replaced by these tests.

## Actual baseline and order

Use the original captured full-accounting schema, policies, access, registry and already reviewed supplements; the complete first 36 component bytes remain unchanged. The qualification builder produces `qualification-credit-baseline.sql` from the exact original schema plus `baseline-ordinal-transform.json`. That fixture-only transformation reserves and immediately drops one placeholder at agents ordinal 27, before defaults, constraints or triggers. It reconstructs the captured live wallet-column ordinals 28–31 and constraint keys; it does not claim the removed production column's name, type or storage history. The original schema is never edited, and the generated baseline is not an activation artifact.

After the earlier baseline supplements and before the candidate, load these files in order:

1. `captured-dependencies.sql`: ten exact retained missing function definitions, owners and effective grants from the credit/delegate captures. Unknown preexisting objects refuse.
2. `captured-ledger-dependency.sql`: the exact captured `fn_ca_post_leg` definition and service-only access, required by the real send/payment paths. Its original source is retained in `captured-payment-closure.json` and `.query.sql`.
3. `catalog-bootstrap.sql`: three captured agents secondary indexes, with full original column/constraint/index preimage and final readback. No unknown objects are adopted or dropped.
4. The original real pg_cron prerequisites, with the launcher disabled, then the complete atomic 37-component candidate.

All qualification phases require a fresh PG17 cluster, database `postgres`, local Unix socket, postgres fixture owner and origin replication mode. The three supplements enforce bounded lock/statement deadlines. The source builder and runner must bind all new files and the exact current component composition before protected execution.

## Rollback-only acceptance fixture

The runner loads `regression.sql` after full candidate acceptance. Its main transaction loads temporary assertion helpers and synthetic identities/starting balances, then uses actual authenticated APIs and origin triggers. The only replica work is clearly marked starting-state or revision-boundary fixture setup.

- The owner, active admin and approved co-owner reduce the exact agent in the requested club. Another club's same user is unchanged. Exact text cents, the numeric(15,2) boundary, a one-cent reduction, the permitted maximum request and applied-versus-requested clamping are checked independently.
- Canonical prepaid zero/zero records one no-change operation and no assignment or document. An old zero-limit/nonprepaid pair is refused without repair. Debt, funding and child authority remain the existing writer's decisions.
- Exact retries after a later absolute limit change return the original receipt without resetting the later row. Every original intent field, NULL versus empty reason, malformed/nonfinite/subcent values, absent lookup, explicit retirement, late apply and completed-operation retirement are covered.
- Actual A→B→A absolute writes advance the revision and invalidate the old intent. Direct revision reset and maximum-bigint overflow refuse without wrap. Private table/column/function rights and immutable evidence are checked using actual API roles.
- Original assignments, document provenance, generated nonpayable invoices, both intended immediate deliveries, canonical page/search/thread projections, and private audience restrictions are checked. Historical own receipts/documents survive later demotion and actual agent/assignment removal.
- Scoped temporary triggers suppress or corrupt assignment, operation, provenance, invoice, message, notification and deferred push writes. A notification `link`-only redirection is included. Every expected failure compares complete sorted rows from all ordinary public, smarter_private and auth base tables. Sequence allocation, temporary tables and catalog state are outside that row snapshot; scoped fault triggers are dropped and the outer transaction rolls back.
- A positive operation sets only `zz_accounting_credit_change_deferred_v1` IMMEDIATE while the inherited push constraint remains deferred. `ALL IMMEDIATE` is used only to flush already constructed deliveries or force a deliberate late failure; it is not an alternative construction contract.

After the main rollback, `isolation-regression.sql` opens separate REPEATABLE READ and SERIALIZABLE transactions. Each uses actual authenticated snapshot/apply/lookup/retire calls, requires exact SQLSTATE 25000 / `credit_reduction_read_committed_required`, and compares the complete book after every refusal. Each transaction rolls back. This tests the explicit READ COMMITTED admission boundary, not an unsupported higher-isolation execution path.

## Separate-session fixture

The new `credit-reduction-concurrency` runner phase uses its own fresh cluster. After the candidate, load `concurrency-setup.sql` once. It reuses the unchanged captured store-policy supplement with its empty-table/local-owner guard, then creates synthetic starting identities and a revoked marker pinned to database OID, original run UUID and postmaster start time. This policy is not reloaded by the main acceptance fixture.

The protected harness interface is exactly:

`concurrency-regression.py <absolute admitted PG17 psql> <absolute isolated Unix socket> <port> postgres`

It requires four arguments, has no provider/install fallback, uses no credentials, and accepts only its finite fixture actors/queries. Connections use statement/lock deadlines; result barriers, blocking observations and process cleanup are bounded. Nonzero commands and timeouts retain stdout, stderr, partial bytes and the failing statement; no retry can convert a refusal to success.

The authored 16 orderings comprise same-intent replay, conflicting intent, actual absolute-write ABA, both apply/retire orders, eight early-lock probes across seven entrypoints (including nested send insertion), two real credit-invoice payment/debt orders, and one manager-authority order. Early-lock probes invoke the real role setter, reassignment, ensure-agent, all three wallet-send layers, and public cashier approval. The cashier case starts from a real canonical hold and checks the original hold/event/invoice links plus the actual credited owner wallet. The lock oracle observes the exact blocking backend and proves the first transaction can still take the relevant club/member/agent rows before releasing the existing agreement mutex.

The authority case uses a real existing credit-invoice replay to hold the target row, then starts admin reduction and a direct membership disable. It requires membership SHARE to block that later disable until the original decision commits. A new operation after committed disable refuses, while the historical own receipt remains readable. It does not claim all direct-member-first schedules are wait-free: retained unrelated triggers can cause a safe deadlock refusal and rollback in another ordering. Actual source execution must establish the observed outcome.

`accepted-authority-supplement.sql` records the final private tables, revision, trigger/index/policy graph, API/private effective rights and exact functions, including the seventh cashier transition and invoice immutability. `capture-final-state.sql` retains bounded committed rows and explicit total/shown/truncated counts, including the invoice→delivery→conversation/message→notification→push chain. The common runner invokes final capture on success and failure before stopping the cluster. Failed capture, stop or archival retains the fixture for protected recovery.

## Remaining acceptance requirements

No SQL compilation, native execution, two-session schedule, provider/extension qualification, before/after reproduction, application test, browser display, device receipt, deployment or live verification has run for these files. Required execution includes the actual nested baseline/supplement/candidate composition and all 16 runner phases, not isolated helper mocks. Source hashes and fixture presence establish custody only. The frozen monetary formulas and the original 36 components remain separate from the new intent/revision/document authority.
