# Reprice Access And Release Checks

The applied cash entry-close replacement already required service-only execution before and after replacement. The static release gate could not infer that live ACL, so a forward migration explicitly revokes PUBLIC, anon and authenticated execution and retains service_role. It pins the current body and security settings; the previously applied migration remains byte-identical. No function body or wallet data changes.

Applied as 20260910071131, read back at 07:12:25 UTC with unchanged body and service-only ACL. Independent review passed. The native PostgreSQL 17 probe passes 24 groups, including actual browser denial, service execution, idempotent ACL declaration and changed-body refusal.

Two source assertions now require the reserved place pool and the remaining Spin first-deal hold, matching the existing behavioral fixes. All 91 selected source/gate assertions pass. The failed push is still recorded as failed until a normal push and CI complete. Phase 3 and the wider audit remain in progress.
