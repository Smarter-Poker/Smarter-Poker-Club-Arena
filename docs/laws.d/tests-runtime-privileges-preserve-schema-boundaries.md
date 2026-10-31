# tests/runtime-privileges-preserve-schema-boundaries.law.test.ts

Only authoritative GRANT/REVOKE tags exempt non-reloading privilege churn; public DDL boundaries and actual private reserve ACLs remain enforced.
