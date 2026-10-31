# Registration approvals include the complete eligible field

The approvals panel read one database response, and its membership provider requested 5,000 rows from an API that returns at most 1,000. Later approvals and eligible members were silently omitted. A failed later page could not be reported because it was never requested.

Both reads now advance by the unique user ID within their event or club and publish only a complete result. Member names are fetched in bounded batches. Display ordering stays newest first. An incomplete read displays an unavailable state with an explicit retry and no misleading approval actions. Existing RLS and write authorities are unchanged; the shared member reader's other callers already handle rejected reads.

Four actual rendered/service regressions fail before the repair. Five focused cases include complete 1,001-row results, second-page failures, names beyond the first page and explicit retry. The connected suite passes 111 tests. Live primary keys confirm the composite club/event plus user cursor is unique. Root TypeScript and ordinary push checks are recorded in the task checkpoint; publication and live proof remain required.

Real-time law: existing explicit registration approval actions trigger the read; no polling or snapshot diff added.
