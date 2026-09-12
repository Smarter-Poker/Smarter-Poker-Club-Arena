# Check the engine prerequisite before opening production browser fixtures

A frontend publish can finish while the required engine is still waiting for its maintenance release. Production E2E previously spent the full browser budget and created an isolated account before its live-table tests reported the already-known engine mismatch. The workflow now checks the exact required engine SHA, running state and liveness before installing browsers or creating the account.

The preceding read-only schema and foreign-key audits still run. An unreadable, unhealthy or mismatched engine fails this certificate attempt; it does not wait on or alter production. Existing in-suite identity checks, cleanup, final frontend provenance and the engine publisher's later certificate trigger remain intact. No release or accounting test is skipped to produce a successful certificate.
