# Tournament callbacks retain their original request authority

Today's stalled tournament hand completions and break discovery requests were refused with F06_PROTOCOL2_REQUIRED. The installed database hook correctly accepted a controlled read under the exact current manager lease and refused ordinary service work. Child permit objects and stored dealer callbacks outlived the async scope that created them.

Bind each permit transport and stored hand allocation/admission callback to its immutable tournament and lease. Materialize table-break RPC requests within that same authority, including continuation and withdrawal paths. Preserve original lifecycle checks, current-owner checks, database fencing, accepted-hand evidence, unknown outcomes and no-replay behavior. No database authorization, financial rules or horse-history reads change.

Regression reproduces lost manager headers before the fix and verifies process callbacks, concurrent manager isolation, wrong-manager refusal, retired lifecycle refusal, lazy request materialization and unchanged database refusals. The existing actual-admission-body test now injects the real authority binder and verifies callback request headers. Local validation and protected delivery/live results are recorded separately in the incident checkpoint; source alone does not certify recovery.
