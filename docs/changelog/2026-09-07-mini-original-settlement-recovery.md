# Mini Jackpot Original Settlement Recovery

Mini transport/read/RPC failures were returned as skipped and discarded after the hand advanced. Mini now uses the existing Main jackpot write-ahead operation and retry process. The stored kind, tier and metadata survive reconstruction by the existing FeeReconciler. No new queue, cron or payout sweep is added. Only explicit Mini rule refusals close the operation; missing RPC results and database failures remain pending. The caller emits the existing pending event with kind Mini. Duplicate dealt-in IDs no longer duplicate in-memory share increments for either jackpot.

The pre-RPC empty Main-bank shortcut was removed: the database must be allowed to return an existing payout or decide eligibility while locked. This is also necessary for Mini, whose funding is Backup.

Validation: executed the actual service module after Node TypeScript transformation with mocked external dependencies. Passed claim-before-RPC ordering, transient retry, Mini-only RPC arguments, exhausted failures remaining open, final reserve-floor refusal, empty-bank replay and missing-result failure. Added Vitest service and FeeReconciler reconstruction cases for CI. Full typecheck, engine suites and live restart/browser behavior remain to be confirmed by the repository gates/deployment. Database corrections are recorded separately in migration 20260907203446.

Still open: if both the database and persistent claim write fail, the existing claim interface cannot prove durability; original operation recording needs a stronger acknowledgement. Pending recipient delivery and notification truth require further completion work. This change must not be read as full recovery certification.

September 8 integration: current main conflicted only in the shared source-retention test file. Kept all current-main assertions and the Mini durable-operation assertion. The three changed Mini/payment recovery suites and server TypeScript were rerun before push; full server verification is recorded in the resumed audit.
